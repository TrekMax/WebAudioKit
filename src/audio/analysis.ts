import {
  assertValidFftSize,
  fftRadix2InPlace,
  type ComplexSpectrum,
} from './fft'
import {
  calculateCoherentGain,
  createWindow,
  WINDOW_FUNCTION_NAMES,
  type WindowFunctionName,
} from './windows'

export const ANALYSIS_ALGORITHM_VERSION = 1
export const DBFS_AMPLITUDE_FLOOR = 1e-12
export const DEFAULT_STFT_PREVIEW_FRAME_LIMIT = 256

export const DEFAULT_ANALYSIS_PARAMETERS = {
  fftSize: 2048,
  hopSize: 512,
  window: 'hann',
  channelMode: { kind: 'mix' },
  minDb: -100,
  maxDb: 0,
} as const satisfies Omit<Required<AnalysisOptions>, 'sampleRate' | 'range' | 'firstFrame' | 'frameCount'>

export interface SampleRange {
  readonly start: number
  readonly end: number
}

export type AnalysisChannelMode =
  | { readonly kind: 'mix' }
  | { readonly kind: 'channel'; readonly index: number }

/** Serializable options shared by UI and Worker request payloads. */
export interface AnalysisOptions {
  readonly sampleRate: number
  readonly fftSize?: number
  readonly hopSize?: number
  readonly window?: WindowFunctionName
  readonly channelMode?: AnalysisChannelMode
  readonly minDb?: number
  readonly maxDb?: number
  readonly range?: SampleRange
  /** First STFT frame relative to `range.start`, useful for tile workers. */
  readonly firstFrame?: number
  /** Number of consecutive frames to calculate, useful for tile workers. */
  readonly frameCount?: number
}

/** Runtime-only hooks; these are deliberately separate from serializable options. */
export interface AnalysisRunControl {
  readonly shouldCancel?: () => boolean
  readonly onProgress?: (completedFrames: number, totalFrames: number) => void
}

export interface SpectrumFrameOptions {
  readonly fftSize?: number
  readonly window?: WindowFunctionName
  readonly minDb?: number
  readonly maxDb?: number
}

export interface SpectrumFrameResult {
  readonly fftSize: number
  readonly binCount: number
  readonly window: WindowFunctionName
  readonly valuesDbfs: Float32Array
}

export interface StftPreviewResult {
  readonly sampleRate: number
  readonly fftSize: number
  readonly hopSize: number
  readonly frameCount: number
  readonly totalFrameCount: number
  readonly firstFrame: number
  readonly binCount: number
  readonly window: WindowFunctionName
  readonly channelMode: AnalysisChannelMode
  readonly range: SampleRange
  readonly minDb: number
  readonly maxDb: number
  /** Absolute frame numbers relative to `range.start`. */
  readonly frameIndices: Float64Array
  readonly timesSeconds: Float64Array
  readonly frequenciesHz: Float64Array
  /** Frame-major matrix: valuesDbfs[frame * binCount + bin]. */
  readonly valuesDbfs: Float32Array
}

/**
 * Analysis options shared by every source channel in a batch. Batch jobs use
 * an explicit frame count so the Worker can yield predictably between bounded
 * chunks instead of entering the implicit whole-range preview path.
 */
export type ChannelBatchAnalysisOptions =
  Omit<AnalysisOptions, 'channelMode' | 'frameCount'>
  & { readonly frameCount: number }

export interface ChannelStftPreview {
  /** Zero-based source channel index. */
  readonly channelIndex: number
  readonly preview: StftPreviewResult
}

/** Ordered results for a single multi-channel analysis request. */
export interface MultiChannelStftPreviewResult {
  readonly results: readonly ChannelStftPreview[]
}

export class AnalysisCancelledError extends Error {
  constructor() {
    super('Audio analysis was cancelled')
    this.name = 'AnalysisCancelledError'
  }
}

interface ResolvedAnalysisOptions {
  readonly sampleRate: number
  readonly fftSize: number
  readonly hopSize: number
  readonly window: WindowFunctionName
  readonly channelMode: AnalysisChannelMode
  readonly minDb: number
  readonly maxDb: number
  readonly range: SampleRange
  readonly firstFrame: number
  readonly requestedFrameCount: number | undefined
}

function assertChannels(channels: readonly Float32Array[]): number {
  if (channels.length === 0) {
    throw new RangeError('At least one PCM channel is required')
  }

  const sampleCount = channels[0]?.length ?? 0
  for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
    if (channels[channelIndex]?.length !== sampleCount) {
      throw new RangeError('All PCM channels must have the same sample count')
    }
  }

  return sampleCount
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`)
  }
}

function assertDbRange(minDb: number, maxDb: number): void {
  if (
    !Number.isFinite(minDb) ||
    !Number.isFinite(maxDb) ||
    minDb >= maxDb ||
    maxDb > 0
  ) {
    throw new RangeError('dBFS range must satisfy finite minDb < maxDb <= 0')
  }
}

function isWindowFunctionName(value: string): value is WindowFunctionName {
  return (WINDOW_FUNCTION_NAMES as readonly string[]).includes(value)
}

function resolveOptions(
  sampleCount: number,
  options: AnalysisOptions,
): ResolvedAnalysisOptions {
  if (!Number.isFinite(options.sampleRate) || options.sampleRate <= 0) {
    throw new RangeError('sampleRate must be finite and greater than zero')
  }

  const fftSize = options.fftSize ?? DEFAULT_ANALYSIS_PARAMETERS.fftSize
  assertValidFftSize(fftSize)

  const hopSize = options.hopSize ?? fftSize / 4
  if (
    !Number.isSafeInteger(hopSize) ||
    hopSize < 1 ||
    hopSize > fftSize
  ) {
    throw new RangeError('hopSize must be an integer between 1 and fftSize')
  }

  const window = options.window ?? DEFAULT_ANALYSIS_PARAMETERS.window
  if (!isWindowFunctionName(window)) {
    throw new RangeError(`Unsupported window function: ${String(window)}`)
  }

  const minDb = options.minDb ?? DEFAULT_ANALYSIS_PARAMETERS.minDb
  const maxDb = options.maxDb ?? DEFAULT_ANALYSIS_PARAMETERS.maxDb
  assertDbRange(minDb, maxDb)

  const range = options.range ?? { start: 0, end: sampleCount }
  assertNonNegativeSafeInteger(range.start, 'range.start')
  assertNonNegativeSafeInteger(range.end, 'range.end')
  if (range.start > range.end || range.end > sampleCount) {
    throw new RangeError('range must satisfy 0 <= start <= end <= sample count')
  }

  const firstFrame = options.firstFrame ?? 0
  assertNonNegativeSafeInteger(firstFrame, 'firstFrame')

  if (options.frameCount !== undefined) {
    assertNonNegativeSafeInteger(options.frameCount, 'frameCount')
  }

  return {
    sampleRate: options.sampleRate,
    fftSize,
    hopSize,
    window,
    channelMode: options.channelMode ?? { kind: 'mix' },
    minDb,
    maxDb,
    range: { start: range.start, end: range.end },
    firstFrame,
    requestedFrameCount: options.frameCount,
  }
}

function assertChannelMode(
  mode: AnalysisChannelMode,
  channelCount: number,
): void {
  if (mode.kind === 'mix') {
    return
  }

  if (
    mode.kind !== 'channel' ||
    !Number.isSafeInteger(mode.index) ||
    mode.index < 0 ||
    mode.index >= channelCount
  ) {
    throw new RangeError('Selected analysis channel is out of range')
  }
}

function assertChannelIndices(
  channelIndices: readonly number[],
  channelCount: number,
): void {
  if (channelIndices.length === 0) {
    throw new RangeError('At least one analysis channel index is required')
  }

  const uniqueIndices = new Set<number>()
  for (const channelIndex of channelIndices) {
    assertChannelMode({ kind: 'channel', index: channelIndex }, channelCount)
    if (uniqueIndices.has(channelIndex)) {
      throw new RangeError('Analysis channel indices must be unique')
    }
    uniqueIndices.add(channelIndex)
  }
}

function finiteSample(value: number | undefined): number {
  return Number.isFinite(value) ? (value ?? 0) : 0
}

/**
 * Downmixes equally-sized planar PCM using a fixed arithmetic average.
 * Non-finite decoded samples are replaced with silence at the analysis edge.
 */
export function mixChannels(channels: readonly Float32Array[]): Float32Array {
  const sampleCount = assertChannels(channels)
  const output = new Float32Array(sampleCount)

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    let sum = 0
    for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
      sum += finiteSample(channels[channelIndex]?.[sampleIndex])
    }
    output[sampleIndex] = sum / channels.length
  }

  return output
}

export function amplitudeToDbfs(amplitude: number): number {
  const finiteAmplitude =
    Number.isFinite(amplitude) && amplitude > 0 ? amplitude : 0
  return 20 * Math.log10(Math.max(finiteAmplitude, DBFS_AMPLITUDE_FLOOR))
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function writeOneSidedSpectrumDbfs(
  real: Float64Array,
  imaginary: Float64Array,
  windowSum: number,
  minDb: number,
  maxDb: number,
  target: Float32Array,
  targetOffset: number,
): void {
  const fftSize = real.length
  const nyquistBin = fftSize / 2

  for (let bin = 0; bin <= nyquistBin; bin += 1) {
    const realValue = real[bin] ?? 0
    const imaginaryValue = imaginary[bin] ?? 0
    const magnitude = Math.hypot(realValue, imaginaryValue)
    const oneSidedScale = bin === 0 || bin === nyquistBin ? 1 : 2
    const amplitude =
      Number.isFinite(magnitude) && windowSum > 0
        ? (oneSidedScale * magnitude) / windowSum
        : 0
    target[targetOffset + bin] = clamp(
      amplitudeToDbfs(amplitude),
      minDb,
      maxDb,
    )
  }
}

/** Converts an unnormalised complex FFT into a calibrated one-sided spectrum. */
export function spectrumToDbfs(
  spectrum: ComplexSpectrum,
  window: ArrayLike<number>,
  minDb = DEFAULT_ANALYSIS_PARAMETERS.minDb,
  maxDb = DEFAULT_ANALYSIS_PARAMETERS.maxDb,
): Float32Array {
  const fftSize = spectrum.real.length
  assertValidFftSize(fftSize)
  if (spectrum.imaginary.length !== fftSize || window.length !== fftSize) {
    throw new RangeError('Spectrum and window buffers must match the FFT size')
  }
  assertDbRange(minDb, maxDb)

  const windowSum = calculateCoherentGain(window) * fftSize
  const output = new Float32Array(fftSize / 2 + 1)
  writeOneSidedSpectrumDbfs(
    spectrum.real,
    spectrum.imaginary,
    windowSum,
    minDb,
    maxDb,
    output,
    0,
  )
  return output
}

/** Computes one zero-padded, windowed, calibrated spectrum frame. */
export function analyzeSpectrumFrame(
  samples: ArrayLike<number>,
  options: SpectrumFrameOptions = {},
): SpectrumFrameResult {
  const fftSize = options.fftSize ?? samples.length
  assertValidFftSize(fftSize)
  if (samples.length > fftSize) {
    throw new RangeError('Spectrum frame contains more samples than fftSize')
  }

  const windowName = options.window ?? DEFAULT_ANALYSIS_PARAMETERS.window
  if (!isWindowFunctionName(windowName)) {
    throw new RangeError(`Unsupported window function: ${String(windowName)}`)
  }
  const minDb = options.minDb ?? DEFAULT_ANALYSIS_PARAMETERS.minDb
  const maxDb = options.maxDb ?? DEFAULT_ANALYSIS_PARAMETERS.maxDb
  assertDbRange(minDb, maxDb)

  const window = createWindow(windowName, fftSize)
  const real = new Float64Array(fftSize)
  const imaginary = new Float64Array(fftSize)
  for (let index = 0; index < fftSize; index += 1) {
    real[index] = finiteSample(samples[index]) * (window[index] ?? 0)
  }

  fftRadix2InPlace(real, imaginary)
  const valuesDbfs = new Float32Array(fftSize / 2 + 1)
  const windowSum = calculateCoherentGain(window) * fftSize
  writeOneSidedSpectrumDbfs(
    real,
    imaginary,
    windowSum,
    minDb,
    maxDb,
    valuesDbfs,
    0,
  )

  return {
    fftSize,
    binCount: valuesDbfs.length,
    window: windowName,
    valuesDbfs,
  }
}

function createFrameIndices(
  totalFrameCount: number,
  firstFrame: number,
  requestedFrameCount: number | undefined,
): Float64Array {
  const remainingFrames = Math.max(0, totalFrameCount - firstFrame)

  if (requestedFrameCount !== undefined) {
    const frameCount = Math.min(requestedFrameCount, remainingFrames)
    const indices = new Float64Array(frameCount)
    for (let index = 0; index < frameCount; index += 1) {
      indices[index] = firstFrame + index
    }
    return indices
  }

  const frameCount = Math.min(
    remainingFrames,
    DEFAULT_STFT_PREVIEW_FRAME_LIMIT,
  )
  const indices = new Float64Array(frameCount)
  if (frameCount === 0) {
    return indices
  }
  if (frameCount === 1) {
    indices[0] = firstFrame
    return indices
  }

  // A preview samples the whole requested span. Exact Worker tiles pass an
  // explicit frameCount and therefore take the consecutive branch above.
  for (let index = 0; index < frameCount; index += 1) {
    indices[index] =
      firstFrame +
      Math.round((index * (remainingFrames - 1)) / (frameCount - 1))
  }
  return indices
}

function readAnalysisSample(
  channels: readonly Float32Array[],
  mode: AnalysisChannelMode,
  sampleIndex: number,
): number {
  if (mode.kind === 'channel') {
    return finiteSample(channels[mode.index]?.[sampleIndex])
  }

  let sum = 0
  for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 1) {
    sum += finiteSample(channels[channelIndex]?.[sampleIndex])
  }
  return sum / channels.length
}

/**
 * Builds a bounded STFT preview, or an exact consecutive tile when
 * `firstFrame`/`frameCount` are supplied. Tail samples outside the half-open
 * analysis range are zero padded.
 */
export function computeStftPreview(
  channels: readonly Float32Array[],
  options: AnalysisOptions,
  control: AnalysisRunControl = {},
): StftPreviewResult {
  const sampleCount = assertChannels(channels)
  const resolved = resolveOptions(sampleCount, options)
  assertChannelMode(resolved.channelMode, channels.length)
  const channelMode: AnalysisChannelMode =
    resolved.channelMode.kind === 'channel'
      ? { kind: 'channel', index: resolved.channelMode.index }
      : { kind: 'mix' }

  const rangeLength = resolved.range.end - resolved.range.start
  const totalFrameCount =
    rangeLength === 0 ? 0 : Math.ceil(rangeLength / resolved.hopSize)
  const frameIndices = createFrameIndices(
    totalFrameCount,
    resolved.firstFrame,
    resolved.requestedFrameCount,
  )
  const frameCount = frameIndices.length
  const binCount = resolved.fftSize / 2 + 1
  const valueCount = frameCount * binCount
  if (!Number.isSafeInteger(valueCount)) {
    throw new RangeError('Requested STFT matrix is too large')
  }

  const timesSeconds = new Float64Array(frameCount)
  const frequenciesHz = new Float64Array(binCount)
  const valuesDbfs = new Float32Array(valueCount)
  const window = createWindow(resolved.window, resolved.fftSize)
  const windowSum = calculateCoherentGain(window) * resolved.fftSize
  const real = new Float64Array(resolved.fftSize)
  const imaginary = new Float64Array(resolved.fftSize)

  for (let bin = 0; bin < binCount; bin += 1) {
    frequenciesHz[bin] = (bin * resolved.sampleRate) / resolved.fftSize
  }

  for (let outputFrame = 0; outputFrame < frameCount; outputFrame += 1) {
    if (control.shouldCancel?.()) {
      throw new AnalysisCancelledError()
    }

    const frameIndex = frameIndices[outputFrame] ?? 0
    const frameStart =
      resolved.range.start + frameIndex * resolved.hopSize
    timesSeconds[outputFrame] =
      (frameStart + resolved.fftSize / 2) / resolved.sampleRate

    imaginary.fill(0)
    for (let offset = 0; offset < resolved.fftSize; offset += 1) {
      const sampleIndex = frameStart + offset
      const sample =
        sampleIndex < resolved.range.end
          ? readAnalysisSample(channels, channelMode, sampleIndex)
          : 0
      real[offset] = sample * (window[offset] ?? 0)
    }

    fftRadix2InPlace(real, imaginary)
    writeOneSidedSpectrumDbfs(
      real,
      imaginary,
      windowSum,
      resolved.minDb,
      resolved.maxDb,
      valuesDbfs,
      outputFrame * binCount,
    )
    control.onProgress?.(outputFrame + 1, frameCount)
  }

  return {
    sampleRate: resolved.sampleRate,
    fftSize: resolved.fftSize,
    hopSize: resolved.hopSize,
    frameCount,
    totalFrameCount,
    firstFrame: resolved.firstFrame,
    binCount,
    window: resolved.window,
    channelMode,
    range: resolved.range,
    minDb: resolved.minDb,
    maxDb: resolved.maxDb,
    frameIndices,
    timesSeconds,
    frequenciesHz,
    valuesDbfs,
  }
}

/**
 * Computes matching STFT previews for selected source channels. Results retain
 * request order and share their immutable time/frequency axis buffers.
 */
export function computeChannelStftPreviews(
  channels: readonly Float32Array[],
  channelIndices: readonly number[],
  options: ChannelBatchAnalysisOptions,
  control: AnalysisRunControl = {},
): MultiChannelStftPreviewResult {
  assertChannels(channels)
  assertChannelIndices(channelIndices, channels.length)

  const results: ChannelStftPreview[] = []
  let sharedAxes: Pick<
    StftPreviewResult,
    'frameIndices' | 'timesSeconds' | 'frequenciesHz'
  > | undefined

  for (
    let resultIndex = 0;
    resultIndex < channelIndices.length;
    resultIndex += 1
  ) {
    if (control.shouldCancel?.()) {
      throw new AnalysisCancelledError()
    }

    const channelIndex = channelIndices[resultIndex]
    if (channelIndex === undefined) {
      throw new RangeError('Analysis channel index is missing')
    }

    const computed = computeStftPreview(
      channels,
      {
        ...options,
        channelMode: { kind: 'channel', index: channelIndex },
      },
      {
        shouldCancel: control.shouldCancel,
        onProgress: (completedFrames, totalFrames) => {
          control.onProgress?.(
            resultIndex * totalFrames + completedFrames,
            channelIndices.length * totalFrames,
          )
        },
      },
    )

    sharedAxes ??= {
      frameIndices: computed.frameIndices,
      timesSeconds: computed.timesSeconds,
      frequenciesHz: computed.frequenciesHz,
    }
    const preview = resultIndex === 0
      ? computed
      : {
          ...computed,
          ...sharedAxes,
        }
    results.push({ channelIndex, preview })
  }

  return { results }
}
