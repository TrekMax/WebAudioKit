export interface ComplexValue {
  readonly real: number
  readonly imaginary: number
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite`)
  }
}

export function createComplex(real: number, imaginary: number): ComplexValue {
  assertFinite(real, 'real')
  assertFinite(imaginary, 'imaginary')
  return { real, imaginary }
}

export function addComplex(
  left: ComplexValue,
  right: ComplexValue,
): ComplexValue {
  return createComplex(
    left.real + right.real,
    left.imaginary + right.imaginary,
  )
}

export function multiplyComplex(
  left: ComplexValue,
  right: ComplexValue,
): ComplexValue {
  return createComplex(
    left.real * right.real - left.imaginary * right.imaginary,
    left.real * right.imaginary + left.imaginary * right.real,
  )
}

export function complexFromPolar(
  magnitude: number,
  phaseRadians: number,
): ComplexValue {
  assertFinite(magnitude, 'magnitude')
  assertFinite(phaseRadians, 'phaseRadians')
  return createComplex(
    magnitude * Math.cos(phaseRadians),
    magnitude * Math.sin(phaseRadians),
  )
}

export function complexMagnitude(value: ComplexValue): number {
  return Math.hypot(value.real, value.imaginary)
}

export function complexPhase(value: ComplexValue): number {
  if (value.real === 0 && value.imaginary === 0) return 0
  return Math.atan2(value.imaginary, value.real)
}
