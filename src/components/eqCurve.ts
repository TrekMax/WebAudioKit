import {
  EQ_BAND_FREQUENCIES_HZ,
  EQ_GAIN_MAX_DB,
  EQ_GAIN_MIN_DB,
} from '../audio/filterGraph'

export const EQ_CURVE_VIEWBOX = {
  width: 260,
  height: 150,
  left: 34,
  right: 8,
  top: 10,
  bottom: 26,
} as const

const EQ_CURVE_MIN_FREQUENCY_HZ = 20
const EQ_CURVE_MAX_FREQUENCY_HZ = 20_000
const EQ_GAIN_STEP_DB = 0.5

export interface EqCurvePoint {
  readonly x: number
  readonly y: number
  readonly frequencyHz: number
  readonly gainDb: number
}

export function eqFrequencyToX(frequencyHz: number): number {
  const plotWidth = EQ_CURVE_VIEWBOX.width - EQ_CURVE_VIEWBOX.left - EQ_CURVE_VIEWBOX.right
  const safeFrequency = Math.min(
    EQ_CURVE_MAX_FREQUENCY_HZ,
    Math.max(EQ_CURVE_MIN_FREQUENCY_HZ, frequencyHz),
  )
  const unit = (
    (Math.log10(safeFrequency) - Math.log10(EQ_CURVE_MIN_FREQUENCY_HZ))
    / (Math.log10(EQ_CURVE_MAX_FREQUENCY_HZ) - Math.log10(EQ_CURVE_MIN_FREQUENCY_HZ))
  )
  return EQ_CURVE_VIEWBOX.left + unit * plotWidth
}

export function eqGainToY(gainDb: number): number {
  const plotHeight = EQ_CURVE_VIEWBOX.height - EQ_CURVE_VIEWBOX.top - EQ_CURVE_VIEWBOX.bottom
  const safeGain = Math.min(EQ_GAIN_MAX_DB, Math.max(EQ_GAIN_MIN_DB, gainDb))
  const unit = (safeGain - EQ_GAIN_MIN_DB) / (EQ_GAIN_MAX_DB - EQ_GAIN_MIN_DB)
  return EQ_CURVE_VIEWBOX.top + (1 - unit) * plotHeight
}

export function eqYToGain(y: number): number {
  const plotHeight = EQ_CURVE_VIEWBOX.height - EQ_CURVE_VIEWBOX.top - EQ_CURVE_VIEWBOX.bottom
  const unit = 1 - Math.min(1, Math.max(0, (y - EQ_CURVE_VIEWBOX.top) / plotHeight))
  const gain = EQ_GAIN_MIN_DB + unit * (EQ_GAIN_MAX_DB - EQ_GAIN_MIN_DB)
  return Math.round(gain / EQ_GAIN_STEP_DB) * EQ_GAIN_STEP_DB
}

export function buildEqCurvePoints(gainsDb: readonly number[]): EqCurvePoint[] {
  return EQ_BAND_FREQUENCIES_HZ.map((frequencyHz, index) => {
    const gainDb = gainsDb[index] ?? 0
    return {
      x: eqFrequencyToX(frequencyHz),
      y: eqGainToY(gainDb),
      frequencyHz,
      gainDb,
    }
  })
}

export function buildEqCurvePath(points: readonly EqCurvePoint[]): string {
  const first = points[0]
  if (!first) return ''
  let path = `M ${first.x} ${first.y}`
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]
    const point = points[index]
    if (!previous || !point) continue
    const middleX = (previous.x + point.x) / 2
    path += ` C ${middleX} ${previous.y}, ${middleX} ${point.y}, ${point.x} ${point.y}`
  }
  return path
}
