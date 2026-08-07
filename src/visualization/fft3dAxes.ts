import type { StftPreviewResult } from '../audio/analysis'

export interface AxisTick {
  readonly unit: number
  readonly value: number
  readonly label: string
}

export interface Fft3DAxisTicks {
  readonly time: readonly AxisTick[]
  readonly frequency: readonly AxisTick[]
  readonly amplitude: readonly AxisTick[]
}

const TARGET_TICK_COUNT = 5

type FrequencyScale = 'linear' | 'log'

interface NumericTick {
  readonly unit: number
  readonly value: number
}

/**
 * Projects a normalized frequency onto an axis that starts at the coordinate
 * origin and extends toward its far endpoint. A larger frequency unit is
 * therefore always farther from the origin, regardless of scene orientation.
 */
export function mapFrequencyUnitFromOrigin(
  unit: number,
  originPosition: number,
  farPosition: number,
): number {
  return originPosition + unit * (farPosition - originPosition)
}

/**
 * Builds presentation-only 3D axis ticks from the exact STFT coordinate space.
 * The returned units are normalized so a renderer can map them onto any scene
 * dimensions without duplicating time, frequency, or dB transforms.
 */
export function buildFft3DAxisTicks(
  result: StftPreviewResult,
  minDb: number,
  maxDb: number,
  frequencyScale: FrequencyScale,
): Fft3DAxisTicks {
  assertDbRange(minDb, maxDb)

  const [firstTime, lastTime] = getTimeBounds(result)
  const timeTicks = createLinearTicks(firstTime, lastTime)
  const amplitudeTicks = createLinearTicks(minDb, maxDb)
  const nyquist = getNyquist(result)
  const frequencyTicks = frequencyScale === 'log'
    ? createLogFrequencyTicks(getLogMinimum(result, nyquist), nyquist)
    : createLinearTicks(0, nyquist)

  return {
    time: timeTicks.map((tick) => ({
      ...tick,
      label: `${formatAdaptive(tick.value, linearStep(firstTime, lastTime))} s`,
    })),
    frequency: frequencyTicks.map((tick) => ({
      ...tick,
      label: formatFrequency(tick.value),
    })),
    amplitude: amplitudeTicks.map((tick) => ({
      ...tick,
      label: `${formatAdaptive(tick.value, linearStep(minDb, maxDb))} dBFS`,
    })),
  }
}

function assertDbRange(minDb: number, maxDb: number): void {
  if (!Number.isFinite(minDb) || !Number.isFinite(maxDb) || minDb >= maxDb) {
    throw new RangeError('3D amplitude range must satisfy finite minDb < maxDb')
  }
}

function getTimeBounds(result: StftPreviewResult): readonly [number, number] {
  const first = result.timesSeconds[0]
  const last = result.timesSeconds.at(-1)
  if (
    typeof first === 'number' &&
    typeof last === 'number' &&
    Number.isFinite(first) &&
    Number.isFinite(last)
  ) {
    return first <= last ? [first, last] : [last, first]
  }

  const sampleRate = Number.isFinite(result.sampleRate) && result.sampleRate > 0
    ? result.sampleRate
    : 1
  const fallbackStart = result.range.start / sampleRate
  const fallbackEnd = result.range.end / sampleRate
  return fallbackStart <= fallbackEnd
    ? [fallbackStart, fallbackEnd]
    : [fallbackEnd, fallbackStart]
}

function getNyquist(result: StftPreviewResult): number {
  const nyquist = result.sampleRate / 2
  if (Number.isFinite(nyquist) && nyquist >= 0) {
    return nyquist
  }

  const lastFrequency = result.frequenciesHz.at(-1)
  return typeof lastFrequency === 'number' &&
    Number.isFinite(lastFrequency) &&
    lastFrequency > 0
    ? lastFrequency
    : 0
}

function getLogMinimum(result: StftPreviewResult, nyquist: number): number {
  let smallestPositive = Number.POSITIVE_INFINITY
  for (const frequency of result.frequenciesHz) {
    if (Number.isFinite(frequency) && frequency > 0) {
      smallestPositive = Math.min(smallestPositive, frequency)
    }
  }

  const availableMinimum = Number.isFinite(smallestPositive)
    ? smallestPositive
    : nyquist
  if (nyquist <= 0) {
    return 0
  }
  if (nyquist <= 20) {
    return Math.min(availableMinimum, nyquist)
  }
  return Math.min(nyquist, Math.max(20, availableMinimum))
}

function createLinearTicks(
  minimum: number,
  maximum: number,
  count = TARGET_TICK_COUNT,
): NumericTick[] {
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) {
    return [{ unit: 0, value: 0 }]
  }
  if (maximum <= minimum || count <= 1) {
    return [{ unit: 0, value: minimum }]
  }

  return Array.from({ length: count }, (_, index) => {
    const unit = index / (count - 1)
    return {
      unit,
      value: index === count - 1
        ? maximum
        : minimum + unit * (maximum - minimum),
    }
  })
}

function createLogFrequencyTicks(
  minimum: number,
  maximum: number,
  count = TARGET_TICK_COUNT,
): NumericTick[] {
  if (
    !Number.isFinite(minimum) ||
    !Number.isFinite(maximum) ||
    minimum <= 0 ||
    maximum <= minimum ||
    count <= 1
  ) {
    return [{ unit: 0, value: Math.max(0, maximum) }]
  }

  const minimumLog = Math.log(minimum)
  const logSpan = Math.log(maximum) - minimumLog
  return Array.from({ length: count }, (_, index) => {
    const unit = index / (count - 1)
    return {
      unit,
      value: index === 0
        ? minimum
        : index === count - 1
          ? maximum
          : Math.exp(minimumLog + unit * logSpan),
    }
  })
}

function linearStep(minimum: number, maximum: number): number {
  return maximum > minimum
    ? (maximum - minimum) / (TARGET_TICK_COUNT - 1)
    : 0
}

function formatAdaptive(value: number, step: number): string {
  if (!Number.isFinite(value)) {
    return '0'
  }
  const decimals = step > 0
    ? Math.max(0, Math.min(6, Math.ceil(-Math.log10(step)) + 1))
    : 3
  return trimFraction(value.toFixed(decimals))
}

function formatFrequency(frequency: number): string {
  if (!Number.isFinite(frequency) || frequency <= 0) {
    return '0 Hz'
  }
  if (frequency >= 1000) {
    const kilohertz = frequency / 1000
    const decimals = Number.isInteger(kilohertz)
      ? 0
      : kilohertz >= 100
        ? 1
        : 2
    return `${trimFraction(kilohertz.toFixed(decimals))} kHz`
  }

  const decimals = frequency >= 100
    ? 0
    : frequency >= 10
      ? 1
      : 2
  return `${trimFraction(frequency.toFixed(decimals))} Hz`
}

function trimFraction(value: string): string {
  return value.includes('.')
    ? value.replace(/\.0+$|(?<=\.[0-9]*[1-9])0+$/, '')
    : value
}
