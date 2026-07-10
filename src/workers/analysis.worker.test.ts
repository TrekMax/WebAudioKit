import { describe, expect, it } from 'vitest'

import {
  computeStftPreview,
  type ChannelBatchAnalysisOptions,
  type MultiChannelStftPreviewResult,
  type StftPreviewResult,
} from '../audio/analysis'
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

function indexOfMaximum(values: Float32Array): number {
  let maximumIndex = 0
  for (let index = 1; index < values.length; index += 1) {
    if ((values[index] ?? -Infinity) > (values[maximumIndex] ?? -Infinity)) {
      maximumIndex = index
    }
  }
  return maximumIndex
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

  it('analyzes selected channels in one job and transfers every result once', async () => {
    const collector = responseCollector()
    const runtime = createAnalysisWorkerRuntime(collector.post, {
      yieldToEventLoop: () => Promise.resolve(),
      now: () => 1_000,
    })
    const fftSize = 64
    const channels = Array.from(
      { length: 4 },
      (_, channelIndex) => Float32Array.from(
        { length: fftSize },
        (_, sampleIndex) => Math.sin(
          (2 * Math.PI * (channelIndex + 1) * 4 * sampleIndex) / fftSize,
        ),
      ),
    )
    const options = {
      sampleRate: 48_000,
      fftSize,
      hopSize: fftSize,
      frameCount: 1,
      minDb: -120,
      maxDb: 0,
      // The untrusted boundary must normalize this obsolete/ambiguous field.
      channelMode: { kind: 'mix' },
    } as unknown as ChannelBatchAnalysisOptions
    const request = createRequest(
      'request-channels',
      'job-channels',
      'analyze-channels',
      { channels, channelIndices: [3, 0, 2], options },
    )

    await runtime.handleMessage(request)

    const terminal = terminalResponses(collector.responses)
    expect(terminal).toHaveLength(1)
    if (terminal[0]?.type !== 'result' || !('results' in terminal[0].payload)) {
      throw new Error('Expected a multi-channel analysis result')
    }
    const result = terminal[0].payload as MultiChannelStftPreviewResult
    expect(result.results.map(({ channelIndex }) => channelIndex)).toEqual([
      3, 0, 2,
    ])
    expect(result.results.map(({ preview }) => preview.channelMode)).toEqual([
      { kind: 'channel', index: 3 },
      { kind: 'channel', index: 0 },
      { kind: 'channel', index: 2 },
    ])
    expect(result.results.map(({ preview }) => (
      indexOfMaximum(preview.valuesDbfs)
    ))).toEqual([16, 4, 12])

    const first = result.results[0]?.preview
    if (first === undefined) {
      throw new Error('Expected a first channel preview')
    }
    expect(result.results[1]?.preview.frameIndices).toBe(first.frameIndices)
    expect(collector.responses.at(-1)?.transfer).toEqual(expect.arrayContaining([
      first.frameIndices.buffer,
      first.timesSeconds.buffer,
      first.frequenciesHz.buffer,
      ...result.results.map(({ preview }) => preview.valuesDbfs.buffer),
    ]))
    expect(collector.responses.at(-1)?.transfer).toHaveLength(6)
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

  it('lets cancellation win between channels in a batch job', async () => {
    const collector = responseCollector()
    const releases: Array<() => void> = []
    const runtime = createAnalysisWorkerRuntime(collector.post, {
      yieldToEventLoop: () => new Promise<void>((resolve) => releases.push(resolve)),
      now: () => 1_000,
    })
    const request = createRequest(
      'request-cancel-channels',
      'job-cancel-channels',
      'analyze-channels',
      {
        channels: [new Float32Array(8), new Float32Array(8)],
        channelIndices: [0, 1],
        options: { sampleRate: 8, fftSize: 8, frameCount: 1 },
      },
    )
    const running = runtime.handleMessage(request)

    releases.shift()?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(releases).toHaveLength(1)

    const cancelRequest = createRequest(
      'request-cancel-channels-command',
      'job-cancel-channels-command',
      'cancel',
      { targetJobId: request.jobId },
    )
    await runtime.handleMessage(cancelRequest)
    releases.shift()?.()
    await running

    expect(terminalResponses(collector.responses).filter(
      (response) => response.requestId === request.requestId,
    )).toEqual([{
      protocolVersion: WORKER_PROTOCOL_VERSION,
      requestId: request.requestId,
      jobId: request.jobId,
      type: 'cancelled',
    }])
  })

  it('rejects empty, duplicate, and out-of-range channel selections', async () => {
    const collector = responseCollector()
    const runtime = createAnalysisWorkerRuntime(collector.post, {
      yieldToEventLoop: () => Promise.resolve(),
    })
    const selections = [[], [0, 0], [2]]

    for (let index = 0; index < selections.length; index += 1) {
      await runtime.handleMessage(createRequest(
        `request-invalid-channels-${index}`,
        `job-invalid-channels-${index}`,
        'analyze-channels',
        {
          channels: [new Float32Array(8), new Float32Array(8)],
          channelIndices: selections[index] ?? [],
          options: { sampleRate: 8, fftSize: 8, frameCount: 1 },
        },
      ))
    }

    const errors = terminalResponses(collector.responses)
    expect(errors).toHaveLength(3)
    expect(errors.map((response) => (
      response.type === 'error' ? response.error.code : response.type
    ))).toEqual([
      'ANALYSIS_INVALID_REQUEST',
      'ANALYSIS_INVALID_REQUEST',
      'ANALYSIS_INVALID_REQUEST',
    ])
    expect(errors.map((response) => (
      response.type === 'error' ? response.error.message : ''
    ))).toEqual([
      'At least one analysis channel index is required',
      'Analysis channel indices must be unique',
      'Selected analysis channel is out of range',
    ])
  })

  it('rejects a multi-channel request without an explicit frame count', async () => {
    const collector = responseCollector()
    const runtime = createAnalysisWorkerRuntime(collector.post, {
      yieldToEventLoop: () => Promise.resolve(),
    })

    await runtime.handleMessage({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      requestId: 'request-missing-frame-count',
      jobId: 'job-missing-frame-count',
      type: 'analyze-channels',
      payload: {
        channels: [new Float32Array(8)],
        channelIndices: [0],
        options: { sampleRate: 8, fftSize: 8 },
      },
    })

    expect(terminalResponses(collector.responses)).toEqual([{
      protocolVersion: WORKER_PROTOCOL_VERSION,
      requestId: 'request-missing-frame-count',
      jobId: 'job-missing-frame-count',
      type: 'error',
      error: {
        code: 'ANALYSIS_INVALID_REQUEST',
        message: 'Multi-channel analysis requires an explicit frameCount',
        retryable: false,
      },
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
