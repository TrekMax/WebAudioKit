import type { StftPreviewResult } from '../audio/analysis'
import {
  calculatePeakNormalizationGain,
  encodeWav,
  findPeak,
  getWavEncodingInfo,
  type PlanarPcmData,
  type WavEncodeOptions,
  type WavEncodingInfo,
} from '../audio/wav'
import {
  EXPORT_WORKER_PROTOCOL_VERSION,
  type EncodeSpectrumCsvPayload,
  type EncodeWavPayload,
  type ExportWorkerErrorData,
  type ExportWorkerRequest,
  type ExportWorkerResponse,
  type SpectrumCsvExportResult,
  type WavExportResult,
} from './exportProtocol'

const MIN_PROGRESS_INTERVAL_MS = 100
const DEFAULT_WAV_CHUNK_FRAMES = 16_384
const DEFAULT_CSV_ROWS_PER_BATCH = 4_096
const DEFAULT_MAX_RESULT_BYTES = 1024 * 1024 * 1024
const MAX_PCM_PAYLOAD_BYTES = 1024 * 1024 * 1024
const WAV_HEADER_BYTES = 44
const DEFAULT_TARGET_PEAK_DBFS = -1

interface ActiveExportJob {
  readonly requestId: string
  readonly jobId: string
  cancelled: boolean
  terminal: boolean
}

class ExportCancelledError extends Error {
  constructor() {
    super('Export worker job was cancelled')
    this.name = 'ExportCancelledError'
  }
}

class ExportLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExportLimitError'
  }
}

export type ExportWorkerPostMessage = (
  response: ExportWorkerResponse,
  transfer?: Transferable[],
) => void

export interface ExportWorkerRuntimeOptions {
  readonly yieldToEventLoop?: () => Promise<void>
  readonly now?: () => number
  readonly wavChunkFrames?: number
  readonly csvRowsPerBatch?: number
  readonly maxResultBytes?: number
}

export interface ExportWorkerRuntime {
  handleMessage(message: unknown): Promise<void>
  dispose(): void
}

type ResponseWithoutEnvelope<T> = T extends unknown
  ? Omit<T, 'protocolVersion' | 'requestId' | 'jobId'>
  : never

type ExportWorkerResponseBody = ResponseWithoutEnvelope<ExportWorkerResponse>

function defaultYieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function hasEnvelopeIdentifiers(
  value: unknown,
): value is Record<string, unknown> & { requestId: string; jobId: string } {
  return (
    isRecord(value) &&
    typeof value.requestId === 'string' &&
    value.requestId.length > 0 &&
    typeof value.jobId === 'string' &&
    value.jobId.length > 0
  )
}

function isRequest(value: unknown): value is ExportWorkerRequest {
  if (
    !hasEnvelopeIdentifiers(value) ||
    value.protocolVersion !== EXPORT_WORKER_PROTOCOL_VERSION ||
    !isRecord(value.payload)
  ) {
    return false
  }

  switch (value.type) {
    case 'wav/encode':
      return (
        typeof value.payload.sampleRate === 'number' &&
        Array.isArray(value.payload.channels)
      )
    case 'csv/encode-spectrum':
      return isRecord(value.payload.result)
    case 'job/cancel':
      return (
        typeof value.payload.targetJobId === 'string' &&
        value.payload.targetJobId.length > 0
      )
    default:
      return false
  }
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }
}

function assertChannels(channels: unknown): asserts channels is Float32Array[] {
  if (!Array.isArray(channels) || channels.length === 0 || channels.length > 32) {
    throw new RangeError('WAV export requires between 1 and 32 PCM channels')
  }

  let sourceLength: number | undefined
  let totalBytes = 0
  for (let index = 0; index < channels.length; index += 1) {
    const channel = channels[index]
    if (!(channel instanceof Float32Array)) {
      throw new TypeError(`channels[${index}] must be a Float32Array`)
    }

    sourceLength ??= channel.length
    if (channel.length !== sourceLength) {
      throw new RangeError('All PCM channels must have the same frame count')
    }
    totalBytes += channel.byteLength
  }

  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_PCM_PAYLOAD_BYTES) {
    throw new ExportLimitError('PCM payload exceeds the export worker memory limit')
  }
}

function assertWavPayloadOptions(payload: EncodeWavPayload): void {
  if (
    payload.format !== undefined &&
    payload.format !== 'pcm16' &&
    payload.format !== 'pcm24' &&
    payload.format !== 'float32'
  ) {
    throw new RangeError(`Unsupported WAV sample format: ${String(payload.format)}`)
  }
  if (payload.normalize !== undefined && typeof payload.normalize !== 'boolean') {
    throw new TypeError('normalize must be a boolean when provided')
  }
  if (
    payload.targetPeakDbfs !== undefined &&
    typeof payload.targetPeakDbfs !== 'number'
  ) {
    throw new TypeError('targetPeakDbfs must be a number when provided')
  }
  if (payload.range !== undefined && !isRecord(payload.range)) {
    throw new TypeError('range must be an object when provided')
  }
}

function assertFinite(
  value: number | undefined,
  label: string,
): asserts value is number {
  if (value === undefined || !Number.isFinite(value)) {
    throw new RangeError(`${label} must be finite`)
  }
}

function assertStftResult(value: unknown): asserts value is StftPreviewResult {
  if (!isRecord(value)) {
    throw new TypeError('Spectrum CSV export requires an STFT result object')
  }

  const integerFields = [
    ['fftSize', value.fftSize],
    ['hopSize', value.hopSize],
    ['frameCount', value.frameCount],
    ['totalFrameCount', value.totalFrameCount],
    ['firstFrame', value.firstFrame],
    ['binCount', value.binCount],
  ] as const
  for (const [label, field] of integerFields) {
    if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < 0) {
      throw new RangeError(`${label} must be a non-negative safe integer`)
    }
  }

  if (value.fftSize === 0 || value.hopSize === 0 || value.binCount === 0) {
    throw new RangeError('fftSize, hopSize, and binCount must be greater than zero')
  }
  if (typeof value.sampleRate !== 'number' || value.sampleRate <= 0) {
    throw new RangeError('sampleRate must be finite and greater than zero')
  }
  assertFinite(value.sampleRate, 'sampleRate')

  if (
    !(value.frameIndices instanceof Float64Array) ||
    !(value.timesSeconds instanceof Float64Array) ||
    !(value.frequenciesHz instanceof Float64Array) ||
    !(value.valuesDbfs instanceof Float32Array)
  ) {
    throw new TypeError('STFT result arrays have invalid typed-array formats')
  }

  const frameCount = value.frameCount as number
  const binCount = value.binCount as number
  const valueCount = frameCount * binCount
  if (!Number.isSafeInteger(valueCount)) {
    throw new ExportLimitError('Spectrum CSV dimensions exceed safe integer limits')
  }
  if (
    value.frameIndices.length !== frameCount ||
    value.timesSeconds.length !== frameCount ||
    value.frequenciesHz.length !== binCount ||
    value.valuesDbfs.length !== valueCount
  ) {
    throw new RangeError('STFT result array lengths do not match frame and bin counts')
  }

  const sourceBytes =
    value.frameIndices.byteLength +
    value.timesSeconds.byteLength +
    value.frequenciesHz.byteLength +
    value.valuesDbfs.byteLength
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes > MAX_PCM_PAYLOAD_BYTES) {
    throw new ExportLimitError('STFT payload exceeds the export worker memory limit')
  }
}

function structuredError(error: unknown): ExportWorkerErrorData {
  if (error instanceof ExportLimitError) {
    return {
      code: 'EXPORT_TOO_LARGE',
      message: error.message,
      retryable: false,
    }
  }
  if (error instanceof RangeError || error instanceof TypeError) {
    return {
      code: 'EXPORT_INVALID_REQUEST',
      message: error.message,
      retryable: false,
    }
  }

  return {
    code: 'EXPORT_WORKER_FAILED',
    message: error instanceof Error ? error.message : 'Export worker failed',
    retryable: true,
  }
}

function wavOptions(payload: EncodeWavPayload, normalize: boolean): WavEncodeOptions {
  return {
    format: payload.format,
    range: payload.range,
    normalize,
    targetPeakDbfs: payload.targetPeakDbfs,
  }
}

function createWavHeader(
  sampleRate: number,
  numberOfChannels: number,
  info: WavEncodingInfo,
): Uint8Array {
  const silentChannels = Array.from(
    { length: numberOfChannels },
    () => new Float32Array(0),
  )
  const header = encodeWav(
    { sampleRate, channels: silentChannels },
    { format: info.format },
  )
  const view = new DataView(header)
  view.setUint32(4, 36 + info.dataBytes, true)
  view.setUint32(40, info.dataBytes, true)
  return new Uint8Array(header)
}

function scaleChannelChunk(
  channel: Float32Array,
  start: number,
  end: number,
  gain: number,
): Float32Array {
  const chunk = channel.slice(start, end)
  if (gain !== 1) {
    for (let index = 0; index < chunk.length; index += 1) {
      const value = chunk[index]
      chunk[index] = value === undefined ? 0 : value * gain
    }
  }
  return chunk
}

export function createExportWorkerRuntime(
  postMessage: ExportWorkerPostMessage,
  options: ExportWorkerRuntimeOptions = {},
): ExportWorkerRuntime {
  const jobs = new Map<string, ActiveExportJob>()
  const yieldToEventLoop = options.yieldToEventLoop ?? defaultYieldToEventLoop
  const now = options.now ?? (() => performance.now())
  const wavChunkFrames = options.wavChunkFrames ?? DEFAULT_WAV_CHUNK_FRAMES
  const csvRowsPerBatch = options.csvRowsPerBatch ?? DEFAULT_CSV_ROWS_PER_BATCH
  const maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES
  assertPositiveSafeInteger(wavChunkFrames, 'wavChunkFrames')
  assertPositiveSafeInteger(csvRowsPerBatch, 'csvRowsPerBatch')
  assertPositiveSafeInteger(maxResultBytes, 'maxResultBytes')

  const postForJob = (
    job: ActiveExportJob,
    response: ExportWorkerResponseBody,
    transfer?: Transferable[],
  ): void => {
    postMessage({
      protocolVersion: EXPORT_WORKER_PROTOCOL_VERSION,
      requestId: job.requestId,
      jobId: job.jobId,
      ...response,
    } as ExportWorkerResponse, transfer)
  }

  const postError = (
    requestId: string,
    jobId: string,
    error: ExportWorkerErrorData,
  ): void => {
    postMessage({
      protocolVersion: EXPORT_WORKER_PROTOCOL_VERSION,
      requestId,
      jobId,
      type: 'error',
      error,
    })
  }

  const createProgressReporter = (job: ActiveExportJob) => {
    let lastPostedAt = Number.NEGATIVE_INFINITY
    let lastCompleted = -1
    return (completed: number, total: number, force = false): void => {
      if (job.cancelled || job.terminal || completed === lastCompleted) {
        return
      }

      const timestamp = now()
      if (
        !force &&
        completed !== 0 &&
        completed !== total &&
        timestamp - lastPostedAt < MIN_PROGRESS_INTERVAL_MS
      ) {
        return
      }

      lastPostedAt = timestamp
      lastCompleted = completed
      postForJob(job, { type: 'progress', completed, total })
    }
  }

  const throwIfCancelled = (job: ActiveExportJob): void => {
    if (job.cancelled) {
      throw new ExportCancelledError()
    }
  }

  const runWavExport = async (
    job: ActiveExportJob,
    payload: EncodeWavPayload,
    reportProgress: (completed: number, total: number, force?: boolean) => void,
  ): Promise<WavExportResult> => {
    assertChannels(payload.channels)
    assertWavPayloadOptions(payload)
    const source: PlanarPcmData = {
      sampleRate: payload.sampleRate,
      channels: payload.channels,
    }
    const baseInfo = getWavEncodingInfo(source, wavOptions(payload, false))
    if (baseInfo.totalBytes > maxResultBytes) {
      throw new ExportLimitError(
        `WAV output exceeds the ${maxResultBytes.toString()} byte worker limit`,
      )
    }

    const range = payload.range ?? {
      start: 0,
      end: payload.channels[0]?.length ?? 0,
    }
    const scanWork = payload.normalize ? baseInfo.frameCount : 0
    const totalWork = baseInfo.frameCount + scanWork
    reportProgress(0, totalWork, true)

    let peak = 0
    if (payload.normalize) {
      for (let offset = 0; offset < baseInfo.frameCount; offset += wavChunkFrames) {
        throwIfCancelled(job)
        const count = Math.min(wavChunkFrames, baseInfo.frameCount - offset)
        const chunkRange = {
          start: range.start + offset,
          end: range.start + offset + count,
        }
        peak = Math.max(peak, findPeak(source, chunkRange))
        reportProgress(offset + count, totalWork)
        await yieldToEventLoop()
      }
    }

    throwIfCancelled(job)
    const gain = payload.normalize
      ? calculatePeakNormalizationGain(
          peak,
          payload.targetPeakDbfs ?? DEFAULT_TARGET_PEAK_DBFS,
        )
      : 1
    const info: WavEncodingInfo = {
      ...baseInfo,
      peak,
      gain,
    }

    const output = new ArrayBuffer(info.totalBytes)
    const outputBytes = new Uint8Array(output)
    outputBytes.set(createWavHeader(info.sampleRate, info.numberOfChannels, info))
    let outputOffset = WAV_HEADER_BYTES

    for (let offset = 0; offset < info.frameCount; offset += wavChunkFrames) {
      throwIfCancelled(job)
      const count = Math.min(wavChunkFrames, info.frameCount - offset)
      const start = range.start + offset
      const end = start + count
      const chunkChannels = payload.channels.map((channel) =>
        scaleChannelChunk(channel, start, end, gain),
      )
      const encodedChunk = encodeWav(
        { sampleRate: info.sampleRate, channels: chunkChannels },
        { format: info.format },
      )
      const data = new Uint8Array(encodedChunk, WAV_HEADER_BYTES)
      outputBytes.set(data, outputOffset)
      outputOffset += data.byteLength
      reportProgress(scanWork + offset + count, totalWork, offset + count === info.frameCount)
      await yieldToEventLoop()
    }

    throwIfCancelled(job)
    if (info.frameCount === 0) {
      reportProgress(0, 0, true)
    }
    return {
      kind: 'wav',
      bytes: output,
      mimeType: 'audio/wav',
      fileExtension: 'wav',
      info,
    }
  }

  const runSpectrumCsvExport = async (
    job: ActiveExportJob,
    payload: EncodeSpectrumCsvPayload,
    reportProgress: (completed: number, total: number, force?: boolean) => void,
  ): Promise<SpectrumCsvExportResult> => {
    if (
      payload.includeHeader !== undefined &&
      typeof payload.includeHeader !== 'boolean'
    ) {
      throw new TypeError('includeHeader must be a boolean when provided')
    }
    assertStftResult(payload.result)
    const result = payload.result
    const rowCount = result.frameCount * result.binCount
    const encoder = new TextEncoder()
    const parts: Uint8Array[] = []
    let totalBytes = 0
    const append = (bytes: Uint8Array): void => {
      totalBytes += bytes.byteLength
      if (!Number.isSafeInteger(totalBytes) || totalBytes > maxResultBytes) {
        throw new ExportLimitError(
          `CSV output exceeds the ${maxResultBytes.toString()} byte worker limit`,
        )
      }
      parts.push(bytes)
    }

    if (payload.includeHeader !== false) {
      append(encoder.encode(
        'time_seconds,frame_index,frequency_hz,bin_index,magnitude_dbfs\n',
      ))
    }

    reportProgress(0, result.frameCount, true)
    for (let bin = 0; bin < result.binCount; bin += 1) {
      const frequency = result.frequenciesHz[bin]
      assertFinite(frequency, `frequenciesHz[${bin}]`)
    }

    const framesPerBatch = Math.max(
      1,
      Math.floor(csvRowsPerBatch / result.binCount),
    )
    for (let firstFrame = 0; firstFrame < result.frameCount; firstFrame += framesPerBatch) {
      throwIfCancelled(job)
      const endFrame = Math.min(result.frameCount, firstFrame + framesPerBatch)
      const lines: string[] = []

      for (let frame = firstFrame; frame < endFrame; frame += 1) {
        const timeSeconds = result.timesSeconds[frame]
        const frameIndex = result.frameIndices[frame]
        assertFinite(timeSeconds, `timesSeconds[${frame}]`)
        if (
          frameIndex === undefined ||
          !Number.isSafeInteger(frameIndex) ||
          frameIndex < 0
        ) {
          throw new RangeError(`frameIndices[${frame}] must be a non-negative safe integer`)
        }

        for (let bin = 0; bin < result.binCount; bin += 1) {
          const frequency = result.frequenciesHz[bin]
          const magnitude = result.valuesDbfs[frame * result.binCount + bin]
          assertFinite(frequency, `frequenciesHz[${bin}]`)
          assertFinite(magnitude, `valuesDbfs[${frame},${bin}]`)
          lines.push(
            `${timeSeconds.toFixed(9)},${frameIndex.toString()},` +
            `${frequency.toFixed(6)},${bin.toString()},${magnitude.toFixed(3)}\n`,
          )
        }
      }

      append(encoder.encode(lines.join('')))
      reportProgress(endFrame, result.frameCount, endFrame === result.frameCount)
      await yieldToEventLoop()
    }

    throwIfCancelled(job)
    if (result.frameCount === 0) {
      await yieldToEventLoop()
      throwIfCancelled(job)
      reportProgress(0, 0, true)
    }

    const output = new Uint8Array(totalBytes)
    let offset = 0
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]
      if (part !== undefined) {
        output.set(part, offset)
        offset += part.byteLength
      }
      if (index > 0 && index % 64 === 0) {
        await yieldToEventLoop()
        throwIfCancelled(job)
      }
    }

    return {
      kind: 'spectrum-csv',
      bytes: output.buffer,
      mimeType: 'text/csv;charset=utf-8',
      fileExtension: 'csv',
      rowCount,
    }
  }

  const runJob = async (
    request: Exclude<ExportWorkerRequest, { type: 'job/cancel' }>,
  ): Promise<void> => {
    if (jobs.has(request.jobId)) {
      postError(request.requestId, request.jobId, {
        code: 'EXPORT_DUPLICATE_JOB',
        message: `Export worker job ${request.jobId} is already running`,
        retryable: false,
      })
      return
    }

    const job: ActiveExportJob = {
      requestId: request.requestId,
      jobId: request.jobId,
      cancelled: false,
      terminal: false,
    }
    jobs.set(job.jobId, job)
    postForJob(job, { type: 'accepted' })
    const reportProgress = createProgressReporter(job)

    try {
      await yieldToEventLoop()
      throwIfCancelled(job)
      const result = request.type === 'wav/encode'
        ? await runWavExport(job, request.payload, reportProgress)
        : await runSpectrumCsvExport(job, request.payload, reportProgress)
      throwIfCancelled(job)

      if (!job.terminal) {
        job.terminal = true
        postForJob(job, { type: 'result', payload: result }, [result.bytes])
      }
    } catch (error) {
      if (error instanceof ExportCancelledError || job.cancelled) {
        if (!job.terminal) {
          job.terminal = true
          postForJob(job, { type: 'cancelled' })
        }
      } else if (!job.terminal) {
        job.terminal = true
        postForJob(job, { type: 'error', error: structuredError(error) })
      }
    } finally {
      jobs.delete(job.jobId)
    }
  }

  const handleCancel = (
    request: Extract<ExportWorkerRequest, { type: 'job/cancel' }>,
  ): void => {
    const job = jobs.get(request.payload.targetJobId)
    const cancelled = job !== undefined && !job.terminal
    if (cancelled) {
      job.cancelled = true
      job.terminal = true
      postForJob(job, { type: 'cancelled' })
    }

    postMessage({
      protocolVersion: EXPORT_WORKER_PROTOCOL_VERSION,
      requestId: request.requestId,
      jobId: request.jobId,
      type: 'result',
      payload: {
        targetJobId: request.payload.targetJobId,
        cancelled,
      },
    })
  }

  const handleMessage = async (message: unknown): Promise<void> => {
    if (!isRequest(message)) {
      if (hasEnvelopeIdentifiers(message)) {
        const isVersionMismatch = (
          message.protocolVersion !== EXPORT_WORKER_PROTOCOL_VERSION
        )
        postError(message.requestId, message.jobId, {
          code: isVersionMismatch
            ? 'EXPORT_PROTOCOL_VERSION'
            : 'EXPORT_INVALID_REQUEST',
          message: isVersionMismatch
            ? `Unsupported export worker protocol version ${String(message.protocolVersion)}`
            : 'Malformed export worker request',
          retryable: false,
        })
      }
      return
    }

    if (message.type === 'job/cancel') {
      handleCancel(message)
      return
    }

    await runJob(message)
  }

  return {
    handleMessage,
    dispose: () => {
      for (const job of jobs.values()) {
        job.cancelled = true
        job.terminal = true
      }
      jobs.clear()
    },
  }
}

interface WorkerScopeLike {
  postMessage(message: unknown, transfer?: Transferable[]): void
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void
}

const workerScope = globalThis as unknown as Partial<WorkerScopeLike> & {
  readonly document?: unknown
}

if (
  workerScope.document === undefined &&
  typeof workerScope.postMessage === 'function' &&
  typeof workerScope.addEventListener === 'function'
) {
  const runtime = createExportWorkerRuntime((response, transfer) => {
    workerScope.postMessage?.(response, transfer)
  })
  workerScope.addEventListener('message', (event) => {
    void runtime.handleMessage(event.data)
  })
}
