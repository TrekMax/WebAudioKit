import { describe, expect, it } from 'vitest'

import {
  AnalysisCancelledError,
  DEFAULT_STFT_PREVIEW_FRAME_LIMIT,
  amplitudeToDbfs,
  analyzeSpectrumFrame,
  computeStftPreview,
  mixChannels,
} from './analysis'
import type { WindowFunctionName } from './windows'

function sineWave(
  size: number,
  bin: number,
  amplitude = 1,
): Float32Array {
  return Float32Array.from(
    { length: size },
    (_, index) => amplitude * Math.sin((2 * Math.PI * bin * index) / size),
  )
}

function indexOfMaximum(values: Float32Array): number {
  let maximumIndex = 0
  for (let index = 1; index < values.length; index += 1) {
    if ((values[index] ?? Number.NEGATIVE_INFINITY) > (values[maximumIndex] ?? Number.NEGATIVE_INFINITY)) {
      maximumIndex = index
    }
  }
  return maximumIndex
}

describe('dBFS spectrum calibration', () => {
  it.each<WindowFunctionName>(['hann', 'hamming', 'blackman'])(
    'calibrates a bin-centred sine through the %s coherent gain',
    (window) => {
      const fftSize = 2048
      const targetBin = 64
      const result = analyzeSpectrumFrame(
        sineWave(fftSize, targetBin, 0.5),
        { fftSize, window, minDb: -120, maxDb: 0 },
      )

      expect(indexOfMaximum(result.valuesDbfs)).toBe(targetBin)
      expect(result.valuesDbfs[targetBin]).toBeCloseTo(
        amplitudeToDbfs(0.5),
        3,
      )
    },
  )

  it('reports a 1 kHz peak within one FFT bin', () => {
    const sampleRate = 48_000
    const fftSize = 2048
    const frequencyHz = 1_000
    const input = Float32Array.from(
      { length: fftSize },
      (_, index) => Math.sin((2 * Math.PI * frequencyHz * index) / sampleRate),
    )
    const result = analyzeSpectrumFrame(input, {
      fftSize,
      window: 'hann',
      minDb: -120,
      maxDb: 0,
    })
    const peakFrequency =
      (indexOfMaximum(result.valuesDbfs) * sampleRate) / fftSize

    expect(Math.abs(peakFrequency - frequencyHz)).toBeLessThanOrEqual(
      sampleRate / fftSize,
    )
  })

  it('does not double DC or Nyquist amplitudes', () => {
    const fftSize = 1024
    const amplitude = 0.25
    const dc = Float32Array.from({ length: fftSize }, () => amplitude)
    const nyquist = Float32Array.from(
      { length: fftSize },
      (_, index) => (index % 2 === 0 ? amplitude : -amplitude),
    )

    const dcResult = analyzeSpectrumFrame(dc, { minDb: -120, maxDb: 0 })
    const nyquistResult = analyzeSpectrumFrame(nyquist, {
      minDb: -120,
      maxDb: 0,
    })

    expect(dcResult.valuesDbfs[0]).toBeCloseTo(amplitudeToDbfs(amplitude), 3)
    expect(nyquistResult.valuesDbfs[fftSize / 2]).toBeCloseTo(
      amplitudeToDbfs(amplitude),
      3,
    )
  })

  it('maps silence and non-finite samples to the configured finite floor', () => {
    const input = new Float32Array(512)
    input[0] = Number.NaN
    input[1] = Number.POSITIVE_INFINITY

    const result = analyzeSpectrumFrame(input, { minDb: -90, maxDb: 0 })

    expect(Array.from(result.valuesDbfs).every((value) => value === -90)).toBe(
      true,
    )
  })
})

describe('channel mixing and STFT previews', () => {
  it('uses an equal arithmetic average without exceeding full scale', () => {
    const left = Float32Array.from([1, 0.5, -1, -0.5])
    const right = Float32Array.from([0, -0.5, 1, 0.5])

    expect(Array.from(mixChannels([left, right]))).toEqual([0.5, 0, 0, 0])
  })

  it('returns frame-major bins, frequencies, centre times, and a zero-padded tail', () => {
    const channels = [Float32Array.from({ length: 10 }, (_, index) => index / 10)]
    const result = computeStftPreview(channels, {
      sampleRate: 8,
      fftSize: 8,
      hopSize: 4,
      window: 'hann',
      channelMode: { kind: 'channel', index: 0 },
      range: { start: 2, end: 10 },
      frameCount: 2,
    })

    expect(result.totalFrameCount).toBe(2)
    expect(result.frameCount).toBe(2)
    expect(result.binCount).toBe(5)
    expect(result.valuesDbfs).toHaveLength(10)
    expect(Array.from(result.frameIndices)).toEqual([0, 1])
    expect(Array.from(result.timesSeconds)).toEqual([0.75, 1.25])
    expect(Array.from(result.frequenciesHz)).toEqual([0, 1, 2, 3, 4])
    expect(Array.from(result.valuesDbfs).every(Number.isFinite)).toBe(true)
  })

  it('calibrates the default mixed channel as an average', () => {
    const fftSize = 512
    const tone = sineWave(fftSize, 32)
    const silence = new Float32Array(fftSize)
    const result = computeStftPreview([tone, silence], {
      sampleRate: 48_000,
      fftSize,
      hopSize: fftSize,
      frameCount: 1,
      minDb: -120,
      maxDb: 0,
    })

    expect(result.valuesDbfs[32]).toBeCloseTo(amplitudeToDbfs(0.5), 3)
  })

  it('analyzes an arbitrary eighth source channel without mixing other tracks', () => {
    const fftSize = 512
    const channels = Array.from(
      { length: 8 },
      (_, channelIndex) => sineWave(fftSize, 8 * (channelIndex + 1), 0.5),
    )
    const result = computeStftPreview(channels, {
      sampleRate: 48_000,
      fftSize,
      hopSize: fftSize,
      frameCount: 1,
      channelMode: { kind: 'channel', index: 7 },
      minDb: -120,
      maxDb: 0,
    })

    expect(result.channelMode).toEqual({ kind: 'channel', index: 7 })
    expect(indexOfMaximum(result.valuesDbfs)).toBe(64)
    expect(result.valuesDbfs[64]).toBeCloseTo(amplitudeToDbfs(0.5), 3)
  })

  it('bounds an implicit whole-range preview while retaining source frame indices', () => {
    const hopSize = 2
    const totalFrames = DEFAULT_STFT_PREVIEW_FRAME_LIMIT + 44
    const result = computeStftPreview(
      [new Float32Array(totalFrames * hopSize)],
      { sampleRate: 48_000, fftSize: 8, hopSize },
    )

    expect(result.totalFrameCount).toBe(totalFrames)
    expect(result.frameCount).toBe(DEFAULT_STFT_PREVIEW_FRAME_LIMIT)
    expect(result.frameIndices[0]).toBe(0)
    expect(result.frameIndices[result.frameCount - 1]).toBe(totalFrames - 1)
  })

  it('reports progress and cooperatively cancels between frames', () => {
    let completed = 0

    expect(() =>
      computeStftPreview(
        [new Float32Array(64)],
        {
          sampleRate: 48_000,
          fftSize: 16,
          hopSize: 4,
          frameCount: 8,
        },
        {
          shouldCancel: () => completed === 3,
          onProgress: (nextCompleted) => {
            completed = nextCompleted
          },
        },
      ),
    ).toThrow(AnalysisCancelledError)
    expect(completed).toBe(3)
  })

  it('rejects invalid FFT, hop, range, and channel parameters', () => {
    const channel = new Float32Array(2048)

    expect(() =>
      computeStftPreview([channel], { sampleRate: 48_000, fftSize: 1000 }),
    ).toThrow(RangeError)
    expect(() =>
      computeStftPreview([channel], {
        sampleRate: 48_000,
        fftSize: 1024,
        hopSize: 0,
      }),
    ).toThrow(RangeError)
    expect(() =>
      computeStftPreview([channel], {
        sampleRate: 48_000,
        range: { start: 100, end: 50 },
      }),
    ).toThrow(RangeError)
    expect(() =>
      computeStftPreview([channel], {
        sampleRate: 48_000,
        channelMode: { kind: 'channel', index: 1 },
      }),
    ).toThrow(RangeError)
  })
})
