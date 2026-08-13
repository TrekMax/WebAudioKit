/* global AudioWorkletProcessor, registerProcessor, sampleRate */

const PROCESSOR_NAME = 'webaudio-kit-resampler'
const MAX_CHANNELS = 32
const MIN_TARGET_SAMPLE_RATE = 3_000
const MAX_TARGET_SAMPLE_RATE = 192_000
const SINC_TAPS = 16
const SINC_PHASES = 128
const SINC_DELAY_SAMPLES = SINC_TAPS / 2

function normalizedSinc(value) {
  if (Math.abs(value) < 1e-12) return 1
  const radians = Math.PI * value
  return Math.sin(radians) / radians
}

function buildWindowedSincTable() {
  const table = new Float32Array(SINC_PHASES * SINC_TAPS)
  for (let phaseIndex = 0; phaseIndex < SINC_PHASES; phaseIndex += 1) {
    const phase = phaseIndex / SINC_PHASES
    const offset = phaseIndex * SINC_TAPS
    let sum = 0
    for (let tap = 0; tap < SINC_TAPS; tap += 1) {
      const distance = tap - SINC_DELAY_SAMPLES + phase
      const coefficient = Math.abs(distance) >= SINC_DELAY_SAMPLES
        ? 0
        : normalizedSinc(distance) * normalizedSinc(distance / SINC_DELAY_SAMPLES)
      table[offset + tap] = coefficient
      sum += coefficient
    }
    const normalization = Math.abs(sum) > 1e-12 ? 1 / sum : 1
    for (let tap = 0; tap < SINC_TAPS; tap += 1) {
      table[offset + tap] *= normalization
    }
  }
  return table
}

function catmullRom(p0, p1, p2, p3, phase) {
  const phaseSquared = phase * phase
  const phaseCubed = phaseSquared * phase
  return 0.5 * (
    2 * p1
    + (-p0 + p2) * phase
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * phaseSquared
    + (-p0 + 3 * p1 - 3 * p2 + p3) * phaseCubed
  )
}

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
    const requestedAlgorithm = options.processorOptions?.algorithm
    this.algorithm = requestedAlgorithm === 'point'
      || requestedAlgorithm === 'linear'
      || requestedAlgorithm === 'cubic'
      || requestedAlgorithm === 'sinc'
      ? requestedAlgorithm
      : 'hold'
    this.phase = new Float64Array(MAX_CHANNELS)
    this.filtered = new Float32Array(MAX_CHANNELS)
    this.history = new Float32Array(MAX_CHANNELS * SINC_TAPS)
    this.initialized = new Uint8Array(MAX_CHANNELS)
    this.sincTable = this.algorithm === 'sinc' ? buildWindowedSincTable() : null
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
    const antiAlias = this.algorithm !== 'point'

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
          const historyOffset = channel * SINC_TAPS
          for (let tap = 0; tap < SINC_TAPS; tap += 1) {
            this.history[historyOffset + tap] = lastSample
          }
          this.initialized[channel] = 1
        }
        continue
      }

      let phase = this.phase[channel]
      let filtered = this.filtered[channel]
      let initialized = this.initialized[channel]
      const historyOffset = channel * SINC_TAPS
      for (let frame = 0; frame < output.length; frame += 1) {
        const sample = input[frame] || 0
        filtered = antiAlias
          ? filtered + lowpassAlpha * (sample - filtered)
          : sample
        phase += ratio
        if (!initialized) {
          phase -= Math.floor(phase)
          for (let tap = 0; tap < SINC_TAPS; tap += 1) {
            this.history[historyOffset + tap] = filtered
          }
          initialized = 1
        } else if (phase >= 1) {
          phase -= Math.floor(phase)
          for (let tap = SINC_TAPS - 1; tap > 0; tap -= 1) {
            this.history[historyOffset + tap] = this.history[historyOffset + tap - 1]
          }
          this.history[historyOffset] = filtered
        }
        const held = this.history[historyOffset]
        if (this.algorithm === 'linear') {
          const previous = this.history[historyOffset + 1]
          output[frame] = previous + (held - previous) * phase
        } else if (this.algorithm === 'cubic') {
          output[frame] = catmullRom(
            this.history[historyOffset + 3],
            this.history[historyOffset + 2],
            this.history[historyOffset + 1],
            held,
            phase,
          )
        } else if (this.algorithm === 'sinc' && this.sincTable) {
          const phaseIndex = Math.min(
            SINC_PHASES - 1,
            Math.floor(phase * SINC_PHASES),
          )
          const coefficientOffset = phaseIndex * SINC_TAPS
          let reconstructed = 0
          for (let tap = 0; tap < SINC_TAPS; tap += 1) {
            reconstructed += this.history[historyOffset + tap]
              * this.sincTable[coefficientOffset + tap]
          }
          output[frame] = reconstructed
        } else {
          output[frame] = held
        }
      }
      this.phase[channel] = phase
      this.filtered[channel] = filtered
      this.initialized[channel] = initialized
    }
    return true
  }
}

registerProcessor(PROCESSOR_NAME, ResamplerProcessor)
