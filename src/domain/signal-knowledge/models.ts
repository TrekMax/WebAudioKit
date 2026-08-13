import type { ComplexValue } from './complex'
import {
  computeDftBinContributions,
  computeTeachingStft,
  generateTeachingSignal,
  type DftBinContribution,
  type TeachingStftModel,
} from './transforms'

export interface PhasorPathPoint extends ComplexValue {
  readonly progress: number
}

export interface PhasorTeachingModel {
  readonly cycles: number
  readonly phaseRadians: number
  readonly points: readonly PhasorPathPoint[]
}

export interface DftTeachingModel {
  readonly sampleCount: number
  readonly signalBin: number
  readonly inspectedBin: number
  readonly samples: Float64Array
  readonly contributions: readonly DftBinContribution[]
}

export function createPhasorTeachingModel(
  cycles = 1.25,
  phaseRadians = Math.PI / 5,
  pointCount = 64,
): PhasorTeachingModel {
  if (!Number.isSafeInteger(pointCount) || pointCount < 2 || pointCount > 128) {
    throw new RangeError('Phasor path point count must be an integer from 2 to 128')
  }
  if (!Number.isFinite(cycles) || !Number.isFinite(phaseRadians)) {
    throw new TypeError('Phasor cycles and phase must be finite')
  }
  return {
    cycles,
    phaseRadians,
    points: Array.from({ length: pointCount }, (_, index) => {
      const progress = index / (pointCount - 1)
      const angle = 2 * Math.PI * cycles * progress + phaseRadians
      return {
        progress,
        real: Math.cos(angle),
        imaginary: Math.sin(angle),
      }
    }),
  }
}

export function createDftTeachingModel(
  sampleCount = 16,
  signalBin = 3,
  inspectedBin = 3,
): DftTeachingModel {
  const samples = generateTeachingSignal({
    kind: 'sine',
    sampleCount,
    cycles: signalBin,
  })
  return {
    sampleCount,
    signalBin,
    inspectedBin,
    samples,
    contributions: computeDftBinContributions(samples, inspectedBin),
  }
}

export function createStftTeachingModel(): TeachingStftModel {
  const samples = generateTeachingSignal({
    kind: 'chirp',
    sampleCount: 128,
    cycles: 4,
  })
  return computeTeachingStft(samples, 32, 8, 'hann')
}
