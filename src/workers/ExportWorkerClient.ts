import type { StftPreviewResult } from '../audio/analysis'
import {
  EXPORT_WORKER_PROTOCOL_VERSION,
  createExportRequest,
  isExportWorkerResponse,
  isSpectrumCsvExportResult,
  isWavExportResult,
  type EncodeSpectrumCsvPayload,
  type EncodeWavPayload,
  type ExportProgressResponse,
  type ExportWorkerErrorData,
  type ExportWorkerRequest,
  type SpectrumCsvExportResult,
  type WavExportResult,
} from './exportProtocol'

export interface ExportWorkerPort {
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

export interface ExportJobProgress {
  readonly completed: number
  readonly total: number
  readonly ratio: number
}

export interface ExportJobOptions {
  readonly jobId?: string
  readonly onProgress?: (progress: ExportJobProgress) => void
}

export interface ExportWorkerJob<TResult> {
  readonly requestId: string
  readonly jobId: string
  readonly result: Promise<TResult>
  cancel(): void
}

export interface ExportWorkerClientOptions {
  readonly worker?: ExportWorkerPort
  readonly idFactory?: (kind: 'request' | 'job') => string
}

type ExportKind = 'wav' | 'spectrum-csv'

interface PendingRequest {
  readonly requestId: string
  readonly jobId: string
  readonly kind: ExportKind
  readonly onProgress?: (progress: ExportJobProgress) => void
  readonly resolve: (value: unknown) => void
  readonly reject: (reason: unknown) => void
}

export class ExportWorkerError extends Error {
  readonly code: string
  readonly retryable: boolean

  constructor(error: ExportWorkerErrorData) {
    super(error.message)
    this.name = 'ExportWorkerError'
    this.code = error.code
    this.retryable = error.retryable
  }
}

export class ExportWorkerCancelledError extends Error {
  constructor(message = 'Export worker job was cancelled') {
    super(message)
    this.name = 'ExportWorkerCancelledError'
  }
}

export class ExportWorkerTerminatedError extends Error {
  constructor() {
    super('Export worker client has been terminated')
    this.name = 'ExportWorkerTerminatedError'
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

function prepareWavPayload(payload: EncodeWavPayload): {
  readonly payload: EncodeWavPayload
  readonly transfer: Transferable[]
} {
  const buffers = new Set<ArrayBuffer>()
  for (const channel of payload.channels) {
    if (channel.buffer instanceof ArrayBuffer) {
      buffers.add(channel.buffer)
    }
  }
  return {
    payload: {
      ...payload,
      range: payload.range === undefined ? undefined : { ...payload.range },
    },
    transfer: [...buffers],
  }
}

function cloneStftResult(result: StftPreviewResult): {
  readonly result: StftPreviewResult
  readonly transfer: Transferable[]
} {
  const frameIndices = result.frameIndices.slice()
  const timesSeconds = result.timesSeconds.slice()
  const frequenciesHz = result.frequenciesHz.slice()
  const valuesDbfs = result.valuesDbfs.slice()
  return {
    result: {
      ...result,
      channelMode: { ...result.channelMode },
      range: { ...result.range },
      frameIndices,
      timesSeconds,
      frequenciesHz,
      valuesDbfs,
    },
    transfer: [
      frameIndices.buffer,
      timesSeconds.buffer,
      frequenciesHz.buffer,
      valuesDbfs.buffer,
    ],
  }
}

function cloneSpectrumCsvPayload(payload: EncodeSpectrumCsvPayload): {
  readonly payload: EncodeSpectrumCsvPayload
  readonly transfer: Transferable[]
} {
  const clone = cloneStftResult(payload.result)
  return {
    payload: {
      ...payload,
      result: clone.result,
    },
    transfer: clone.transfer,
  }
}

function progressSnapshot(response: ExportProgressResponse): ExportJobProgress {
  const ratio = response.total === 0
    ? 1
    : Math.min(1, Math.max(0, response.completed / response.total))
  return {
    completed: response.completed,
    total: response.total,
    ratio,
  }
}

export class ExportWorkerClient {
  private readonly worker: ExportWorkerPort
  private readonly idFactory: (kind: 'request' | 'job') => string
  private readonly pending = new Map<string, PendingRequest>()
  private readonly requestIdByJobId = new Map<string, string>()
  private terminated = false

  constructor(options: ExportWorkerClientOptions = {}) {
    this.worker = options.worker ?? new Worker(
      new URL('./export.worker.ts', import.meta.url),
      { type: 'module' },
    ) as ExportWorkerPort
    this.idFactory = options.idFactory ?? defaultIdFactory
    this.worker.addEventListener('message', this.handleMessage)
    this.worker.addEventListener('error', this.handleWorkerError)
  }

  encodeWav(
    payload: EncodeWavPayload,
    options: ExportJobOptions = {},
  ): Promise<WavExportResult> {
    return this.startEncodeWav(payload, options).result
  }

  startEncodeWav(
    payload: EncodeWavPayload,
    options: ExportJobOptions = {},
  ): ExportWorkerJob<WavExportResult> {
    this.assertActive()
    const prepared = prepareWavPayload(payload)
    return this.startJob<WavExportResult>(
      'wav',
      'wav/encode',
      prepared.payload,
      prepared.transfer,
      options,
    )
  }

  encodeSpectrumCsv(
    payload: EncodeSpectrumCsvPayload,
    options: ExportJobOptions = {},
  ): Promise<SpectrumCsvExportResult> {
    return this.startEncodeSpectrumCsv(payload, options).result
  }

  startEncodeSpectrumCsv(
    payload: EncodeSpectrumCsvPayload,
    options: ExportJobOptions = {},
  ): ExportWorkerJob<SpectrumCsvExportResult> {
    this.assertActive()
    const clone = cloneSpectrumCsvPayload(payload)
    return this.startJob<SpectrumCsvExportResult>(
      'spectrum-csv',
      'csv/encode-spectrum',
      clone.payload,
      clone.transfer,
      options,
    )
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
    pending.reject(new ExportWorkerCancelledError())
    this.postCancellation(pending.jobId)
    return true
  }

  terminate(): void {
    if (this.terminated) {
      return
    }

    this.terminated = true
    this.worker.removeEventListener('message', this.handleMessage)
    this.worker.removeEventListener('error', this.handleWorkerError)
    this.worker.terminate()

    const error = new ExportWorkerTerminatedError()
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
    this.requestIdByJobId.clear()
  }

  private startJob<TResult>(
    kind: ExportKind,
    type: 'wav/encode' | 'csv/encode-spectrum',
    payload: EncodeWavPayload | EncodeSpectrumCsvPayload,
    transfer: Transferable[],
    options: ExportJobOptions,
  ): ExportWorkerJob<TResult> {
    this.assertActive()

    const requestId = this.idFactory('request')
    const jobId = options.jobId ?? this.idFactory('job')
    if (requestId.length === 0 || jobId.length === 0) {
      throw new RangeError('Export request and job identifiers must not be empty')
    }
    if (this.pending.has(requestId) || this.requestIdByJobId.has(jobId)) {
      throw new Error('Export request and job identifiers must be unique')
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
      onProgress: options.onProgress,
      resolve: (value) => resolveResult(value as TResult),
      reject: rejectResult,
    }
    this.pending.set(requestId, pending)
    this.requestIdByJobId.set(jobId, requestId)

    const request = type === 'wav/encode'
      ? createExportRequest(requestId, jobId, type, payload as EncodeWavPayload)
      : createExportRequest(
          requestId,
          jobId,
          type,
          payload as EncodeSpectrumCsvPayload,
        )
    try {
      this.worker.postMessage(request, transfer)
    } catch (error) {
      this.removePending(pending)
      pending.reject(error)
    }

    return {
      requestId,
      jobId,
      result,
      cancel: () => {
        this.cancel(jobId)
      },
    }
  }

  private postCancellation(targetJobId: string): void {
    if (this.terminated) {
      return
    }

    const request = createExportRequest(
      this.idFactory('request'),
      this.idFactory('job'),
      'job/cancel',
      { targetJobId },
    )
    try {
      this.worker.postMessage(request)
    } catch {
      // Cancellation is already terminal locally. A best-effort worker
      // message must not replace the original cancellation result.
    }
  }

  private assertActive(): void {
    if (this.terminated) {
      throw new ExportWorkerTerminatedError()
    }
  }

  private removePending(pending: PendingRequest): void {
    this.pending.delete(pending.requestId)
    this.requestIdByJobId.delete(pending.jobId)
  }

  private rejectProtocolMismatch(pending: PendingRequest, message: string): void {
    this.removePending(pending)
    pending.reject(new ExportWorkerError({
      code: 'EXPORT_PROTOCOL_MISMATCH',
      message,
      retryable: false,
    }))
  }

  private readonly handleMessage = (event: MessageEvent<unknown>): void => {
    const response = event.data
    if (!isExportWorkerResponse(response)) {
      return
    }

    const pending = this.pending.get(response.requestId)
    if (pending === undefined) {
      return
    }
    if (response.jobId !== pending.jobId) {
      this.rejectProtocolMismatch(
        pending,
        'Export worker response job ID does not match its request',
      )
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
        if (
          (pending.kind === 'wav' && !isWavExportResult(response.payload)) ||
          (
            pending.kind === 'spectrum-csv' &&
            !isSpectrumCsvExportResult(response.payload)
          )
        ) {
          this.rejectProtocolMismatch(
            pending,
            'Export worker returned a result for the wrong export kind',
          )
          return
        }
        this.removePending(pending)
        pending.resolve(response.payload)
        return
      case 'cancelled':
        this.removePending(pending)
        pending.reject(new ExportWorkerCancelledError())
        return
      case 'error':
        this.removePending(pending)
        pending.reject(new ExportWorkerError(response.error))
        return
      default: {
        const exhaustiveResponse: never = response
        void exhaustiveResponse
      }
    }
  }

  private readonly handleWorkerError = (event: ErrorEvent): void => {
    const error = new ExportWorkerError({
      code: 'EXPORT_WORKER_CRASHED',
      message: event.message || 'Export worker crashed',
      retryable: true,
    })
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
    this.requestIdByJobId.clear()
  }
}

export function isCurrentExportWorkerProtocolVersion(value: number): boolean {
  return value === EXPORT_WORKER_PROTOCOL_VERSION
}

export type {
  EncodeSpectrumCsvPayload,
  EncodeWavPayload,
  ExportWorkerRequest,
  SpectrumCsvExportResult,
  WavExportResult,
}
