import { afterEach, describe, expect, it, vi } from 'vitest'

interface TestResamplerProcessor {
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean
}

describe('resampler AudioWorklet processor', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('attenuates before downsampling and keeps upsampling finite and transparent', async () => {
    const registration: {
      name?: string
      Processor?: new () => TestResamplerProcessor
    } = {}
    class FakeAudioWorkletProcessor {}
    vi.stubGlobal('sampleRate', 48_000)
    vi.stubGlobal('AudioWorkletProcessor', FakeAudioWorkletProcessor)
    vi.stubGlobal(
      'registerProcessor',
      (name: string, implementation: new () => TestResamplerProcessor) => {
        registration.name = name
        registration.Processor = implementation
      },
    )

    await import('./resampler.worklet.js')

    expect(registration.name).toBe('webaudio-kit-resampler')
    const Processor = registration.Processor
    if (!Processor) throw new Error('Resampler processor was not registered')
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
})
