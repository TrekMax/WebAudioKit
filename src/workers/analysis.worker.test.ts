import { describe, expect, it } from 'vitest'

import { computeStftPreview, type StftPreviewResult } from '../audio/analysis'
import {
  WORKER_PROTOCOL_VERSION,
  createRequest,
  type AnalysisWorkerResponse,
} from './protocol'
import {
  createAnalysisWorkerRuntime,
  type WorkerPostMessage,
} from './analysis.worker'

interface PostedResponse {
  readonly response: AnalysisWorkerResponse
  readonly transfer: Transferable[]
}

function responseCollector(): {
  readonly responses: PostedResponse[]
  readonly post: WorkerPostMessage
} {
  const responses: PostedResponse[] = []
  return {
    responses,
    post: (response, transfer = []) => {
      responses.push({ response, transfer })
    },
  }
}

function terminalResponses(responses: readonly PostedResponse[]): AnalysisWorkerResponse[] {
  return responses
    .map(({ response }) => response)
    .filter((response) => (
      response.type === 'result' ||
      response.type === 'cancelled' ||
      response.type === 'error'
    ))
}

describe('analysis worker runtime', () => {
  it('combines consecutive STFT batches without changing the public analysis result', async () => {
    const collector = responseCollector()
    const runtime = createAnalysisWorkerRuntime(collector.post, {
      yieldToEventLoop: () => Promise.resolve(),
      now: () => 1_000,
    })
    const channel = Float32Array.from(
      { length: 80 },
      (_, index) => Math.sin((2 * Math.PI * index) / 8),
    )
    const options = {
      sampleRate: 8,
      fftSize: 8,
      hopSize: 2,
      frameCount: 40,
      minDb: -120,
      maxDb: 0,
    } as const
    const request = createRequest('request-1', 'job-1', 'analyze', {
      channels: [channel],
      options,
    })

    await runtime.handleMessage(request)

    expect(collector.responses[0]?.response.type).toBe('accepted')
    const terminal = terminalResponses(collector.responses)
    expect(terminal).toHaveLength(1)
    expect(terminal[0]?.type).toBe('result')
    if (terminal[0]?.type !== 'result') {
      throw new Error('Expected a worker result')
    }
    const actual = terminal[0].payload as StftPreviewResult
    const expected = computeStftPreview([channel], options)
    expect(Array.from(actual.frameIndices)).toEqual(Array.from(expected.frameIndices))
    expect(Array.from(actual.timesSeconds)).toEqual(Array.from(expected.timesSeconds))
    expect(Array.from(actual.valuesDbfs)).toEqual(Array.from(expected.valuesDbfs))
    expect(collector.responses.at(-1)?.transfer).toEqual(expect.arrayContaining([
      actual.frameIndices.buffer,
      actual.timesSeconds.buffer,
      actual.frequenciesHz.buffer,
      actual.valuesDbfs.buffer,
    ]))
  })

  it('builds and transfers a peak pyramid whose tail contains no synthetic zero', async () => {
    const collector = responseCollector()
    const runtime = createAnalysisWorkerRuntime(collector.post, {
      yieldToEventLoop: () => Promise.resolve(),
    })
    const samples = new Float32Array(257)
    samples.fill(0.25)
    samples[256] = 0.75
    const request = createRequest('request-2', 'job-2', 'build-peaks', {
      assetId: 'asset-a',
      channels: [samples],
    })

    await runtime.handleMessage(request)

    const terminal = terminalResponses(collector.responses)
    if (terminal[0]?.type !== 'result' || !('levels' in terminal[0].payload)) {
      throw new Error('Expected a peak pyramid result')
    }
    const pyramid = terminal[0].payload
    expect(pyramid.levels[0]?.channels[0]?.mins[1]).toBe(0.75)
    expect(pyramid.levels[0]?.channels[0]?.maxs[1]).toBe(0.75)
    expect(collector.responses.at(-1)?.transfer).toHaveLength(4)
  })

  it('lets a cancel message win between exact STFT batches and emits one terminal response', async () => {
    const collector = responseCollector()
    const releases: Array<() => void> = []
    const runtime = createAnalysisWorkerRuntime(collector.post, {
      yieldToEventLoop: () => new Promise<void>((resolve) => releases.push(resolve)),
      now: () => 1_000,
    })
    const request = createRequest('request-3', 'job-3', 'analyze', {
      channels: [new Float32Array(80)],
      options: {
        sampleRate: 8,
        fftSize: 8,
        hopSize: 2,
        frameCount: 40,
      },
    })
    const running = runtime.handleMessage(request)

    expect(releases).toHaveLength(1)
    releases.shift()?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(releases).toHaveLength(1)

    const cancelRequest = createRequest(
      'request-cancel-3',
      'job-cancel-3',
      'cancel',
      { targetJobId: request.jobId },
    )
    await runtime.handleMessage(cancelRequest)
    releases.shift()?.()
    await running

    const terminals = terminalResponses(collector.responses)
    expect(terminals.filter((response) => response.requestId === request.requestId)).toEqual([{
      protocolVersion: WORKER_PROTOCOL_VERSION,
      requestId: request.requestId,
      jobId: request.jobId,
      type: 'cancelled',
    }])
    expect(terminals.filter((response) => response.requestId === cancelRequest.requestId)).toEqual([{
      protocolVersion: WORKER_PROTOCOL_VERSION,
      requestId: cancelRequest.requestId,
      jobId: cancelRequest.jobId,
      type: 'result',
      payload: { targetJobId: request.jobId, cancelled: true },
    }])
  })

  it('returns structured errors for bad protocol versions and invalid analysis input', async () => {
    const collector = responseCollector()
    const runtime = createAnalysisWorkerRuntime(collector.post, {
      yieldToEventLoop: () => Promise.resolve(),
    })

    await runtime.handleMessage({
      protocolVersion: 99,
      requestId: 'request-bad-version',
      jobId: 'job-bad-version',
      type: 'analyze',
      payload: {},
    })
    await runtime.handleMessage(createRequest(
      'request-bad-options',
      'job-bad-options',
      'analyze',
      {
        channels: [new Float32Array(8)],
        options: { sampleRate: 0, fftSize: 8 },
      },
    ))

    const errors = terminalResponses(collector.responses)
    expect(errors).toHaveLength(2)
    expect(errors[0]).toMatchObject({
      type: 'error',
      error: { code: 'ANALYSIS_PROTOCOL_VERSION', retryable: false },
    })
    expect(errors[1]).toMatchObject({
      type: 'error',
      error: { code: 'ANALYSIS_INVALID_REQUEST', retryable: false },
    })
  })
})
