import { describe, expect, it } from 'vitest'

import {
  EQ_BAND_COUNTS,
  EQ_GAIN_MAX_DB,
  EQ_GAIN_MIN_DB,
} from '../audio/filterGraph'
import {
  EQ_CURVE_VIEWBOX,
  buildEqCurvePath,
  buildEqCurvePoints,
  eqFrequencyToX,
  eqGainToY,
  eqYToGain,
} from './eqCurve'

describe('EQ curve coordinates', () => {
  it('maps logarithmic band frequencies from left to right', () => {
    const points = buildEqCurvePoints([-6, -3, 0, 3, 6, 0, -2, 1, 0, -1])

    expect(points).toHaveLength(10)
    expect(points.every((point, index) => index === 0 || point.x > (points[index - 1]?.x ?? 0))).toBe(true)
    expect(eqFrequencyToX(20)).toBe(EQ_CURVE_VIEWBOX.left)
    expect(eqFrequencyToX(20_000)).toBe(EQ_CURVE_VIEWBOX.width - EQ_CURVE_VIEWBOX.right)
  })

  it('builds the expected number of points for every band preset', () => {
    for (const bandCount of EQ_BAND_COUNTS) {
      const points = buildEqCurvePoints(Array.from({ length: bandCount }, () => 0), bandCount)

      expect(points).toHaveLength(bandCount)
      expect(points.every((point, index) => index === 0 || point.x > (points[index - 1]?.x ?? 0))).toBe(true)
    }
  })

  it('round-trips gains and clamps pointer positions to the safe range', () => {
    for (const gain of [-24, -12, 0, 8.5, 24]) {
      expect(eqYToGain(eqGainToY(gain))).toBe(gain)
    }
    expect(eqYToGain(-1_000)).toBe(EQ_GAIN_MAX_DB)
    expect(eqYToGain(1_000)).toBe(EQ_GAIN_MIN_DB)
  })

  it('builds a smooth path through every band point', () => {
    const points = buildEqCurvePoints([0, 2, 4, 0, -3, -6, 0, 3, 1, 0])
    const path = buildEqCurvePath(points)

    expect(path).toContain(`M ${points[0]?.x} ${points[0]?.y}`)
    expect(path.match(/ C /g)).toHaveLength(points.length - 1)
    expect(path).toContain(`${points.at(-1)?.x} ${points.at(-1)?.y}`)
  })
})
