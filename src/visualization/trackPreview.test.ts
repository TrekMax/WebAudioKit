import { describe, expect, it } from 'vitest'

import {
  MIN_TRACK_LANE_HEIGHT,
  buildTrackOverview,
  maximumTrackLaneHeight,
} from './trackPreview'

describe('buildTrackOverview', () => {
  it('creates a bounded multi-channel min/max preview', () => {
    const overview = buildTrackOverview([
      Float32Array.from([-1, -0.5, 0.25, 0.75, -0.25, 1, 0.5, 0]),
      Float32Array.from([0.5, 0.25, -0.75, -0.5, 0.125, 0.25, -1, 0.8]),
    ], 4, 8)

    expect(Array.from(overview.mins)).toEqual([-1, -0.75, -0.25, -1])
    expect(Array.from(overview.maxs.slice(0, 3))).toEqual([0.5, 0.75, 1])
    expect(overview.maxs[3]).toBeCloseTo(0.8)
  })

  it('returns silence for empty input and rejects unbounded dimensions', () => {
    expect(Array.from(buildTrackOverview([], 3).maxs)).toEqual([0, 0, 0])
    expect(() => buildTrackOverview([new Float32Array(1)], 0)).toThrow(RangeError)
    expect(() => buildTrackOverview([new Float32Array(1)], 5_000)).toThrow(RangeError)
  })

  it('caps two lanes and preview chrome within 60% of the viewport', () => {
    expect(maximumTrackLaneHeight(1_000)).toBe(264)
    expect(maximumTrackLaneHeight(400)).toBe(84)
    expect(maximumTrackLaneHeight(100)).toBe(MIN_TRACK_LANE_HEIGHT)
    expect(maximumTrackLaneHeight(Number.NaN)).toBe(MIN_TRACK_LANE_HEIGHT)
  })
})
