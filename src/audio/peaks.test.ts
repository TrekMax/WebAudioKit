import { describe, expect, it } from 'vitest'

import {
  DEFAULT_PEAK_BLOCK_SIZE,
  PeakBuildCancelledError,
  buildPeakPyramid,
} from './peaks'

describe('waveform peak pyramid', () => {
  it('uses 256-sample base blocks and never pads a positive tail with zero', async () => {
    const samples = new Float32Array(DEFAULT_PEAK_BLOCK_SIZE + 1)
    const negativeSamples = new Float32Array(DEFAULT_PEAK_BLOCK_SIZE + 1)
    samples.fill(0.5)
    samples[samples.length - 1] = 0.75
    negativeSamples.fill(-0.5)
    negativeSamples[negativeSamples.length - 1] = -0.75

    const pyramid = await buildPeakPyramid(
      [samples, negativeSamples],
      { assetId: 'asset-a' },
    )

    expect(pyramid).toMatchObject({
      assetId: 'asset-a',
      sourceLength: DEFAULT_PEAK_BLOCK_SIZE + 1,
      baseBlockSize: DEFAULT_PEAK_BLOCK_SIZE,
    })
    expect(pyramid.levels).toHaveLength(2)
    expect(pyramid.levels[0]?.samplesPerBlock).toBe(DEFAULT_PEAK_BLOCK_SIZE)
    expect(Array.from(pyramid.levels[0]?.channels[0]?.mins ?? [])).toEqual([
      0.5,
      0.75,
    ])
    expect(Array.from(pyramid.levels[0]?.channels[0]?.maxs ?? [])).toEqual([
      0.5,
      0.75,
    ])
    expect(Array.from(pyramid.levels[1]?.channels[0]?.mins ?? [])).toEqual([0.5])
    expect(Array.from(pyramid.levels[1]?.channels[0]?.maxs ?? [])).toEqual([0.75])
    expect(Array.from(pyramid.levels[0]?.channels[1]?.mins ?? [])).toEqual([
      -0.5,
      -0.75,
    ])
    expect(Array.from(pyramid.levels[0]?.channels[1]?.maxs ?? [])).toEqual([
      -0.5,
      -0.75,
    ])
  })

  it('preserves extrema through every 2:1 level for each channel', async () => {
    const left = new Float32Array(1_025)
    const right = new Float32Array(1_025)
    left[300] = -1
    left[1_024] = 0.9
    right[10] = -0.25
    right[700] = 0.625

    const pyramid = await buildPeakPyramid([left, right], { assetId: 'stereo' })

    expect(pyramid.levels.map((level) => level.channels[0]?.mins.length)).toEqual([
      5,
      3,
      2,
      1,
    ])
    const overview = pyramid.levels.at(-1)
    expect(overview?.samplesPerBlock).toBe(DEFAULT_PEAK_BLOCK_SIZE * 8)
    expect(overview?.channels[0]?.mins[0]).toBe(-1)
    expect(overview?.channels[0]?.maxs[0]).toBeCloseTo(0.9)
    expect(overview?.channels[1]?.mins[0]).toBe(-0.25)
    expect(overview?.channels[1]?.maxs[0]).toBe(0.625)
  })

  it('sanitizes non-finite decoded samples at the analysis boundary', async () => {
    const samples = Float32Array.of(
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -0.5,
      0.25,
    )

    const pyramid = await buildPeakPyramid(
      [samples],
      { assetId: 'non-finite', baseBlockSize: 2 },
    )

    expect(Array.from(pyramid.levels[0]?.channels[0]?.mins ?? [])).toEqual([
      0,
      -0.5,
    ])
    expect(Array.from(pyramid.levels[0]?.channels[0]?.maxs ?? [])).toEqual([
      0,
      0.25,
    ])
  })

  it('reports deterministic block progress and supports cooperative cancellation', async () => {
    let cancel = false
    const progress: Array<{ completed: number; total: number }> = []
    const promise = buildPeakPyramid(
      [new Float32Array(1_024)],
      {
        assetId: 'cancelled',
        yieldEveryBlocks: 1,
      },
      {
        shouldCancel: () => cancel,
        onProgress: (next) => {
          progress.push(next)
          if (next.completed >= 1) {
            cancel = true
          }
        },
        yieldToEventLoop: () => Promise.resolve(),
      },
    )

    await expect(promise).rejects.toBeInstanceOf(PeakBuildCancelledError)
    expect(progress[0]).toEqual({ completed: 0, total: 7 })
    expect(progress[1]).toEqual({ completed: 1, total: 7 })
  })

  it('handles empty PCM and rejects inconsistent channel layouts', async () => {
    await expect(
      buildPeakPyramid([new Float32Array(0)], { assetId: 'empty' }),
    ).resolves.toMatchObject({ sourceLength: 0, levels: [] })

    await expect(
      buildPeakPyramid(
        [new Float32Array(2), new Float32Array(3)],
        { assetId: 'invalid' },
      ),
    ).rejects.toBeInstanceOf(RangeError)
    await expect(
      buildPeakPyramid([], { assetId: 'invalid' }),
    ).rejects.toBeInstanceOf(RangeError)
  })
})
