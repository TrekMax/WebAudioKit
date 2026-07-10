export interface ComplexSpectrum {
  readonly real: Float64Array
  readonly imaginary: Float64Array
}

/**
 * Returns whether `value` is a radix-2 FFT size supported by this module.
 * A one-point transform is intentionally rejected because the analysis
 * pipeline relies on a distinct DC and one-sided spectrum definition.
 */
export function isValidFftSize(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= 2 &&
    Number.isInteger(Math.log2(value))
  )
}

export function assertValidFftSize(value: number): void {
  if (!isValidFftSize(value)) {
    throw new RangeError(
      `FFT size must be a power-of-two integer greater than or equal to 2; received ${String(value)}`,
    )
  }
}

function assertFiniteBuffer(buffer: Float64Array, label: string): void {
  for (let index = 0; index < buffer.length; index += 1) {
    if (!Number.isFinite(buffer[index])) {
      throw new TypeError(`${label}[${index}] must be finite`)
    }
  }
}

/**
 * Computes an unnormalised forward FFT in place.
 *
 * The transform uses the conventional negative phase sign. Callers retain
 * control over amplitude normalisation because real one-sided spectra need
 * different scaling for DC, Nyquist, and the remaining bins.
 */
export function fftRadix2InPlace(
  real: Float64Array,
  imaginary: Float64Array,
): void {
  const size = real.length
  assertValidFftSize(size)

  if (imaginary.length !== size) {
    throw new RangeError(
      `Real and imaginary buffers must have the same length; received ${size} and ${imaginary.length}`,
    )
  }

  assertFiniteBuffer(real, 'real')
  assertFiniteBuffer(imaginary, 'imaginary')

  // Bit-reversal permutation without 32-bit bitwise operators, so the
  // implementation remains correct for every safely allocatable array size.
  let reversedIndex = 0
  for (let index = 1; index < size; index += 1) {
    let bit = size / 2
    while (reversedIndex >= bit) {
      reversedIndex -= bit
      bit /= 2
    }
    reversedIndex += bit

    if (index < reversedIndex) {
      const realValue = real[index]
      real[index] = real[reversedIndex] ?? 0
      real[reversedIndex] = realValue ?? 0

      const imaginaryValue = imaginary[index]
      imaginary[index] = imaginary[reversedIndex] ?? 0
      imaginary[reversedIndex] = imaginaryValue ?? 0
    }
  }

  for (let blockSize = 2; blockSize <= size; blockSize *= 2) {
    const halfBlockSize = blockSize / 2
    const phaseStep = (-2 * Math.PI) / blockSize
    const stepReal = Math.cos(phaseStep)
    const stepImaginary = Math.sin(phaseStep)

    for (let blockStart = 0; blockStart < size; blockStart += blockSize) {
      let phaseReal = 1
      let phaseImaginary = 0

      for (let offset = 0; offset < halfBlockSize; offset += 1) {
        const evenIndex = blockStart + offset
        const oddIndex = evenIndex + halfBlockSize
        const oddReal = real[oddIndex] ?? 0
        const oddImaginary = imaginary[oddIndex] ?? 0
        const rotatedReal =
          phaseReal * oddReal - phaseImaginary * oddImaginary
        const rotatedImaginary =
          phaseReal * oddImaginary + phaseImaginary * oddReal
        const evenReal = real[evenIndex] ?? 0
        const evenImaginary = imaginary[evenIndex] ?? 0

        real[evenIndex] = evenReal + rotatedReal
        imaginary[evenIndex] = evenImaginary + rotatedImaginary
        real[oddIndex] = evenReal - rotatedReal
        imaginary[oddIndex] = evenImaginary - rotatedImaginary

        const nextPhaseReal =
          phaseReal * stepReal - phaseImaginary * stepImaginary
        phaseImaginary =
          phaseReal * stepImaginary + phaseImaginary * stepReal
        phaseReal = nextPhaseReal
      }
    }

    if (blockSize === size) {
      break
    }
  }
}

/** Creates independent output buffers and leaves the input unchanged. */
export function fftRadix2(
  realInput: ArrayLike<number>,
  imaginaryInput?: ArrayLike<number>,
): ComplexSpectrum {
  const size = realInput.length
  assertValidFftSize(size)

  if (imaginaryInput !== undefined && imaginaryInput.length !== size) {
    throw new RangeError(
      `Real and imaginary inputs must have the same length; received ${size} and ${imaginaryInput.length}`,
    )
  }

  const real = new Float64Array(size)
  const imaginary = new Float64Array(size)

  for (let index = 0; index < size; index += 1) {
    real[index] = realInput[index] ?? Number.NaN
    imaginary[index] = imaginaryInput?.[index] ?? 0
  }

  fftRadix2InPlace(real, imaginary)
  return { real, imaginary }
}
