import {
  AnalysisCancelledError,
  computeStftPreview,
  type AnalysisRunControl,
  type ChannelStftPreview,
  type MultiChannelStftPreviewResult,
  type StftPreviewResult,
} from '../audio/analysis'
import {
  buildPeakPyramid,
  PeakBuildCancelledError,
  type WaveformPyramid,
} from '../audio/peaks'
import {
  WORKER_PROTOCOL_VERSION,
  type AnalysisWorkerRequest,
  type AnalysisWorkerResponse,
  type AnalyzeChannelsPayload,
  type AnalyzePayload,
  type BuildPeaksPayload,
  type WorkerErrorData,
} from './protocol'

const MIN_PROGRESS_INTERVAL_MS = 100
const MAX_RESULT_BYTES = 256 * 1024 * 1024

interface ActiveJob {
  readonly requestId: string
  readonly jobId: string
  cancelled: boolean
  terminal: boolean
}

export type WorkerPostMessage = (
  response: AnalysisWorkerResponse,
  transfer?: Transferable[],
) => void

export interface AnalysisWorkerRuntimeOptions {
  readonly yieldToEventLoop?: () => Promise<void>
  readonly now?: () => number
}

export interface AnalysisWorkerRuntime {
  handleMessage(message: unknown): Promise<void>
  dispose(): void
}

type ResponseWithoutEnvelope<T> = T extends unknown
  ? Omit<T, 'protocolVersion' | 'requestId' | 'jobId'>
  : never

type AnalysisWorkerResponseBody = ResponseWithoutEnvelope<AnalysisWorkerResponse>

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

function isRequest(value: unknown): value is AnalysisWorkerRequest {
  if (
    !hasEnvelopeIdentifiers(value) ||
    value.protocolVersion !== WORKER_PROTOCOL_VERSION ||
    !isRecord(value.payload)
  ) {
    return false
  }

  switch (value.type) {
    case 'analyze':
      return Array.isArray(value.payload.channels) && isRecord(value.payload.options)
    case 'analyze-channels':
      return (
        Array.isArray(value.payload.channels) &&
        Array.isArray(value.payload.channelIndices) &&
        isRecord(value.payload.options)
      )
    case 'build-peaks':
      return (
        typeof value.payload.assetId === 'string' &&
        value.payload.assetId.length > 0 &&
        Array.isArray(value.payload.channels)
      )
    case 'cancel':
      return (
        typeof value.payload.targetJobId === 'string' &&
        value.payload.targetJobId.length > 0
      )
    default:
      return false
  }
}

function collectTransferables(
  result: StftPreviewResult | MultiChannelStftPreviewResult | WaveformPyramid,
): Transferable[] {
  const buffers = new Set<ArrayBuffer>()
  const add = (view: ArrayBufferView): void => {
    if (view.buffer instanceof ArrayBuffer) {
      buffers.add(view.buffer)
    }
  }

  const addPreview = (preview: StftPreviewResult): void => {
    add(preview.frameIndices)
    add(preview.timesSeconds)
    add(preview.frequenciesHz)
    add(preview.valuesDbfs)
  }

  if ('results' in result) {
    for (const { preview } of result.results) {
      addPreview(preview)
    }
  } else if ('valuesDbfs' in result) {
    addPreview(result)
  } else {
    for (const level of result.levels) {
      for (const channel of level.channels) {
        add(channel.mins)
        add(channel.maxs)
      }
    }
  }

  return [...buffers]
}

function structuredError(error: unknown): WorkerErrorData {
  if (error instanceof RangeError || error instanceof TypeError) {
    return {
      code: 'ANALYSIS_INVALID_REQUEST',
      message: error.message,
      retryable: false,
    }
  }

  return {
    code: 'ANALYSIS_WORKER_FAILED',
    message: error instanceof Error ? error.message : 'Analysis worker failed',
    retryable: true,
  }
}

function assertChannels(channels: unknown): asserts channels is Float32Array[] {
  if (!Array.isArray(channels) || channels.length === 0 || channels.length > 32) {
    throw new RangeError('Worker analysis requires between 1 and 32 PCM channels')
  }

  let totalBytes = 0
  let sourceLength: number | undefined
  for (let index = 0; index < channels.length; index += 1) {
    const channel = channels[index]
    if (!(channel instanceof Float32Array)) {
      throw new TypeError(`channels[${index}] must be a Float32Array`)
    }
    sourceLength ??= channel.length
    if (channel.length !== sourceLength) {
      throw new RangeError('All PCM channels must have the same sample count')
    }
    totalBytes += channel.byteLength
  }

  if (!Number.isSafeInteger(totalBytes) || totalBytes > 1024 * 1024 * 1024) {
    throw new RangeError('PCM payload exceeds the worker memory limit')
  }
}

function assertChannelIndices(
  channelIndices: unknown,
  channelCount: number,
): asserts channelIndices is number[] {
  if (!Array.isArray(channelIndices) || channelIndices.length === 0) {
    throw new RangeError('At least one analysis channel index is required')
  }

  const uniqueIndices = new Set<number>()
  for (const channelIndex of channelIndices) {
    if (
      !Number.isSafeInteger(channelIndex) ||
      channelIndex < 0 ||
      channelIndex >= channelCount
    ) {
      throw new RangeError('Selected analysis channel is out of range')
    }
    if (uniqueIndices.has(channelIndex)) {
      throw new RangeError('Analysis channel indices must be unique')
    }
    uniqueIndices.add(channelIndex)
  }
}

function assertMultiChannelResultSize(
  preview: StftPreviewResult,
  channelCount: number,
): void {
  const sharedAxisBytes =
    preview.frameIndices.byteLength +
    preview.timesSeconds.byteLength +
    preview.frequenciesHz.byteLength
  const resultBytes =
    sharedAxisBytes + preview.valuesDbfs.byteLength * channelCount

  if (!Number.isSafeInteger(resultBytes) || resultBytes > MAX_RESULT_BYTES) {
    throw new RangeError(
      'Requested multi-channel STFT result exceeds the worker memory limit',
    )
  }
}

function combineExactAnalysisTiles(
  first: StftPreviewResult,
  frameCount: number,
): StftPreviewResult {
  const valueCount = frameCount * first.binCount
  const resultBytes =
    valueCount * Float32Array.BYTES_PER_ELEMENT +
    frameCount * Float64Array.BYTES_PER_ELEMENT * 2 +
    first.binCount * Float64Array.BYTES_PER_ELEMENT

  if (!Number.isSafeInteger(valueCount) || resultBytes > MAX_RESULT_BYTES) {
    throw new RangeError('Requested STFT result exceeds the worker memory limit')
  }

  return {
    ...first,
    frameCount,
    frameIndices: new Float64Array(frameCount),
    timesSeconds: new Float64Array(frameCount),
    valuesDbfs: new Float32Array(valueCount),
  }
}

function copyAnalysisTile(
  target: StftPreviewResult,
  tile: StftPreviewResult,
  targetFrameOffset: number,
): void {
  target.frameIndices.set(tile.frameIndices, targetFrameOffset)
  target.timesSeconds.set(tile.timesSeconds, targetFrameOffset)
  target.valuesDbfs.set(tile.valuesDbfs, targetFrameOffset * target.binCount)
}

export function createAnalysisWorkerRuntime(
  postMessage: WorkerPostMessage,
  options: AnalysisWorkerRuntimeOptions = {},
): AnalysisWorkerRuntime {
  const jobs = new Map<string, ActiveJob>()
  const yieldToEventLoop = options.yieldToEventLoop ?? defaultYieldToEventLoop
  const now = options.now ?? (() => performance.now())

  const postForJob = (
    job: ActiveJob,
    response: AnalysisWorkerResponseBody,
    transfer?: Transferable[],
  ): void => {
    postMessage({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      requestId: job.requestId,
      jobId: job.jobId,
      ...response,
    } as AnalysisWorkerResponse, transfer)
  }

  const postError = (
    requestId: string,
    jobId: string,
    error: WorkerErrorData,
  ): void => {
    postMessage({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      requestId,
      jobId,
      type: 'error',
      error,
    })
  }

  const createProgressReporter = (job: ActiveJob) => {
    let lastPostedAt = Number.NEGATIVE_INFINITY
    let lastCompleted = -1
    return (completed: number, total: number, force = false): void => {
      if (job.cancelled || job.terminal || completed === lastCompleted) {
        return
      }

      const timestamp = now()
      if (!force && completed !== 0 && completed !== total && timestamp - lastPostedAt < MIN_PROGRESS_INTERVAL_MS) {
        return
      }

      lastPostedAt = timestamp
      lastCompleted = completed
      postForJob(job, {
        type: 'progress',
        completed,
        total,
      })
    }
  }

  const throwIfCancelled = (job: ActiveJob): void => {
    if (job.cancelled) {
      throw new AnalysisCancelledError()
    }
  }

  const runPreview = async (
    job: ActiveJob,
    payload: AnalyzePayload,
    reportProgress: (completed: number, total: number, force?: boolean) => void,
  ): Promise<StftPreviewResult> => {
    assertChannels(payload.channels)
    if (!isRecord(payload.options)) {
      throw new TypeError('Analysis options must be an object')
    }
    const control: AnalysisRunControl = {
      shouldCancel: () => job.cancelled,
      onProgress: (completed, total) => {
        reportProgress(completed, total, completed === total)
      },
    }

    // The public preview path intentionally samples at most 256 frames across
    // the whole range. Keep that exact sampling contract when frameCount is
    // omitted; yield once before publishing so a queued cancel can win.
    if (payload.options.frameCount === undefined) {
      reportProgress(0, 1, true)
      const result = computeStftPreview(payload.channels, payload.options, control)
      await yieldToEventLoop()
      throwIfCancelled(job)
      reportProgress(result.frameCount, result.frameCount, true)
      return result
    }

    const requestedFrameCount = payload.options.frameCount
    const fftSize = payload.options.fftSize ?? 2048
    const batchSize = Math.max(1, Math.min(32, Math.floor(262_144 / fftSize)))
    const firstBatchCount = Math.min(requestedFrameCount, batchSize)
    reportProgress(0, requestedFrameCount, true)

    const first = computeStftPreview(
      payload.channels,
      { ...payload.options, frameCount: firstBatchCount },
      {
        shouldCancel: () => job.cancelled,
        onProgress: (completed) => {
          reportProgress(completed, requestedFrameCount)
        },
      },
    )
    const availableFrameCount = Math.max(0, first.totalFrameCount - first.firstFrame)
    const actualFrameCount = Math.min(requestedFrameCount, availableFrameCount)

    if (actualFrameCount === first.frameCount) {
      await yieldToEventLoop()
      throwIfCancelled(job)
      reportProgress(actualFrameCount, actualFrameCount, true)
      return first
    }

    const combined = combineExactAnalysisTiles(first, actualFrameCount)
    copyAnalysisTile(combined, first, 0)
    let completed = first.frameCount
    reportProgress(completed, actualFrameCount)

    while (completed < actualFrameCount) {
      await yieldToEventLoop()
      throwIfCancelled(job)
      const count = Math.min(batchSize, actualFrameCount - completed)
      const tile = computeStftPreview(
        payload.channels,
        {
          ...payload.options,
          firstFrame: first.firstFrame + completed,
          frameCount: count,
        },
        {
          shouldCancel: () => job.cancelled,
          onProgress: (tileCompleted) => {
            reportProgress(completed + tileCompleted, actualFrameCount)
          },
        },
      )
      copyAnalysisTile(combined, tile, completed)
      completed += tile.frameCount
      reportProgress(completed, actualFrameCount, completed === actualFrameCount)
    }

    return combined
  }

  const runChannelPreviews = async (
    job: ActiveJob,
    payload: AnalyzeChannelsPayload,
    reportProgress: (completed: number, total: number, force?: boolean) => void,
  ): Promise<MultiChannelStftPreviewResult> => {
    assertChannels(payload.channels)
    assertChannelIndices(payload.channelIndices, payload.channels.length)
    if (!isRecord(payload.options)) {
      throw new TypeError('Analysis options must be an object')
    }
    if (!Number.isSafeInteger(payload.options.frameCount)) {
      throw new RangeError('Multi-channel analysis requires an explicit frameCount')
    }

    const results: ChannelStftPreview[] = []
    let sharedAxes: Pick<
      StftPreviewResult,
      'frameIndices' | 'timesSeconds' | 'frequenciesHz'
    > | undefined
    reportProgress(0, payload.channelIndices.length, true)

    for (
      let resultIndex = 0;
      resultIndex < payload.channelIndices.length;
      resultIndex += 1
    ) {
      throwIfCancelled(job)
      const channelIndex = payload.channelIndices[resultIndex]
      if (channelIndex === undefined) {
        throw new RangeError('Analysis channel index is missing')
      }

      const computed = await runPreview(
        job,
        {
          channels: payload.channels,
          options: {
            ...payload.options,
            channelMode: { kind: 'channel', index: channelIndex },
          },
        },
        () => undefined,
      )
      throwIfCancelled(job)

      if (sharedAxes === undefined) {
        assertMultiChannelResultSize(computed, payload.channelIndices.length)
        sharedAxes = {
          frameIndices: computed.frameIndices,
          timesSeconds: computed.timesSeconds,
          frequenciesHz: computed.frequenciesHz,
        }
      }
      const preview = resultIndex === 0
        ? computed
        : {
            ...computed,
            ...sharedAxes,
          }
      results.push({ channelIndex, preview })
      reportProgress(
        resultIndex + 1,
        payload.channelIndices.length,
        true,
      )
    }

    return { results }
  }

  const runPeaks = async (
    job: ActiveJob,
    payload: BuildPeaksPayload,
    reportProgress: (completed: number, total: number, force?: boolean) => void,
  ): Promise<WaveformPyramid> => {
    assertChannels(payload.channels)
    return buildPeakPyramid(
      payload.channels,
      {
        assetId: payload.assetId,
        baseBlockSize: payload.baseBlockSize,
      },
      {
        shouldCancel: () => job.cancelled,
        onProgress: ({ completed, total }) => {
          reportProgress(completed, total, completed === total)
        },
        yieldToEventLoop,
      },
    )
  }

  const runJob = async (
    request: Exclude<AnalysisWorkerRequest, { type: 'cancel' }>,
  ): Promise<void> => {
    if (jobs.has(request.jobId)) {
      postError(request.requestId, request.jobId, {
        code: 'ANALYSIS_DUPLICATE_JOB',
        message: `Worker job ${request.jobId} is already running`,
        retryable: false,
      })
      return
    }

    const job: ActiveJob = {
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
      const result = request.type === 'analyze'
        ? await runPreview(job, request.payload, reportProgress)
        : request.type === 'analyze-channels'
          ? await runChannelPreviews(job, request.payload, reportProgress)
          : await runPeaks(job, request.payload, reportProgress)
      throwIfCancelled(job)

      if (!job.terminal) {
        job.terminal = true
        postForJob(job, { type: 'result', payload: result }, collectTransferables(result))
      }
    } catch (error) {
      if (
        error instanceof AnalysisCancelledError ||
        error instanceof PeakBuildCancelledError ||
        job.cancelled
      ) {
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

  const handleCancel = (request: Extract<AnalysisWorkerRequest, { type: 'cancel' }>): void => {
    const job = jobs.get(request.payload.targetJobId)
    const cancelled = job !== undefined && !job.terminal
    if (cancelled) {
      job.cancelled = true
      job.terminal = true
      postForJob(job, { type: 'cancelled' })
    }

    postMessage({
      protocolVersion: WORKER_PROTOCOL_VERSION,
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
        const isVersionMismatch = message.protocolVersion !== WORKER_PROTOCOL_VERSION
        postError(message.requestId, message.jobId, {
          code: isVersionMismatch
            ? 'ANALYSIS_PROTOCOL_VERSION'
            : 'ANALYSIS_INVALID_REQUEST',
          message: isVersionMismatch
            ? `Unsupported worker protocol version ${String(message.protocolVersion)}`
            : 'Malformed analysis worker request',
          retryable: false,
        })
      }
      return
    }

    if (message.type === 'cancel') {
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
  const runtime = createAnalysisWorkerRuntime((response, transfer) => {
    workerScope.postMessage?.(response, transfer)
  })
  workerScope.addEventListener('message', (event) => {
    void runtime.handleMessage(event.data)
  })
}
