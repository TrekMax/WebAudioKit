import { describe, expect, it } from 'vitest'

import type {
  MultiChannelStftPreviewResult,
  StftPreviewResult,
} from '../audio/analysis'
import type { WaveformPyramid } from '../audio/peaks'
import {
  AnalysisWorkerCancelledError,
  AnalysisWorkerClient,
  AnalysisWorkerError,
  AnalysisWorkerTerminatedError,
  StaleAnalysisWorkerResultError,
  type AnalysisWorkerPort,
} from './AnalysisWorkerClient'
import {
  WORKER_PROTOCOL_VERSION,
  type AnalysisWorkerRequest,
  type AnalysisWorkerResponse,
} from './protocol'

class FakeWorker implements AnalysisWorkerPort {
  readonly posted: Array<{
    message: AnalysisWorkerRequest
    transfer: Transferable[]
  }> = []
  terminated = false
  private readonly messageListeners = new Set<(event: MessageEvent<unknown>) => void>()
  private readonly errorListeners = new Set<(event: ErrorEvent) => void>()

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.posted.push({
      message: message as AnalysisWorkerRequest,
      transfer,
    })
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

  emit(response: AnalysisWorkerResponse): void {
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

type ResponseBody<T> = T extends AnalysisWorkerResponse
  ? Omit<T, 'protocolVersion' | 'requestId' | 'jobId'>
  : never

function responseFor(
  request: AnalysisWorkerRequest,
  response: ResponseBody<AnalysisWorkerResponse>,
): AnalysisWorkerResponse {
  return {
    protocolVersion: WORKER_PROTOCOL_VERSION,
    requestId: request.requestId,
    jobId: request.jobId,
    ...response,
  } as AnalysisWorkerResponse
}

function stftResult(value = -12): StftPreviewResult {
  return {
    sampleRate: 8,
    fftSize: 8,
    hopSize: 2,
    frameCount: 1,
    totalFrameCount: 1,
    firstFrame: 0,
    binCount: 5,
    window: 'hann',
    channelMode: { kind: 'mix' },
    range: { start: 0, end: 8 },
    minDb: -100,
    maxDb: 0,
    frameIndices: Float64Array.of(0),
    timesSeconds: Float64Array.of(0.5),
    frequenciesHz: Float64Array.of(0, 1, 2, 3, 4),
    valuesDbfs: Float32Array.of(value, value, value, value, value),
  }
}

function multiChannelResult(
  channelIndices: readonly number[],
): MultiChannelStftPreviewResult {
  return {
    results: channelIndices.map((channelIndex) => ({
      channelIndex,
      preview: {
        ...stftResult(-12 - channelIndex),
        channelMode: { kind: 'channel', index: channelIndex },
      },
    })),
  }
}

function peakResult(): WaveformPyramid {
  return {
    assetId: 'asset-a',
    sourceLength: 2,
    baseBlockSize: 256,
    levels: [{
      samplesPerBlock: 256,
      channels: [{
        mins: Float32Array.of(-0.5),
        maxs: Float32Array.of(0.5),
      }],
    }],
  }
}

function createClient(): { client: AnalysisWorkerClient; worker: FakeWorker } {
  const worker = new FakeWorker()
  const client = new AnalysisWorkerClient({
    worker,
    idFactory: createIdFactory(),
  })
  return { client, worker }
}

describe('AnalysisWorkerClient', () => {
  it('uses the versioned envelope, transfers PCM, and delivers progress and results', async () => {
    const { client, worker } = createClient()
    const channel = new Float32Array(8)
    const progress: number[] = []
    const job = client.startAnalyze(
      { channels: [channel], options: { sampleRate: 8, fftSize: 8 } },
      { onProgress: ({ ratio }) => progress.push(ratio) },
    )
    const request = worker.posted[0]?.message
    if (request === undefined) {
      throw new Error('Expected an analyze request')
    }

    expect(request).toMatchObject({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      requestId: job.requestId,
      jobId: job.jobId,
      type: 'analyze',
    })
    expect(worker.posted[0]?.transfer).toEqual([channel.buffer])

    worker.emit(responseFor(request, { type: 'accepted' }))
    worker.emit(responseFor(request, { type: 'progress', completed: 1, total: 4 }))
    const result = stftResult()
    worker.emit(responseFor(request, { type: 'result', payload: result }))

    await expect(job.result).resolves.toBe(result)
    expect(progress).toEqual([0.25])
    client.terminate()
  })

  it('submits selected channels as one transferable analysis job', async () => {
    const { client, worker } = createClient()
    const channels = [new Float32Array(8), new Float32Array(8)]
    const progress: number[] = []
    const job = client.startAnalyzeChannels(
      {
        channels,
        channelIndices: [1, 0],
        options: { sampleRate: 8, fftSize: 8, frameCount: 1 },
      },
      { onProgress: ({ ratio }) => progress.push(ratio) },
    )
    const request = worker.posted[0]?.message
    if (request === undefined) {
      throw new Error('Expected an analyze-channels request')
    }

    expect(worker.posted).toHaveLength(1)
    expect(request).toMatchObject({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      requestId: job.requestId,
      jobId: job.jobId,
      type: 'analyze-channels',
      payload: { channelIndices: [1, 0] },
    })
    expect(worker.posted[0]?.transfer).toEqual([
      channels[0]?.buffer,
      channels[1]?.buffer,
    ])

    worker.emit(responseFor(request, {
      type: 'progress',
      completed: 1,
      total: 2,
    }))
    const result = multiChannelResult([1, 0])
    worker.emit(responseFor(request, { type: 'result', payload: result }))

    await expect(job.result).resolves.toBe(result)
    expect(progress).toEqual([0.5])
    client.terminate()
  })

  it('rejects a result payload that does not match the pending request type', async () => {
    const { client, worker } = createClient()
    const job = client.startAnalyzeChannels(
      {
        channels: [new Float32Array(8), new Float32Array(8)],
        channelIndices: [0, 1],
        options: { sampleRate: 8, fftSize: 8, frameCount: 1 },
      },
      { transferChannels: false },
    )
    const request = worker.posted[0]?.message
    if (request === undefined) throw new Error('Expected an analysis request')

    worker.emit(responseFor(request, { type: 'result', payload: stftResult() }))

    await expect(job.result).rejects.toMatchObject({
      name: 'AnalysisWorkerError',
      code: 'ANALYSIS_PROTOCOL_INVALID_RESULT',
      retryable: false,
    })
    client.terminate()
  })

  it('invalidates and cancels an older analysis generation without accepting its result', async () => {
    const { client, worker } = createClient()
    const first = client.startAnalyze(
      { channels: [new Float32Array(8)], options: { sampleRate: 8, fftSize: 8 } },
      { transferChannels: false },
    )
    const firstRejection = expect(first.result).rejects.toBeInstanceOf(
      StaleAnalysisWorkerResultError,
    )
    const second = client.startAnalyze(
      { channels: [new Float32Array(8)], options: { sampleRate: 8, fftSize: 8 } },
      { transferChannels: false },
    )

    await firstRejection
    expect(worker.posted[1]?.message).toMatchObject({
      type: 'cancel',
      payload: { targetJobId: first.jobId },
    })

    const firstRequest = worker.posted[0]?.message
    const secondRequest = worker.posted[2]?.message
    if (firstRequest === undefined || secondRequest === undefined) {
      throw new Error('Expected two analyze requests')
    }
    worker.emit(responseFor(firstRequest, { type: 'result', payload: stftResult(-90) }))
    const currentResult = stftResult(-6)
    worker.emit(responseFor(secondRequest, { type: 'result', payload: currentResult }))

    await expect(second.result).resolves.toBe(currentResult)
    client.terminate()
  })

  it('shares generation invalidation between single and multi-channel analysis', async () => {
    const { client, worker } = createClient()
    const first = client.startAnalyzeChannels(
      {
        channels: [new Float32Array(8), new Float32Array(8)],
        channelIndices: [0, 1],
        options: { sampleRate: 8, fftSize: 8, frameCount: 1 },
      },
      { transferChannels: false },
    )
    const firstRejection = expect(first.result).rejects.toBeInstanceOf(
      StaleAnalysisWorkerResultError,
    )
    const current = client.startAnalyze(
      {
        channels: [new Float32Array(8)],
        options: { sampleRate: 8, fftSize: 8 },
      },
      { transferChannels: false },
    )

    await firstRejection
    expect(worker.posted[1]?.message).toMatchObject({
      type: 'cancel',
      payload: { targetJobId: first.jobId },
    })
    const request = worker.posted[2]?.message
    if (request === undefined) {
      throw new Error('Expected the current analyze request')
    }
    const result = stftResult(-9)
    worker.emit(responseFor(request, { type: 'result', payload: result }))
    await expect(current.result).resolves.toBe(result)
    client.terminate()
  })

  it('keeps analysis and peak generations independent', async () => {
    const { client, worker } = createClient()
    const analysis = client.startAnalyze(
      { channels: [new Float32Array(8)], options: { sampleRate: 8, fftSize: 8 } },
      { transferChannels: false },
    )
    const peaks = client.startBuildPeaks(
      { assetId: 'asset-a', channels: [new Float32Array(2)] },
      { transferChannels: false },
    )
    expect(worker.posted.map(({ message }) => message.type)).toEqual([
      'analyze',
      'build-peaks',
    ])

    const analysisRequest = worker.posted[0]?.message
    const peaksRequest = worker.posted[1]?.message
    if (analysisRequest === undefined || peaksRequest === undefined) {
      throw new Error('Expected analysis and peaks requests')
    }
    worker.emit(responseFor(peaksRequest, { type: 'result', payload: peakResult() }))
    worker.emit(responseFor(analysisRequest, { type: 'result', payload: stftResult() }))

    await expect(peaks.result).resolves.toMatchObject({ assetId: 'asset-a' })
    await expect(analysis.result).resolves.toMatchObject({ fftSize: 8 })
    client.terminate()
  })

  it('cancels by job ID and maps structured worker failures', async () => {
    const { client, worker } = createClient()
    const cancelled = client.startBuildPeaks(
      { assetId: 'asset-a', channels: [new Float32Array(2)] },
      { transferChannels: false },
    )
    const cancelledResult = expect(cancelled.result).rejects.toBeInstanceOf(
      AnalysisWorkerCancelledError,
    )
    expect(client.cancel(cancelled.jobId)).toBe(true)
    expect(client.cancel(cancelled.jobId)).toBe(false)
    await cancelledResult

    const failed = client.startAnalyze(
      { channels: [new Float32Array(8)], options: { sampleRate: 8, fftSize: 8 } },
      { transferChannels: false },
    )
    const request = worker.posted.at(-1)?.message
    if (request === undefined) {
      throw new Error('Expected an analyze request')
    }
    worker.emit(responseFor(request, {
      type: 'error',
      error: {
        code: 'ANALYSIS_INVALID_REQUEST',
        message: 'bad options',
        retryable: false,
      },
    }))

    const failure = await failed.result.catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AnalysisWorkerError)
    expect(failure).toMatchObject({
      code: 'ANALYSIS_INVALID_REQUEST',
      retryable: false,
      message: 'bad options',
    })
    client.terminate()
  })

  it('rejects outstanding jobs on crashes and termination and then becomes inert', async () => {
    const { client, worker } = createClient()
    const crashed = client.startAnalyze(
      { channels: [new Float32Array(8)], options: { sampleRate: 8, fftSize: 8 } },
      { transferChannels: false },
    )
    worker.crash('boom')
    await expect(crashed.result).rejects.toMatchObject({
      code: 'ANALYSIS_WORKER_CRASHED',
      message: 'boom',
    })

    const pending = client.startBuildPeaks(
      { assetId: 'asset-a', channels: [new Float32Array(2)] },
      { transferChannels: false },
    )
    const terminatedResult = expect(pending.result).rejects.toBeInstanceOf(
      AnalysisWorkerTerminatedError,
    )
    client.terminate()
    await terminatedResult
    expect(worker.terminated).toBe(true)
    expect(() => client.startAnalyze({
      channels: [new Float32Array(8)],
      options: { sampleRate: 8, fftSize: 8 },
    })).toThrow(AnalysisWorkerTerminatedError)
  })
})
