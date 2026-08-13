import {
  applyWindow,
  calculateCoherentGain,
  createWindow,
  type WindowFunctionName,
} from '../../audio/windows'
import {
  addComplex,
  complexMagnitude,
  complexPhase,
  createComplex,
  type ComplexValue,
} from './complex'

export const MAX_TEACHING_SAMPLE_COUNT = 128
export const MAX_TEACHING_STFT_FRAMES = 64
export const MAX_TEACHING_STFT_BINS = 64

export type TeachingSignalKind =
  | 'sine'
  | 'two-tone'
  | 'chirp'
  | 'impulse'
  | 'silence'

export type TeachingWindowName = WindowFunctionName | 'rectangular'

export interface TeachingSignalOptions {
  readonly kind: TeachingSignalKind
  readonly sampleCount: number
  readonly cycles?: number
  readonly phaseRadians?: number
}

export interface DftBinContribution {
  readonly sampleIndex: number
  readonly sample: number
  readonly angleRadians: number
  readonly vector: ComplexValue
  readonly partialSum: ComplexValue
}

export interface MagnitudeSpectrumBin {
  readonly bin: number
  readonly magnitude: number
  readonly phaseRadians: number
}

export interface TeachingStftModel {
  readonly window: TeachingWindowName
  readonly windowSize: number
  readonly hopSize: number
  readonly frameCount: number
  readonly binCount: number
  readonly magnitudes: Float64Array
  readonly maxMagnitude: number
}

function assertSampleCount(sampleCount: number): void {
  if (
    !Number.isSafeInteger(sampleCount)
    || sampleCount < 2
    || sampleCount > MAX_TEACHING_SAMPLE_COUNT
  ) {
    throw new RangeError(
      `Teaching sample count must be an integer from 2 to ${MAX_TEACHING_SAMPLE_COUNT}; received ${String(sampleCount)}`,
    )
  }
}

function sanitizeSample(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0
}

function assertDftInput(samples: ArrayLike<number>): void {
  if (samples.length > MAX_TEACHING_SAMPLE_COUNT) {
    throw new RangeError(
      `Teaching DFT is limited to ${MAX_TEACHING_SAMPLE_COUNT} samples`,
    )
  }
}

export function generateTeachingSignal({
  kind,
  sampleCount,
  cycles = 3,
  phaseRadians = 0,
}: TeachingSignalOptions): Float64Array {
  assertSampleCount(sampleCount)
  if (!Number.isFinite(cycles) || !Number.isFinite(phaseRadians)) {
    throw new TypeError('Teaching signal cycles and phase must be finite')
  }

  const samples = new Float64Array(sampleCount)
  for (let index = 0; index < sampleCount; index += 1) {
    const position = index / sampleCount
    switch (kind) {
      case 'sine':
        samples[index] = Math.cos(2 * Math.PI * cycles * position + phaseRadians)
        break
      case 'two-tone':
        samples[index] = 0.68 * Math.cos(2 * Math.PI * cycles * position + phaseRadians)
          + 0.32 * Math.cos(2 * Math.PI * cycles * 2.5 * position - 0.4)
        break
      case 'chirp': {
        const startCycles = Math.max(0.25, cycles * 0.35)
        const endCycles = Math.max(startCycles, cycles * 2.2)
        const accumulatedCycles = startCycles * position
          + 0.5 * (endCycles - startCycles) * position * position
        samples[index] = Math.cos(2 * Math.PI * accumulatedCycles + phaseRadians)
        break
      }
      case 'impulse':
        samples[index] = index === 0 ? 1 : 0
        break
      case 'silence':
        samples[index] = 0
        break
      default: {
        const unsupportedKind: never = kind
        throw new RangeError(`Unsupported teaching signal: ${String(unsupportedKind)}`)
      }
    }
  }
  return samples
}

export function computeDftBinContributions(
  samples: ArrayLike<number>,
  bin: number,
): readonly DftBinContribution[] {
  assertDftInput(samples)
  const sampleCount = samples.length
  if (sampleCount === 0) return []
  if (!Number.isSafeInteger(bin) || bin < 0 || bin >= sampleCount) {
    throw new RangeError(`DFT bin must be an integer from 0 to ${sampleCount - 1}`)
  }

  let partialSum = createComplex(0, 0)
  return Array.from({ length: sampleCount }, (_, sampleIndex) => {
    const sample = sanitizeSample(samples[sampleIndex])
    const angleRadians = (-2 * Math.PI * bin * sampleIndex) / sampleCount
    const vector = createComplex(
      sample * Math.cos(angleRadians),
      sample * Math.sin(angleRadians),
    )
    partialSum = addComplex(partialSum, vector)
    return {
      sampleIndex,
      sample,
      angleRadians,
      vector,
      partialSum,
    }
  })
}

export function computeDftBin(
  samples: ArrayLike<number>,
  bin: number,
): ComplexValue {
  const contributions = computeDftBinContributions(samples, bin)
  return contributions.at(-1)?.partialSum ?? createComplex(0, 0)
}

export function computeDft(samples: ArrayLike<number>): readonly ComplexValue[] {
  assertDftInput(samples)
  return Array.from(
    { length: samples.length },
    (_, bin) => computeDftBin(samples, bin),
  )
}

export function createSingleSidedMagnitudeSpectrum(
  samples: ArrayLike<number>,
): readonly MagnitudeSpectrumBin[] {
  assertDftInput(samples)
  const sampleCount = samples.length
  if (sampleCount === 0) return []
  const binCount = Math.floor(sampleCount / 2) + 1

  return Array.from({ length: binCount }, (_, bin) => {
    const value = computeDftBin(samples, bin)
    const isNyquist = sampleCount % 2 === 0 && bin === sampleCount / 2
    const scale = bin === 0 || isNyquist ? 1 / sampleCount : 2 / sampleCount
    const magnitude = complexMagnitude(value) * scale
    return {
      bin,
      magnitude,
      phaseRadians: magnitude < 1e-12 ? 0 : complexPhase(value),
    }
  })
}

export function createTeachingWindow(
  name: TeachingWindowName,
  size: number,
): Float64Array {
  assertSampleCount(size)
  return name === 'rectangular'
    ? new Float64Array(size).fill(1)
    : createWindow(name, size)
}

export function computeTeachingStft(
  samples: ArrayLike<number>,
  windowSize: number,
  hopSize: number,
  window: TeachingWindowName,
): TeachingStftModel {
  assertSampleCount(windowSize)
  if (!Number.isSafeInteger(hopSize) || hopSize < 1 || hopSize > windowSize) {
    throw new RangeError(`STFT hop size must be an integer from 1 to ${windowSize}`)
  }
  if (samples.length > MAX_TEACHING_SAMPLE_COUNT) {
    throw new RangeError(
      `Teaching STFT is limited to ${MAX_TEACHING_SAMPLE_COUNT} source samples`,
    )
  }

  const coefficients = createTeachingWindow(window, windowSize)
  const coherentGain = calculateCoherentGain(coefficients)
  const availableFrameCount = samples.length === 0
    ? 0
    : Math.max(1, Math.ceil((samples.length - windowSize) / hopSize) + 1)
  const frameCount = Math.min(MAX_TEACHING_STFT_FRAMES, availableFrameCount)
  const binCount = Math.min(
    MAX_TEACHING_STFT_BINS,
    Math.floor(windowSize / 2) + 1,
  )
  const magnitudes = new Float64Array(frameCount * binCount)
  let maxMagnitude = 0

  for (let frame = 0; frame < frameCount; frame += 1) {
    const frameSamples = new Float64Array(windowSize)
    const offset = frame * hopSize
    for (let index = 0; index < windowSize; index += 1) {
      frameSamples[index] = sanitizeSample(samples[offset + index])
    }
    const windowed = applyWindow(frameSamples, coefficients)
    for (let bin = 0; bin < binCount; bin += 1) {
      const value = computeDftBin(windowed, bin)
      const isNyquist = windowSize % 2 === 0 && bin === windowSize / 2
      const scale = bin === 0 || isNyquist
        ? 1 / (windowSize * coherentGain)
        : 2 / (windowSize * coherentGain)
      const magnitude = complexMagnitude(value) * scale
      magnitudes[frame * binCount + bin] = magnitude
      maxMagnitude = Math.max(maxMagnitude, magnitude)
    }
  }

  return {
    window,
    windowSize,
    hopSize,
    frameCount,
    binCount,
    magnitudes,
    maxMagnitude,
  }
}
