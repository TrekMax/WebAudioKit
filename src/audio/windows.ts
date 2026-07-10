export const WINDOW_FUNCTION_NAMES = [
  'hann',
  'hamming',
  'blackman',
] as const

export type WindowFunctionName = (typeof WINDOW_FUNCTION_NAMES)[number]

function assertWindowSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 2) {
    throw new RangeError(
      `Window size must be an integer greater than or equal to 2; received ${String(size)}`,
    )
  }
}

function createPeriodicWindow(
  size: number,
  coefficientAt: (phase: number) => number,
): Float64Array {
  assertWindowSize(size)
  const window = new Float64Array(size)

  for (let index = 0; index < size; index += 1) {
    window[index] = coefficientAt((2 * Math.PI * index) / size)
  }

  return window
}

/** Periodic Hann window: 0.5 - 0.5 cos(2πn/N). */
export function createHannWindow(size: number): Float64Array {
  return createPeriodicWindow(size, (phase) => 0.5 - 0.5 * Math.cos(phase))
}

/** Periodic Hamming window: 0.54 - 0.46 cos(2πn/N). */
export function createHammingWindow(size: number): Float64Array {
  return createPeriodicWindow(size, (phase) => 0.54 - 0.46 * Math.cos(phase))
}

/** Periodic Blackman window using coefficients 0.42, 0.5, and 0.08. */
export function createBlackmanWindow(size: number): Float64Array {
  return createPeriodicWindow(
    size,
    (phase) =>
      0.42 - 0.5 * Math.cos(phase) + 0.08 * Math.cos(2 * phase),
  )
}

export function createWindow(
  name: WindowFunctionName,
  size: number,
): Float64Array {
  switch (name) {
    case 'hann':
      return createHannWindow(size)
    case 'hamming':
      return createHammingWindow(size)
    case 'blackman':
      return createBlackmanWindow(size)
    default: {
      const unsupportedName: never = name
      throw new RangeError(`Unsupported window function: ${String(unsupportedName)}`)
    }
  }
}

/** Returns Cw = sum(window) / N for amplitude calibration. */
export function calculateCoherentGain(window: ArrayLike<number>): number {
  if (window.length === 0) {
    throw new RangeError('Cannot calculate coherent gain for an empty window')
  }

  let sum = 0
  for (let index = 0; index < window.length; index += 1) {
    const coefficient = window[index]
    if (coefficient === undefined || !Number.isFinite(coefficient)) {
      throw new TypeError(`window[${index}] must be finite`)
    }
    sum += coefficient
  }

  const gain = sum / window.length
  if (!(gain > 0) || !Number.isFinite(gain)) {
    throw new RangeError('Window coherent gain must be finite and positive')
  }

  return gain
}

/** Multiplies matching sample and window buffers into a new Float64 buffer. */
export function applyWindow(
  samples: ArrayLike<number>,
  window: ArrayLike<number>,
): Float64Array {
  if (samples.length !== window.length) {
    throw new RangeError(
      `Samples and window must have the same length; received ${samples.length} and ${window.length}`,
    )
  }

  const output = new Float64Array(samples.length)
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]
    const coefficient = window[index]
    if (sample === undefined || !Number.isFinite(sample)) {
      throw new TypeError(`samples[${index}] must be finite`)
    }
    if (coefficient === undefined || !Number.isFinite(coefficient)) {
      throw new TypeError(`window[${index}] must be finite`)
    }
    output[index] = sample * coefficient
  }

  return output
}
