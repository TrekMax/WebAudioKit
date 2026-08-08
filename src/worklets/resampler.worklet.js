/* global AudioWorkletProcessor, registerProcessor, sampleRate */

const PROCESSOR_NAME = 'webaudio-kit-resampler'
const MAX_CHANNELS = 32
const MIN_TARGET_SAMPLE_RATE = 3_000
const MAX_TARGET_SAMPLE_RATE = 192_000

class ResamplerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{
      name: 'targetSampleRateHz',
      defaultValue: 24_000,
      minValue: MIN_TARGET_SAMPLE_RATE,
      maxValue: MAX_TARGET_SAMPLE_RATE,
      automationRate: 'k-rate',
    }]
  }

  constructor(options = {}) {
    super()
    this.algorithm = options.processorOptions?.algorithm === 'linear' ? 'linear' : 'hold'
    this.phase = new Float64Array(MAX_CHANNELS)
    this.filtered = new Float32Array(MAX_CHANNELS)
    this.previous = new Float32Array(MAX_CHANNELS)
    this.held = new Float32Array(MAX_CHANNELS)
    this.initialized = new Uint8Array(MAX_CHANNELS)
  }

  process(inputs, outputs, parameters) {
    const inputChannels = inputs[0]
    const outputChannels = outputs[0]
    const targetParameter = parameters.targetSampleRateHz
    const targetSampleRateHz = Math.max(
      MIN_TARGET_SAMPLE_RATE,
      Math.min(MAX_TARGET_SAMPLE_RATE, targetParameter[0] || sampleRate),
    )
    const downsampling = targetSampleRateHz < sampleRate
    const ratio = downsampling ? targetSampleRateHz / sampleRate : 1
    const cutoffHz = Math.min(sampleRate * 0.45, targetSampleRateHz * 0.45)
    const lowpassAlpha = downsampling
      ? 1 - Math.exp((-2 * Math.PI * cutoffHz) / sampleRate)
      : 1

    for (let channel = 0; channel < outputChannels.length; channel += 1) {
      const output = outputChannels[channel]
      const input = inputChannels[channel] || inputChannels[0]
      if (!output) continue
      if (!input) {
        output.fill(0)
        continue
      }
      if (!downsampling || channel >= MAX_CHANNELS) {
        output.set(input)
        if (channel < MAX_CHANNELS) {
          const lastSample = input[input.length - 1] || 0
          this.phase[channel] = 0
          this.filtered[channel] = lastSample
          this.previous[channel] = lastSample
          this.held[channel] = lastSample
          this.initialized[channel] = 1
        }
        continue
      }

      let phase = this.phase[channel]
      let filtered = this.filtered[channel]
      let previous = this.previous[channel]
      let held = this.held[channel]
      let initialized = this.initialized[channel]
      for (let frame = 0; frame < output.length; frame += 1) {
        const sample = input[frame] || 0
        filtered += lowpassAlpha * (sample - filtered)
        phase += ratio
        if (!initialized) {
          phase -= Math.floor(phase)
          held = filtered
          previous = filtered
          initialized = 1
        } else if (phase >= 1) {
          phase -= Math.floor(phase)
          previous = held
          held = filtered
        }
        output[frame] = this.algorithm === 'linear'
          ? previous + (held - previous) * phase
          : held
      }
      this.phase[channel] = phase
      this.filtered[channel] = filtered
      this.previous[channel] = previous
      this.held[channel] = held
      this.initialized[channel] = initialized
    }
    return true
  }
}

registerProcessor(PROCESSOR_NAME, ResamplerProcessor)
