import { describe, expect, it } from 'vitest'

import type { StftPreviewResult } from '../audio/analysis'
import {
  ExportWorkerCancelledError,
  ExportWorkerClient,
  ExportWorkerError,
  ExportWorkerTerminatedError,
  type ExportWorkerPort,
} from './ExportWorkerClient'
import {
  EXPORT_WORKER_PROTOCOL_VERSION,
  type ExportWorkerRequest,
  type ExportWorkerResponse,
  type SpectrumCsvExportResult,
  type WavExportResult,
} from './exportProtocol'

class FakeWorker implements ExportWorkerPort {
  readonly posted: Array<{
    message: ExportWorkerRequest
    transfer: Transferable[]
  }> = []
  terminated = false
  private readonly messageListeners = new Set<(event: MessageEvent<unknown>) => void>()
  private readonly errorListeners = new Set<(event: ErrorEvent) => void>()

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.posted.push({ message: message as ExportWorkerRequest, transfer })
  }

  terminate(): void {
    this.terminated = true
  }

  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void
  addEventListener(
    type: 'message' | 'error',
    listener: ((event: MessageEvent<unknown>) => void) | ((event: ErrorEvent) => void),
  ): void {
    if (type === 'message') {
      this.messageListeners.add(listener as (event: MessageEvent<unknown>) => void)
    } else {
      this.errorListeners.add(listener as (event: ErrorEvent) => void)
    }
  }

  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void
  removeEventListener(type: 'error', listener: (event: ErrorEvent) => void): void
  removeEventListener(
    type: 'message' | 'error',
    listener: ((event: MessageEvent<unknown>) => void) | ((event: ErrorEvent) => void),
  ): void {
    if (type === 'message') {
      this.messageListeners.delete(listener as (event: MessageEvent<unknown>) => void)
    } else {
      this.errorListeners.delete(listener as (event: ErrorEvent) => void)
    }
  }

  emit(response: ExportWorkerResponse): void {
    for (const listener of this.messageListeners) {
      listener({ data: response } as MessageEvent<unknown>)
    }
  }

  crash(message: string): void {
    for (const listener of this.errorListeners) {
      listener({ message } as ErrorEvent)
    }
  }
}

function createIdFactory(): (kind: 'request' | 'job') => string {
  const counters = { request: 0, job: 0 }
  return (kind) => {
    counters[kind] += 1
    return `${kind}-${counters[kind]}`
  }
}

type ResponseBody<T> = T extends ExportWorkerResponse
  ? Omit<T, 'protocolVersion' | 'requestId' | 'jobId'>
  : never

function responseFor(
  request: ExportWorkerRequest,
  response: ResponseBody<ExportWorkerResponse>,
): ExportWorkerResponse {
  return {
    protocolVersion: EXPORT_WORKER_PROTOCOL_VERSION,
    requestId: request.requestId,
    jobId: request.jobId,
    ...response,
  } as ExportWorkerResponse
}

function wavResult(): WavExportResult {
  const bytes = new ArrayBuffer(46)
  return {
    kind: 'wav',
    bytes,
    mimeType: 'audio/wav',
    fileExtension: 'wav',
    info: {
      format: 'pcm16',
      sampleRate: 8_000,
      numberOfChannels: 1,
      frameCount: 1,
      dataBytes: 2,
      totalBytes: 46,
      peak: 0,
      gain: 1,
    },
  }
}

function stftResult(): StftPreviewResult {
  return {
    sampleRate: 8,
    fftSize: 8,
    hopSize: 2,
    frameCount: 1,
    totalFrameCount: 1,
    firstFrame: 0,
    binCount: 2,
    window: 'hann',
    channelMode: { kind: 'mix' },
    range: { start: 0, end: 8 },
    minDb: -100,
    maxDb: 0,
    frameIndices: Float64Array.of(0),
    timesSeconds: Float64Array.of(0.5),
    frequenciesHz: Float64Array.of(0, 4),
    valuesDbfs: Float32Array.of(-12, -6),
  }
}

function csvResult(): SpectrumCsvExportResult {
  return {
    kind: 'spectrum-csv',
    bytes: new TextEncoder().encode('a,b\n').buffer,
    mimeType: 'text/csv;charset=utf-8',
    fileExtension: 'csv',
    rowCount: 1,
  }
}

function createClient(): { client: ExportWorkerClient; worker: FakeWorker } {
  const worker = new FakeWorker()
  const client = new ExportWorkerClient({
    worker,
    idFactory: createIdFactory(),
  })
  return { client, worker }
}

describe('ExportWorkerClient', () => {
  it('transfers disposable planar PCM copies and delivers progress and WAV bytes', async () => {
    const { client, worker } = createClient()
    const channel = Float32Array.of(0.25, -0.5)
    const progress: number[] = []
    const job = client.startEncodeWav(
      {
        sampleRate: 8_000,
        channels: [channel],
        format: 'pcm16',
        range: { start: 0, end: 1 },
      },
      { onProgress: ({ ratio }) => progress.push(ratio) },
    )
    const request = worker.posted[0]?.message
    if (request?.type !== 'wav/encode') {
      throw new Error('Expected a WAV export request')
    }

    expect(request).toMatchObject({
      protocolVersion: EXPORT_WORKER_PROTOCOL_VERSION,
      requestId: job.requestId,
      jobId: job.jobId,
    })
    const transferredChannel = request.payload.channels[0]
    expect(transferredChannel).toBe(channel)
    expect(Array.from(transferredChannel ?? [])).toEqual(Array.from(channel))
    expect(worker.posted[0]?.transfer).toEqual([channel.buffer])
    expect(channel.byteLength).toBe(8)

    worker.emit(responseFor(request, { type: 'accepted' }))
    worker.emit(responseFor(request, { type: 'progress', completed: 1, total: 4 }))
    const result = wavResult()
    worker.emit(responseFor(request, { type: 'result', payload: result }))

    await expect(job.result).resolves.toBe(result)
    expect(progress).toEqual([0.25])
    client.terminate()
  })

  it('copies and transfers STFT arrays without detaching the view result', async () => {
    const { client, worker } = createClient()
    const source = stftResult()
    const job = client.startEncodeSpectrumCsv({ result: source })
    const request = worker.posted[0]?.message
    if (request?.type !== 'csv/encode-spectrum') {
      throw new Error('Expected a spectrum CSV request')
    }

    const copied = request.payload.result
    expect(copied.valuesDbfs).not.toBe(source.valuesDbfs)
    expect(Array.from(copied.valuesDbfs)).toEqual(Array.from(source.valuesDbfs))
    expect(worker.posted[0]?.transfer).toEqual([
      copied.frameIndices.buffer,
      copied.timesSeconds.buffer,
      copied.frequenciesHz.buffer,
      copied.valuesDbfs.buffer,
    ])
    expect(source.valuesDbfs.byteLength).toBe(8)

    const result = csvResult()
    worker.emit(responseFor(request, { type: 'result', payload: result }))
    await expect(job.result).resolves.toBe(result)
    client.terminate()
  })

  it('cancels locally by job ID and maps structured worker errors', async () => {
    const { client, worker } = createClient()
    const cancelled = client.startEncodeWav({
      sampleRate: 8_000,
      channels: [new Float32Array(2)],
    })
    const cancellation = expect(cancelled.result).rejects.toBeInstanceOf(
      ExportWorkerCancelledError,
    )

    expect(client.cancel(cancelled.jobId)).toBe(true)
    expect(client.cancel(cancelled.jobId)).toBe(false)
    expect(worker.posted[1]?.message).toMatchObject({
      type: 'job/cancel',
      payload: { targetJobId: cancelled.jobId },
    })
    await cancellation

    const failed = client.startEncodeSpectrumCsv({ result: stftResult() })
    const request = worker.posted.at(-1)?.message
    if (request === undefined) {
      throw new Error('Expected an export request')
    }
    worker.emit(responseFor(request, {
      type: 'error',
      error: {
        code: 'EXPORT_TOO_LARGE',
        message: 'too large',
        retryable: false,
      },
    }))

    const failure = await failed.result.catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ExportWorkerError)
    expect(failure).toMatchObject({
      code: 'EXPORT_TOO_LARGE',
      retryable: false,
      message: 'too large',
    })
    client.terminate()
  })

  it('rejects outstanding jobs on crashes and termination and becomes inert', async () => {
    const { client, worker } = createClient()
    const crashed = client.startEncodeWav({
      sampleRate: 8_000,
      channels: [new Float32Array(2)],
    })
    worker.crash('boom')
    await expect(crashed.result).rejects.toMatchObject({
      code: 'EXPORT_WORKER_CRASHED',
      message: 'boom',
    })

    const pending = client.startEncodeSpectrumCsv({ result: stftResult() })
    const terminated = expect(pending.result).rejects.toBeInstanceOf(
      ExportWorkerTerminatedError,
    )
    client.terminate()
    await terminated
    expect(worker.terminated).toBe(true)
    expect(() => client.startEncodeWav({
      sampleRate: 8_000,
      channels: [new Float32Array(1)],
    })).toThrow(ExportWorkerTerminatedError)
  })
})
