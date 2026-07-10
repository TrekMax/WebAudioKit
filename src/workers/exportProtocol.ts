import type { StftPreviewResult } from '../audio/analysis'
import type {
  WavEncodeOptions,
  WavEncodingInfo,
} from '../audio/wav'

export const EXPORT_WORKER_PROTOCOL_VERSION = 1 as const

export type ExportWorkerProtocolVersion = typeof EXPORT_WORKER_PROTOCOL_VERSION

export interface EncodeWavPayload extends WavEncodeOptions {
  readonly sampleRate: number
  /** Disposable planar PCM copies. ExportWorkerClient transfers these buffers. */
  readonly channels: Float32Array[]
}

export interface EncodeSpectrumCsvPayload {
  readonly result: StftPreviewResult
  readonly includeHeader?: boolean
}

export interface CancelExportPayload {
  readonly targetJobId: string
}

export interface CancelExportResult {
  readonly targetJobId: string
  readonly cancelled: boolean
}

export interface WavExportResult {
  readonly kind: 'wav'
  readonly bytes: ArrayBuffer
  readonly mimeType: 'audio/wav'
  readonly fileExtension: 'wav'
  readonly info: WavEncodingInfo
}

export interface SpectrumCsvExportResult {
  readonly kind: 'spectrum-csv'
  readonly bytes: ArrayBuffer
  readonly mimeType: 'text/csv;charset=utf-8'
  readonly fileExtension: 'csv'
  readonly rowCount: number
}

interface ExportWorkerRequestEnvelope<TType extends string, TPayload> {
  readonly protocolVersion: ExportWorkerProtocolVersion
  readonly requestId: string
  readonly jobId: string
  readonly type: TType
  readonly payload: TPayload
}

export type EncodeWavRequest = ExportWorkerRequestEnvelope<'wav/encode', EncodeWavPayload>
export type EncodeSpectrumCsvRequest = ExportWorkerRequestEnvelope<
  'csv/encode-spectrum',
  EncodeSpectrumCsvPayload
>
export type CancelExportRequest = ExportWorkerRequestEnvelope<
  'job/cancel',
  CancelExportPayload
>

export type ExportWorkerRequest =
  | EncodeWavRequest
  | EncodeSpectrumCsvRequest
  | CancelExportRequest

interface ExportWorkerResponseEnvelope<TType extends string> {
  readonly protocolVersion: ExportWorkerProtocolVersion
  readonly requestId: string
  readonly jobId: string
  readonly type: TType
}

export type ExportAcceptedResponse = ExportWorkerResponseEnvelope<'accepted'>

export interface ExportProgressResponse
  extends ExportWorkerResponseEnvelope<'progress'> {
  readonly completed: number
  readonly total: number
}

export interface ExportResultResponse<TPayload = ExportWorkerResult>
  extends ExportWorkerResponseEnvelope<'result'> {
  readonly payload: TPayload
}

export type ExportCancelledResponse = ExportWorkerResponseEnvelope<'cancelled'>

export interface ExportWorkerErrorData {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
}

export interface ExportErrorResponse extends ExportWorkerResponseEnvelope<'error'> {
  readonly error: ExportWorkerErrorData
}

export type ExportWorkerResult =
  | WavExportResult
  | SpectrumCsvExportResult
  | CancelExportResult

export type ExportWorkerResponse<TPayload = ExportWorkerResult> =
  | ExportAcceptedResponse
  | ExportProgressResponse
  | ExportResultResponse<TPayload>
  | ExportCancelledResponse
  | ExportErrorResponse

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isExportWorkerResponse(value: unknown): value is ExportWorkerResponse {
  if (!isRecord(value)) {
    return false
  }

  if (
    value.protocolVersion !== EXPORT_WORKER_PROTOCOL_VERSION ||
    typeof value.requestId !== 'string' ||
    value.requestId.length === 0 ||
    typeof value.jobId !== 'string' ||
    value.jobId.length === 0
  ) {
    return false
  }

  switch (value.type) {
    case 'accepted':
    case 'cancelled':
      return true
    case 'progress':
      return (
        typeof value.completed === 'number' &&
        typeof value.total === 'number'
      )
    case 'result':
      return 'payload' in value
    case 'error':
      return (
        isRecord(value.error) &&
        typeof value.error.code === 'string' &&
        typeof value.error.message === 'string' &&
        typeof value.error.retryable === 'boolean'
      )
    default:
      return false
  }
}

export function isWavExportResult(value: unknown): value is WavExportResult {
  const info = isRecord(value) ? value.info : undefined
  return (
    isRecord(value) &&
    value.kind === 'wav' &&
    value.bytes instanceof ArrayBuffer &&
    value.mimeType === 'audio/wav' &&
    value.fileExtension === 'wav' &&
    isRecord(info) &&
    (
      info.format === 'pcm16' ||
      info.format === 'pcm24' ||
      info.format === 'float32'
    ) &&
    typeof info.sampleRate === 'number' &&
    Number.isSafeInteger(info.sampleRate) &&
    info.sampleRate > 0 &&
    typeof info.numberOfChannels === 'number' &&
    Number.isSafeInteger(info.numberOfChannels) &&
    info.numberOfChannels > 0 &&
    typeof info.frameCount === 'number' &&
    Number.isSafeInteger(info.frameCount) &&
    info.frameCount >= 0 &&
    typeof info.dataBytes === 'number' &&
    Number.isSafeInteger(info.dataBytes) &&
    info.dataBytes >= 0 &&
    typeof info.totalBytes === 'number' &&
    Number.isSafeInteger(info.totalBytes) &&
    info.totalBytes >= 0 &&
    typeof info.peak === 'number' &&
    Number.isFinite(info.peak) &&
    info.peak >= 0 &&
    typeof info.gain === 'number' &&
    Number.isFinite(info.gain) &&
    info.gain >= 0
  )
}

export function isSpectrumCsvExportResult(
  value: unknown,
): value is SpectrumCsvExportResult {
  return (
    isRecord(value) &&
    value.kind === 'spectrum-csv' &&
    value.bytes instanceof ArrayBuffer &&
    value.mimeType === 'text/csv;charset=utf-8' &&
    value.fileExtension === 'csv' &&
    typeof value.rowCount === 'number' &&
    Number.isSafeInteger(value.rowCount) &&
    value.rowCount >= 0
  )
}

export function createExportRequest<TType extends ExportWorkerRequest['type']>(
  requestId: string,
  jobId: string,
  type: TType,
  payload: Extract<ExportWorkerRequest, { type: TType }>['payload'],
): Extract<ExportWorkerRequest, { type: TType }> {
  return {
    protocolVersion: EXPORT_WORKER_PROTOCOL_VERSION,
    requestId,
    jobId,
    type,
    payload,
  } as Extract<ExportWorkerRequest, { type: TType }>
}
