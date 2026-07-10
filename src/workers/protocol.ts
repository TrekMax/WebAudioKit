import type {
  AnalysisOptions,
  StftPreviewResult,
} from '../audio/analysis'
import type { WaveformPyramid } from '../audio/peaks'

export const WORKER_PROTOCOL_VERSION = 1 as const

export type WorkerProtocolVersion = typeof WORKER_PROTOCOL_VERSION

export interface AnalyzePayload {
  readonly channels: Float32Array[]
  readonly options: AnalysisOptions
}

export interface BuildPeaksPayload {
  readonly assetId: string
  readonly channels: Float32Array[]
  readonly baseBlockSize?: number
}

export interface CancelPayload {
  readonly targetJobId: string
}

export interface CancelResult {
  readonly targetJobId: string
  readonly cancelled: boolean
}

interface WorkerRequestEnvelope<TType extends string, TPayload> {
  readonly protocolVersion: WorkerProtocolVersion
  readonly requestId: string
  readonly jobId: string
  readonly type: TType
  readonly payload: TPayload
}

export type AnalyzeRequest = WorkerRequestEnvelope<'analyze', AnalyzePayload>
export type BuildPeaksRequest = WorkerRequestEnvelope<'build-peaks', BuildPeaksPayload>
export type CancelRequest = WorkerRequestEnvelope<'cancel', CancelPayload>

export type AnalysisWorkerRequest =
  | AnalyzeRequest
  | BuildPeaksRequest
  | CancelRequest

interface WorkerResponseEnvelope<TType extends string> {
  readonly protocolVersion: WorkerProtocolVersion
  readonly requestId: string
  readonly jobId: string
  readonly type: TType
}

export type AcceptedResponse = WorkerResponseEnvelope<'accepted'>

export interface ProgressResponse extends WorkerResponseEnvelope<'progress'> {
  readonly completed: number
  readonly total: number
}

export interface ResultResponse<TPayload = AnalysisWorkerResult>
  extends WorkerResponseEnvelope<'result'> {
  readonly payload: TPayload
}

export type CancelledResponse = WorkerResponseEnvelope<'cancelled'>

export interface WorkerErrorData {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
}

export interface ErrorResponse extends WorkerResponseEnvelope<'error'> {
  readonly error: WorkerErrorData
}

export type AnalysisWorkerResult = StftPreviewResult | WaveformPyramid | CancelResult

export type AnalysisWorkerResponse<TPayload = AnalysisWorkerResult> =
  | AcceptedResponse
  | ProgressResponse
  | ResultResponse<TPayload>
  | CancelledResponse
  | ErrorResponse

export function isAnalysisWorkerResponse(value: unknown): value is AnalysisWorkerResponse {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as Partial<AnalysisWorkerResponse>
  if (
    candidate.protocolVersion !== WORKER_PROTOCOL_VERSION ||
    typeof candidate.requestId !== 'string' ||
    candidate.requestId.length === 0 ||
    typeof candidate.jobId !== 'string' ||
    candidate.jobId.length === 0
  ) {
    return false
  }

  return (
    candidate.type === 'accepted' ||
    candidate.type === 'progress' ||
    candidate.type === 'result' ||
    candidate.type === 'cancelled' ||
    candidate.type === 'error'
  )
}

export function createRequest<TType extends AnalysisWorkerRequest['type']>(
  requestId: string,
  jobId: string,
  type: TType,
  payload: Extract<AnalysisWorkerRequest, { type: TType }>['payload'],
): Extract<AnalysisWorkerRequest, { type: TType }> {
  return {
    protocolVersion: WORKER_PROTOCOL_VERSION,
    requestId,
    jobId,
    type,
    payload,
  } as Extract<AnalysisWorkerRequest, { type: TType }>
}
