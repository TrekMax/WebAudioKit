import {
  assertSampleRange,
  assertSampleRate,
  type SampleIndex,
  type SampleRange,
} from './types'

export type WavSampleFormat = 'pcm16' | 'pcm24' | 'float32'

export interface PlanarPcmData {
  readonly sampleRate: number
  readonly channels: readonly Float32Array[]
}

export type WavSource = AudioBuffer | PlanarPcmData

export interface WavEncodeOptions {
  readonly format?: WavSampleFormat
  readonly range?: SampleRange
  readonly normalize?: boolean
  /** Target peak in dBFS when normalization is enabled. Defaults to -1 dBFS. */
  readonly targetPeakDbfs?: number
}

export interface WavEncodingInfo {
  readonly format: WavSampleFormat
  readonly sampleRate: number
  readonly numberOfChannels: number
  readonly frameCount: SampleIndex
  readonly dataBytes: number
  readonly totalBytes: number
  readonly peak: number
  readonly gain: number
}

const WAV_HEADER_BYTES = 44
const MAX_UINT16 = 0xffff
const MAX_UINT32 = 0xffffffff
const MAX_RIFF_DATA_BYTES = MAX_UINT32 - 36
const DEFAULT_TARGET_PEAK_DBFS = -1

interface PcmView {
  readonly sampleRate: number
  readonly channels: readonly Float32Array[]
  readonly length: SampleIndex
}

interface EncodingPlan extends WavEncodingInfo {
  readonly range: SampleRange
  readonly bytesPerSample: number
  readonly formatTag: 1 | 3
}

/**
 * Encodes planar Float32 PCM into a canonical 44-byte RIFF/WAVE file.
 * This synchronous pure function is suitable for invoking inside an export
 * Worker; it never mutates or copies the source channel arrays.
 */
export function encodeWav(source: WavSource, options: WavEncodeOptions = {}): ArrayBuffer {
  const pcm = resolvePcmView(source)
  const plan = createEncodingPlan(pcm, options)
  const output = new ArrayBuffer(plan.totalBytes)
  const view = new DataView(output)

  writeWavHeader(view, plan)
  writeInterleavedSamples(view, WAV_HEADER_BYTES, pcm, plan)
  return output
}

export function getWavEncodingInfo(
  source: WavSource,
  options: WavEncodeOptions = {},
): WavEncodingInfo {
  const pcm = resolvePcmView(source)
  const plan = createEncodingPlan(pcm, options)
  return {
    format: plan.format,
    sampleRate: plan.sampleRate,
    numberOfChannels: plan.numberOfChannels,
    frameCount: plan.frameCount,
    dataBytes: plan.dataBytes,
    totalBytes: plan.totalBytes,
    peak: plan.peak,
    gain: plan.gain,
  }
}

export function findPeak(source: WavSource, range?: SampleRange): number {
  const pcm = resolvePcmView(source)
  const selectedRange = range ?? { start: 0, end: pcm.length }
  assertSampleRange(selectedRange, pcm.length, { allowEmpty: true })
  return findPcmPeak(pcm.channels, selectedRange)
}

export function calculatePeakNormalizationGain(peak: number, targetPeakDbfs = 0): number {
  if (!Number.isFinite(peak) || peak < 0) {
    throw new RangeError('Peak must be a non-negative finite number')
  }
  if (!Number.isFinite(targetPeakDbfs) || targetPeakDbfs > 0) {
    throw new RangeError('Normalization target must be a finite dBFS value no greater than 0')
  }
  if (peak === 0) {
    return 1
  }
  return 10 ** (targetPeakDbfs / 20) / peak
}

function createEncodingPlan(pcm: PcmView, options: WavEncodeOptions): EncodingPlan {
  const format = options.format ?? 'pcm16'
  const formatInfo = getFormatInfo(format)
  const range = options.range ?? { start: 0, end: pcm.length }
  assertSampleRange(range, pcm.length, { allowEmpty: true })

  const targetPeakDbfs = options.targetPeakDbfs ?? DEFAULT_TARGET_PEAK_DBFS
  if (options.normalize && (!Number.isFinite(targetPeakDbfs) || targetPeakDbfs > 0)) {
    throw new RangeError('Normalization target must be a finite dBFS value no greater than 0')
  }

  const numberOfChannels = pcm.channels.length
  const blockAlign = numberOfChannels * formatInfo.bytesPerSample
  if (blockAlign > MAX_UINT16) {
    throw new RangeError('WAV block alignment exceeds the RIFF/WAVE limit')
  }

  const byteRate = pcm.sampleRate * blockAlign
  if (!Number.isSafeInteger(byteRate) || byteRate > MAX_UINT32) {
    throw new RangeError('WAV byte rate exceeds the RIFF/WAVE limit')
  }

  const frameCount = range.end - range.start
  const dataBytesBigInt = BigInt(frameCount) * BigInt(blockAlign)
  if (dataBytesBigInt > BigInt(MAX_RIFF_DATA_BYTES)) {
    throw new RangeError('WAV data exceeds the 4 GiB RIFF limit; RF64 is not supported')
  }

  const dataBytes = Number(dataBytesBigInt)
  const peak = options.normalize ? findPcmPeak(pcm.channels, range) : 0
  const gain = options.normalize
    ? calculatePeakNormalizationGain(peak, targetPeakDbfs)
    : 1

  return {
    format,
    sampleRate: pcm.sampleRate,
    numberOfChannels,
    frameCount,
    dataBytes,
    totalBytes: WAV_HEADER_BYTES + dataBytes,
    peak,
    gain,
    range,
    bytesPerSample: formatInfo.bytesPerSample,
    formatTag: formatInfo.formatTag,
  }
}

function writeWavHeader(view: DataView, plan: EncodingPlan): void {
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + plan.dataBytes, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, plan.formatTag, true)
  view.setUint16(22, plan.numberOfChannels, true)
  view.setUint32(24, plan.sampleRate, true)
  view.setUint32(28, plan.sampleRate * plan.numberOfChannels * plan.bytesPerSample, true)
  view.setUint16(32, plan.numberOfChannels * plan.bytesPerSample, true)
  view.setUint16(34, plan.bytesPerSample * 8, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, plan.dataBytes, true)
}

function writeInterleavedSamples(
  view: DataView,
  byteOffset: number,
  pcm: PcmView,
  plan: EncodingPlan,
): void {
  let offset = byteOffset
  for (let frame = plan.range.start; frame < plan.range.end; frame += 1) {
    for (const channel of pcm.channels) {
      const sourceSample = channel[frame]
      const finiteSample = sourceSample !== undefined && Number.isFinite(sourceSample) ? sourceSample : 0
      const sample = finiteSample * plan.gain

      switch (plan.format) {
        case 'pcm16':
          view.setInt16(offset, floatToSignedInteger(sample, 16), true)
          break
        case 'pcm24':
          writePcm24(view, offset, floatToSignedInteger(sample, 24))
          break
        case 'float32':
          view.setFloat32(offset, sample, true)
          break
      }
      offset += plan.bytesPerSample
    }
  }
}

function floatToSignedInteger(value: number, bits: 16 | 24): number {
  const sample = Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0))
  const negativeScale = bits === 16 ? 0x8000 : 0x800000
  const positiveScale = negativeScale - 1
  return Math.round(sample * (sample < 0 ? negativeScale : positiveScale))
}

function writePcm24(view: DataView, offset: number, value: number): void {
  const twosComplement = value < 0 ? value + 0x1000000 : value
  view.setUint8(offset, twosComplement & 0xff)
  view.setUint8(offset + 1, (twosComplement >>> 8) & 0xff)
  view.setUint8(offset + 2, (twosComplement >>> 16) & 0xff)
}

function findPcmPeak(channels: readonly Float32Array[], range: SampleRange): number {
  let peak = 0
  for (const channel of channels) {
    for (let frame = range.start; frame < range.end; frame += 1) {
      const value = channel[frame]
      if (value !== undefined && Number.isFinite(value)) {
        peak = Math.max(peak, Math.abs(value))
      }
    }
  }
  return peak
}

function resolvePcmView(source: WavSource): PcmView {
  const sampleRate = source.sampleRate
  assertSampleRate(sampleRate)

  let channels: readonly Float32Array[]
  let length: SampleIndex
  if ('channels' in source) {
    channels = source.channels
    length = channels[0]?.length ?? 0
  } else {
    length = source.length
    channels = Array.from({ length: source.numberOfChannels }, (_, channel) =>
      source.getChannelData(channel),
    )
  }

  if (channels.length === 0 || channels.length > MAX_UINT16) {
    throw new RangeError('WAV source must contain between 1 and 65535 channels')
  }
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError('PCM length must be a non-negative safe integer')
  }
  for (const channel of channels) {
    if (!(channel instanceof Float32Array)) {
      throw new TypeError('WAV source channels must be Float32Array instances')
    }
    if (channel.length !== length) {
      throw new RangeError('All WAV source channels must have the same frame count')
    }
  }

  return { sampleRate, channels, length }
}

function getFormatInfo(format: WavSampleFormat): {
  bytesPerSample: 2 | 3 | 4
  formatTag: 1 | 3
} {
  switch (format) {
    case 'pcm16':
      return { bytesPerSample: 2, formatTag: 1 }
    case 'pcm24':
      return { bytesPerSample: 3, formatTag: 1 }
    case 'float32':
      return { bytesPerSample: 4, formatTag: 3 }
    default:
      throw new RangeError(`Unsupported WAV sample format: ${String(format)}`)
  }
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index))
  }
}
