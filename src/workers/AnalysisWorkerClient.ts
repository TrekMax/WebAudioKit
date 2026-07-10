import type { StftPreviewResult } from '../audio/analysis'
import type { WaveformPyramid } from '../audio/peaks'
import {
  WORKER_PROTOCOL_VERSION,
  createRequest,
  isAnalysisWorkerResponse,
  type AnalyzePayload,
  type AnalysisWorkerRequest,
  type BuildPeaksPayload,
  type ProgressResponse,
  type WorkerErrorData,
} from './protocol'

export interface AnalysisWorkerPort {
  postMessage(message: unknown, transfer?: Transferable[]): void
  terminate(): void
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void
  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void
  removeEventListener(type: 'error', listener: (event: ErrorEvent) => void): void
}

export interface WorkerJobProgress {
  readonly completed: number
  readonly total: number
  readonly ratio: number
}

export interface WorkerJobOptions {
  readonly jobId?: string
  readonly transferChannels?: boolean
  readonly onProgress?: (progress: WorkerJobProgress) => void
}

export interface AnalysisWorkerJob<TResult> {
  readonly requestId: string
  readonly jobId: string
  readonly generation: number
  readonly result: Promise<TResult>
  cancel(): void
}

export interface AnalysisWorkerClientOptions {
  readonly worker?: AnalysisWorkerPort
  readonly idFactory?: (kind: 'request' | 'job') => string
}

type JobKind = 'analysis' | 'peaks'

interface PendingRequest {
  readonly requestId: string
  readonly jobId: string
  readonly kind: JobKind
  readonly generation: number
  readonly onProgress?: (progress: WorkerJobProgress) => void
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: unknown) => void
}

export class AnalysisWorkerError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(error: WorkerErrorData) {
    super(error.message)
    this.name = 'AnalysisWorkerError'
    this.code = error.code
    this.retryable = error.retryable
  }
}

export class AnalysisWorkerCancelledError extends Error {
  constructor(message = 'Analysis worker job was cancelled') {
    super(message)
    this.name = 'AnalysisWorkerCancelledError'
  }
}

export class StaleAnalysisWorkerResultError extends Error {
  constructor() {
    super('Analysis worker result belongs to an obsolete generation')
    this.name = 'StaleAnalysisWorkerResultError'
  }
}

export class AnalysisWorkerTerminatedError extends Error {
  constructor() {
    super('Analysis worker client has been terminated')
    this.name = 'AnalysisWorkerTerminatedError'
  }
}

let fallbackId = 0

function defaultIdFactory(kind: 'request' | 'job'): string {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid !== undefined) {
    return `${kind}-${uuid}`
  }

  fallbackId += 1
  return `${kind}-${Date.now().toString(36)}-${fallbackId.toString(36)}`
}

function collectChannelTransfers(channels: readonly Float32Array[]): Transferable[] {
  const buffers = new Set<ArrayBuffer>()
  for (const channel of channels) {
    if (channel.buffer instanceof ArrayBuffer) {
      buffers.add(channel.buffer)
    }
  }
  return [...buffers]
}

function progressSnapshot(response: ProgressResponse): WorkerJobProgress {
  const ratio = response.total === 0
    ? 1
    : Math.min(1, Math.max(0, response.completed / response.total))
  return {
    completed: response.completed,
    total: response.total,
    ratio,
  }
}

export class AnalysisWorkerClient {
  private readonly worker: AnalysisWorkerPort
  private readonly idFactory: (kind: 'request' | 'job') => string
  private readonly pending = new Map<string, PendingRequest>()
  private readonly requestIdByJobId = new Map<string, string>()
  private readonly generations: Record<JobKind, number> = {
    analysis: 0,
    peaks: 0,
  }
  private terminated = false

  constructor(options: AnalysisWorkerClientOptions = {}) {
    this.worker = options.worker ?? new Worker(
      new URL('./analysis.worker.ts', import.meta.url),
      { type: 'module' },
    ) as AnalysisWorkerPort
    this.idFactory = options.idFactory ?? defaultIdFactory
    this.worker.addEventListener('message', this.handleMessage)
    this.worker.addEventListener('error', this.handleWorkerError)
  }

  analyze(
    payload: AnalyzePayload,
    options: WorkerJobOptions = {},
  ): Promise<StftPreviewResult> {
    return this.startAnalyze(payload, options).result
  }

  startAnalyze(
    payload: AnalyzePayload,
    options: WorkerJobOptions = {},
  ): AnalysisWorkerJob<StftPreviewResult> {
    return this.startJob<StftPreviewResult>(
      'analysis',
      'analyze',
      payload,
      payload.channels,
      options,
    )
  }

  buildPeaks(
    payload: BuildPeaksPayload,
    options: WorkerJobOptions = {},
  ): Promise<WaveformPyramid> {
    return this.startBuildPeaks(payload, options).result
  }

  startBuildPeaks(
    payload: BuildPeaksPayload,
    options: WorkerJobOptions = {},
  ): AnalysisWorkerJob<WaveformPyramid> {
    return this.startJob<WaveformPyramid>(
      'peaks',
      'build-peaks',
      payload,
      payload.channels,
      options,
    )
  }

  /** Invalidates the current preview and cooperatively cancels its job. */
  invalidateAnalysis(): void {
    this.invalidateKind('analysis')
  }

  /** Invalidates the current waveform pyramid and cooperatively cancels its job. */
  invalidatePeaks(): void {
    this.invalidateKind('peaks')
  }

  cancel(jobId: string): boolean {
    const requestId = this.requestIdByJobId.get(jobId)
    if (requestId === undefined) {
      return false
    }

    const pending = this.pending.get(requestId)
    if (pending === undefined) {
      return false
    }

    this.removePending(pending)
    pending.reject(new AnalysisWorkerCancelledError())
    this.postCancellation(pending)
    return true
  }

  terminate(): void {
    if (this.terminated) {
      return
    }

    this.terminated = true
    this.generations.analysis += 1
    this.generations.peaks += 1
    this.worker.removeEventListener('message', this.handleMessage)
    this.worker.removeEventListener('error', this.handleWorkerError)
    this.worker.terminate()

    const error = new AnalysisWorkerTerminatedError()
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
    this.requestIdByJobId.clear()
  }

  private startJob<TResult>(
    kind: JobKind,
    type: 'analyze' | 'build-peaks',
    payload: AnalyzePayload | BuildPeaksPayload,
    channels: readonly Float32Array[],
    options: WorkerJobOptions,
  ): AnalysisWorkerJob<TResult> {
    if (this.terminated) {
      throw new AnalysisWorkerTerminatedError()
    }

    this.invalidateKind(kind)
    const generation = this.generations[kind]
    const requestId = this.idFactory('request')
    const jobId = options.jobId ?? this.idFactory('job')

    if (requestId.length === 0 || jobId.length === 0) {
      throw new RangeError('Worker request and job identifiers must not be empty')
    }
    if (this.pending.has(requestId) || this.requestIdByJobId.has(jobId)) {
      throw new Error('Worker request and job identifiers must be unique')
    }

    let resolveResult: (value: TResult | PromiseLike<TResult>) => void = () => undefined
    let rejectResult: (reason?: unknown) => void = () => undefined
    const result = new Promise<TResult>((resolve, reject) => {
      resolveResult = resolve
      rejectResult = reject
    })

    const pending: PendingRequest = {
      requestId,
      jobId,
      kind,
      generation,
      onProgress: options.onProgress,
      resolve: (value) => resolveResult(value as TResult),
      reject: rejectResult,
    }
    this.pending.set(requestId, pending)
    this.requestIdByJobId.set(jobId, requestId)

    const request = type === 'analyze'
      ? createRequest(requestId, jobId, type, payload as AnalyzePayload)
      : createRequest(requestId, jobId, type, payload as BuildPeaksPayload)
    const transfer = options.transferChannels === false
      ? []
      : collectChannelTransfers(channels)

    try {
      this.worker.postMessage(request, transfer)
    } catch (error) {
      this.removePending(pending)
      pending.reject(error)
    }

    return {
      requestId,
      jobId,
      generation,
      result,
      cancel: () => {
        this.cancel(jobId)
      },
    }
  }

  private invalidateKind(kind: JobKind): void {
    this.generations[kind] += 1
    const obsolete = [...this.pending.values()].filter(
      (pending) => pending.kind === kind,
    )

    for (const pending of obsolete) {
      this.removePending(pending)
      pending.reject(new StaleAnalysisWorkerResultError())
      this.postCancellation(pending)
    }
  }

  private postCancellation(pending: PendingRequest): void {
    if (this.terminated) {
      return
    }

    const request = createRequest(
      this.idFactory('request'),
      this.idFactory('job'),
      'cancel',
      { targetJobId: pending.jobId },
    )
    try {
      this.worker.postMessage(request)
    } catch {
      // The local promise is already terminal. A failing best-effort cancel
      // must not resurrect it or obscure the original cancellation reason.
    }
  }

  private removePending(pending: PendingRequest): void {
    this.pending.delete(pending.requestId)
    this.requestIdByJobId.delete(pending.jobId)
  }

  private readonly handleMessage = (event: MessageEvent<unknown>): void => {
    const response = event.data
    if (!isAnalysisWorkerResponse(response)) {
      return
    }

    const pending = this.pending.get(response.requestId)
    if (pending === undefined) {
      return
    }
    if (response.jobId !== pending.jobId) {
      this.removePending(pending)
      pending.reject(new AnalysisWorkerError({
        code: 'ANALYSIS_PROTOCOL_MISMATCH',
        message: 'Worker response job ID does not match its request',
        retryable: false,
      }))
      return
    }
    if (pending.generation !== this.generations[pending.kind]) {
      this.removePending(pending)
      pending.reject(new StaleAnalysisWorkerResultError())
      return
    }

    switch (response.type) {
      case 'accepted':
        return
      case 'progress':
        if (
          Number.isFinite(response.completed) &&
          Number.isFinite(response.total) &&
          response.completed >= 0 &&
          response.total >= 0
        ) {
          pending.onProgress?.(progressSnapshot(response))
        }
        return
      case 'result':
        this.removePending(pending)
        pending.resolve(response.payload)
        return
      case 'cancelled':
        this.removePending(pending)
        pending.reject(new AnalysisWorkerCancelledError())
        return
      case 'error':
        this.removePending(pending)
        pending.reject(new AnalysisWorkerError(response.error))
        return
      default: {
        const exhaustiveResponse: never = response
        void exhaustiveResponse
      }
    }
  }

  private readonly handleWorkerError = (event: ErrorEvent): void => {
    const error = new AnalysisWorkerError({
      code: 'ANALYSIS_WORKER_CRASHED',
      message: event.message || 'Analysis worker crashed',
      retryable: true,
    })
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
    this.requestIdByJobId.clear()
    this.generations.analysis += 1
    this.generations.peaks += 1
  }
}

export function isCurrentWorkerProtocolVersion(value: number): boolean {
  return value === WORKER_PROTOCOL_VERSION
}

export type { AnalysisWorkerRequest }
