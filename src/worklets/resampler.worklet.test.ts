import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface TestResamplerProcessor {
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean
}

type TestResamplerProcessorConstructor = new (options?: {
  readonly processorOptions?: { readonly algorithm?: string }
}) => TestResamplerProcessor

async function loadProcessor(): Promise<TestResamplerProcessorConstructor> {
  const registration: {
    name?: string
    Processor?: TestResamplerProcessorConstructor
  } = {}
  class FakeAudioWorkletProcessor {}
  vi.stubGlobal('sampleRate', 48_000)
  vi.stubGlobal('AudioWorkletProcessor', FakeAudioWorkletProcessor)
  vi.stubGlobal(
    'registerProcessor',
    (name: string, implementation: TestResamplerProcessorConstructor) => {
      registration.name = name
      registration.Processor = implementation
    },
  )

  await import('./resampler.worklet.js')

  expect(registration.name).toBe('webaudio-kit-resampler')
  const Processor = registration.Processor
  if (!Processor) throw new Error('Resampler processor was not registered')
  return Processor
}

function maximumStep(samples: Float32Array): number {
  let maximum = 0
  for (let index = 1; index < samples.length; index += 1) {
    maximum = Math.max(maximum, Math.abs((samples[index] ?? 0) - (samples[index - 1] ?? 0)))
  }
  return maximum
}

function changingStepCount(samples: Float32Array): number {
  let count = 0
  for (let index = 1; index < samples.length; index += 1) {
    if (Math.abs((samples[index] ?? 0) - (samples[index - 1] ?? 0)) > 1e-7) count += 1
  }
  return count
}

describe('resampler AudioWorklet processor', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('attenuates before downsampling and keeps upsampling finite and transparent', async () => {
    const Processor = await loadProcessor()
    const processor = new Processor()
    const alternating = Float32Array.from({ length: 128 }, (_, index) => index % 2 === 0 ? 1 : -1)
    const downsampled = new Float32Array(alternating.length)
    expect(processor.process(
      [[alternating]],
      [[downsampled]],
      { targetSampleRateHz: new Float32Array([8_000]) },
    )).toBe(true)
    expect(Array.from(downsampled).every(Number.isFinite)).toBe(true)
    expect(Math.max(...downsampled.map(Math.abs))).toBeLessThan(0.5)

    const ramp = Float32Array.from({ length: 128 }, (_, index) => index / 127)
    const upsampled = new Float32Array(ramp.length)
    processor.process(
      [[ramp]],
      [[upsampled]],
      { targetSampleRateHz: new Float32Array([96_000]) },
    )
    expect(upsampled).toEqual(ramp)
  })

  it('offers a smoother causal linear reconstruction than zero-order hold', async () => {
    const Processor = await loadProcessor()
    const input = Float32Array.from({ length: 128 }, (_, index) => index / 127)
    const held = new Float32Array(input.length)
    const linear = new Float32Array(input.length)
    const parameters = { targetSampleRateHz: new Float32Array([12_000]) }

    new Processor({ processorOptions: { algorithm: 'hold' } }).process(
      [[input]],
      [[held]],
      parameters,
    )
    new Processor({ processorOptions: { algorithm: 'linear' } }).process(
      [[input]],
      [[linear]],
      parameters,
    )

    expect(linear).not.toEqual(held)
    expect(changingStepCount(linear)).toBeGreaterThan(changingStepCount(held))
    expect(maximumStep(linear)).toBeLessThan(maximumStep(held))
    expect(Array.from(linear).every(Number.isFinite)).toBe(true)
  })

  it('keeps linear reconstruction continuous across render quanta and channels', async () => {
    const Processor = await loadProcessor()
    const processor = new Processor({ processorOptions: { algorithm: 'linear' } })
    const firstLeft = Float32Array.from({ length: 128 }, (_, index) => index / 256)
    const firstRight = Float32Array.from(firstLeft, (sample) => -sample)
    const secondLeft = Float32Array.from({ length: 128 }, (_, index) => (index + 128) / 256)
    const secondRight = Float32Array.from(secondLeft, (sample) => -sample)
    const firstOutput = [new Float32Array(128), new Float32Array(128)]
    const secondOutput = [new Float32Array(128), new Float32Array(128)]
    const parameters = { targetSampleRateHz: new Float32Array([11_025]) }

    processor.process([[firstLeft, firstRight]], [firstOutput], parameters)
    processor.process([[secondLeft, secondRight]], [secondOutput], parameters)

    const boundaryStep = Math.abs((secondOutput[0]?.[0] ?? 0) - (firstOutput[0]?.[127] ?? 0))
    expect(boundaryStep).toBeLessThanOrEqual(maximumStep(secondOutput[0] ?? new Float32Array()))
    expect(secondOutput[0]?.every(Number.isFinite)).toBe(true)
    expect(secondOutput[1]?.every(Number.isFinite)).toBe(true)
    expect(secondOutput[0]?.[64]).toBeGreaterThan(0)
    expect(secondOutput[1]?.[64]).toBeLessThan(0)
  })
})
