import { describe, expect, it } from 'vitest'

import type { StftPreviewResult } from '../audio/analysis'
import {
  EXPORT_WORKER_PROTOCOL_VERSION,
  createExportRequest,
  type ExportWorkerResponse,
} from './exportProtocol'
import {
  createExportWorkerRuntime,
  type ExportWorkerPostMessage,
} from './export.worker'

interface PostedResponse {
  readonly response: ExportWorkerResponse
  readonly transfer: Transferable[]
}

function responseCollector(): {
  readonly responses: PostedResponse[]
  readonly post: ExportWorkerPostMessage
} {
  const responses: PostedResponse[] = []
  return {
    responses,
    post: (response, transfer = []) => {
      responses.push({ response, transfer })
    },
  }
}

function terminalResponses(
  responses: readonly PostedResponse[],
): ExportWorkerResponse[] {
  return responses
    .map(({ response }) => response)
    .filter((response) => (
      response.type === 'result' ||
      response.type === 'cancelled' ||
      response.type === 'error'
    ))
}

function stftResult(frameCount = 2): StftPreviewResult {
  const binCount = 2
  return {
    sampleRate: 8_000,
    fftSize: 8,
    hopSize: 2,
    frameCount,
    totalFrameCount: frameCount,
    firstFrame: 3,
    binCount,
    window: 'hann',
    channelMode: { kind: 'mix' },
    range: { start: 0, end: Math.max(1, frameCount * 2) },
    minDb: -100,
    maxDb: 0,
    frameIndices: Float64Array.from(
      { length: frameCount },
      (_, index) => index + 3,
    ),
    timesSeconds: Float64Array.from(
      { length: frameCount },
      (_, index) => 0.125 * (index + 1),
    ),
    frequenciesHz: Float64Array.of(0, 4_000.5),
    valuesDbfs: Float32Array.from(
      { length: frameCount * binCount },
      (_, index) => [-12.3456, -0.1254, -100, -6, -24, -48][index] ?? -80,
    ),
  }
}

describe('export worker runtime', () => {
  it('encodes, normalizes, reports, and transfers an exact WAV selection', async () => {
    const collector = responseCollector()
    const runtime = createExportWorkerRuntime(collector.post, {
      yieldToEventLoop: () => Promise.resolve(),
      now: () => 1_000,
      wavChunkFrames: 1,
    })
    const request = createExportRequest('request-wav', 'job-wav', 'wav/encode', {
      sampleRate: 48_000,
      channels: [Float32Array.of(0.9, 0.25, -0.125, 0.8)],
      format: 'pcm16',
      range: { start: 1, end: 3 },
      normalize: true,
      targetPeakDbfs: -6.020599913279624,
    })

    await runtime.handleMessage(request)

    expect(collector.responses[0]?.response.type).toBe('accepted')
    const progress = collector.responses
      .map(({ response }) => response)
      .filter((response) => response.type === 'progress')
    expect(progress[0]).toMatchObject({ completed: 0, total: 4 })
    expect(progress.at(-1)).toMatchObject({ completed: 4, total: 4 })

    const terminal = terminalResponses(collector.responses)
    expect(terminal).toHaveLength(1)
    if (terminal[0]?.type !== 'result' || !('kind' in terminal[0].payload)) {
      throw new Error('Expected a WAV export result')
    }
    const result = terminal[0].payload
    if (result.kind !== 'wav') {
      throw new Error('Expected a WAV export result')
    }
    const view = new DataView(result.bytes)
    expect(result.info).toMatchObject({
      format: 'pcm16',
      sampleRate: 48_000,
      numberOfChannels: 1,
      frameCount: 2,
      dataBytes: 4,
      totalBytes: 48,
      peak: 0.25,
      gain: 2,
    })
    expect(view.getUint32(4, true)).toBe(40)
    expect(view.getUint32(40, true)).toBe(4)
    expect(view.getInt16(44, true)).toBe(16_384)
    expect(view.getInt16(46, true)).toBe(-8_192)
    expect(collector.responses.at(-1)?.transfer).toEqual([result.bytes])
  })

  it('encodes spectrum rows with stable precision and transfers UTF-8 bytes', async () => {
    const collector = responseCollector()
    const runtime = createExportWorkerRuntime(collector.post, {
      yieldToEventLoop: () => Promise.resolve(),
      csvRowsPerBatch: 2,
    })
    const request = createExportRequest(
      'request-csv',
      'job-csv',
      'csv/encode-spectrum',
      { result: stftResult() },
    )

    await runtime.handleMessage(request)

    const terminal = terminalResponses(collector.responses)
    if (terminal[0]?.type !== 'result' || !('kind' in terminal[0].payload)) {
      throw new Error('Expected a CSV export result')
    }
    const result = terminal[0].payload
    if (result.kind !== 'spectrum-csv') {
      throw new Error('Expected a CSV export result')
    }
    expect(new TextDecoder().decode(result.bytes)).toBe(
      'time_seconds,frame_index,frequency_hz,bin_index,magnitude_dbfs\n' +
      '0.125000000,3,0.000000,0,-12.346\n' +
      '0.125000000,3,4000.500000,1,-0.125\n' +
      '0.250000000,4,0.000000,0,-100.000\n' +
      '0.250000000,4,4000.500000,1,-6.000\n',
    )
    expect(result.rowCount).toBe(4)
    expect(collector.responses.at(-1)?.transfer).toEqual([result.bytes])
  })

  it('lets cancellation win between CSV batches and emits one terminal response', async () => {
    const collector = responseCollector()
    const releases: Array<() => void> = []
    const runtime = createExportWorkerRuntime(collector.post, {
      yieldToEventLoop: () => new Promise<void>((resolve) => releases.push(resolve)),
      csvRowsPerBatch: 2,
    })
    const request = createExportRequest(
      'request-cancelled',
      'job-cancelled',
      'csv/encode-spectrum',
      { result: stftResult(3) },
    )
    const running = runtime.handleMessage(request)

    expect(releases).toHaveLength(1)
    releases.shift()?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(releases).toHaveLength(1)

    const cancelRequest = createExportRequest(
      'request-cancel',
      'job-cancel',
      'job/cancel',
      { targetJobId: request.jobId },
    )
    await runtime.handleMessage(cancelRequest)
    releases.shift()?.()
    await running

    const terminals = terminalResponses(collector.responses)
    expect(terminals.filter((response) => response.requestId === request.requestId)).toEqual([{
      protocolVersion: EXPORT_WORKER_PROTOCOL_VERSION,
      requestId: request.requestId,
      jobId: request.jobId,
      type: 'cancelled',
    }])
    expect(terminals.filter(
      (response) => response.requestId === cancelRequest.requestId,
    )).toEqual([{
      protocolVersion: EXPORT_WORKER_PROTOCOL_VERSION,
      requestId: cancelRequest.requestId,
      jobId: cancelRequest.jobId,
      type: 'result',
      payload: { targetJobId: request.jobId, cancelled: true },
    }])
  })

  it('returns structured errors for bad protocol versions and invalid payloads', async () => {
    const collector = responseCollector()
    const runtime = createExportWorkerRuntime(collector.post, {
      yieldToEventLoop: () => Promise.resolve(),
    })

    await runtime.handleMessage({
      protocolVersion: 99,
      requestId: 'request-bad-version',
      jobId: 'job-bad-version',
      type: 'wav/encode',
      payload: {},
    })
    await runtime.handleMessage(createExportRequest(
      'request-bad-wav',
      'job-bad-wav',
      'wav/encode',
      {
        sampleRate: 48_000,
        channels: [new Float32Array(1), new Float32Array(2)],
      },
    ))

    const errors = terminalResponses(collector.responses)
    expect(errors).toHaveLength(2)
    expect(errors[0]).toMatchObject({
      type: 'error',
      error: { code: 'EXPORT_PROTOCOL_VERSION', retryable: false },
    })
    expect(errors[1]).toMatchObject({
      type: 'error',
      error: { code: 'EXPORT_INVALID_REQUEST', retryable: false },
    })
  })
})
