import { describe, expect, it } from 'vitest'

import {
  DEFAULT_EQ_BAND_COUNT,
  EQ_BAND_COUNTS,
  EQ_BAND_PRESETS,
  FILTER_DEFINITIONS,
  RESAMPLING_ALGORITHMS,
  cloneFilterNodeConfig,
  compileFilterChain,
  createFilterNodeConfig,
  remapEqGainsDb,
  validateFilterChain,
  type EqBandCount,
  type FilterKind,
} from './filterGraph'

class FakeAudioParam {
  value = 0

  setValueAtTime(value: number): FakeAudioParam {
    this.value = value
    return this
  }
}

class FakeBiquadFilterNode {
  type: BiquadFilterType = 'lowpass'
  readonly frequency = new FakeAudioParam()
  readonly Q = new FakeAudioParam()
  readonly gain = new FakeAudioParam()
  disconnected = false

  disconnect(): void {
    this.disconnected = true
  }
}

class FakeFilterContext {
  currentTime = 2
  readonly nodes: FakeBiquadFilterNode[] = []

  createBiquadFilter(): BiquadFilterNode {
    const node = new FakeBiquadFilterNode()
    this.nodes.push(node)
    return node as unknown as BiquadFilterNode
  }
}

class FakeResamplerNode {
  readonly targetSampleRateHz = new FakeAudioParam()
  readonly parameters = new Map([['targetSampleRateHz', this.targetSampleRateHz]])
  disconnected = false

  disconnect(): void {
    this.disconnected = true
  }
}

describe('filter graph compiler', () => {
  it('creates valid defaults for every supported filter type', () => {
    const kinds = Object.keys(FILTER_DEFINITIONS) as FilterKind[]
    const filters = kinds.map((kind, index) => createFilterNodeConfig(kind, `filter-${index}`))

    expect(validateFilterChain(filters)).toBe(filters)
    expect(filters.map((filter) => filter.type)).toEqual(kinds)
    expect(filters.every((filter) => filter.enabled)).toBe(true)
    expect(createFilterNodeConfig('resampler', 'rate')).toMatchObject({
      targetSampleRateHz: 24_000,
      resamplingAlgorithm: 'hold',
    })
    expect(RESAMPLING_ALGORITHMS).toEqual(['hold', 'linear', 'cubic', 'sinc'])
    const equalizer = createFilterNodeConfig('equalizer', 'eq')
    expect(equalizer.eqBandCount).toBe(DEFAULT_EQ_BAND_COUNT)
    expect(equalizer.eqGainsDb).toEqual(
      EQ_BAND_PRESETS[DEFAULT_EQ_BAND_COUNT].frequenciesHz.map(() => 0),
    )
  })

  it('compiles enabled nodes in order and applies their parameters', () => {
    const context = new FakeFilterContext()
    const filters = [
      { ...createFilterNodeConfig('highpass', 'one'), frequencyHz: 180, q: 0.8 },
      { ...createFilterNodeConfig('notch', 'bypassed'), enabled: false },
      { ...createFilterNodeConfig('peaking', 'two'), frequencyHz: 2_400, q: 2, gainDb: -4 },
    ]

    const compiled = compileFilterChain(context, filters)

    expect(compiled).toHaveLength(2)
    expect(context.nodes[0]).toMatchObject({
      type: 'highpass',
      frequency: { value: 180 },
      Q: { value: 0.8 },
      gain: { value: 0 },
    })
    expect(context.nodes[1]).toMatchObject({
      type: 'peaking',
      frequency: { value: 2_400 },
      Q: { value: 2 },
      gain: { value: -4 },
    })
  })

  it('delegates resampler construction and applies its target sample rate', () => {
    const context = new FakeFilterContext()
    const resampler = new FakeResamplerNode()
    const filter = {
      ...createFilterNodeConfig('resampler', 'rate'),
      targetSampleRateHz: 16_000,
    }

    const compiled = compileFilterChain(
      context,
      [filter],
      () => resampler as unknown as AudioNode,
    )

    expect(compiled).toEqual([resampler])
    expect(resampler.targetSampleRateHz.value).toBe(16_000)
  })

  it('compiles every equalizer preset into its ordered peaking bank', () => {
    for (const eqBandCount of EQ_BAND_COUNTS) {
      const context = new FakeFilterContext()
      const preset = EQ_BAND_PRESETS[eqBandCount]
      const equalizer = {
        ...createFilterNodeConfig('equalizer', `tone-shape-${eqBandCount}`),
        eqBandCount,
        eqGainsDb: preset.frequenciesHz.map((_, index) => index - 4),
      }

      const compiled = compileFilterChain(context, [equalizer])

      expect(compiled).toHaveLength(preset.frequenciesHz.length)
      expect(context.nodes.map((node) => node.type)).toEqual(
        preset.frequenciesHz.map(() => 'peaking'),
      )
      expect(context.nodes.map((node) => node.frequency.value)).toEqual(preset.frequenciesHz)
      expect(context.nodes.map((node) => node.Q.value)).toEqual(
        preset.frequenciesHz.map(() => preset.q),
      )
      expect(context.nodes.map((node) => node.gain.value)).toEqual(equalizer.eqGainsDb)
    }
  })

  it('remaps equalizer gains across presets on a logarithmic frequency scale', () => {
    const sevenBandGains = [-6, -3, 0, 4, 8, 2, -4]
    const tenBandGains = remapEqGainsDb(sevenBandGains, 7, 10)
    const fifteenBandGains = remapEqGainsDb(tenBandGains, 10, 15)

    expect(tenBandGains).toHaveLength(10)
    expect(tenBandGains[0]).toBe(-6)
    expect(tenBandGains[5]).toBeCloseTo(4, 8)
    expect(tenBandGains.at(-1)).toBe(-4)
    expect(fifteenBandGains).toHaveLength(15)
    expect(fifteenBandGains.every((gainDb) => Number.isFinite(gainDb))).toBe(true)
  })

  it('deep-copies equalizer bands', () => {
    const equalizer = createFilterNodeConfig('equalizer', 'eq')
    const copy = cloneFilterNodeConfig(equalizer)

    expect(copy).not.toBe(equalizer)
    expect(copy.eqGainsDb).not.toBe(equalizer.eqGainsDb)
    expect(copy.eqGainsDb).toEqual(equalizer.eqGainsDb)
  })

  it('rejects duplicate ids and unsafe parameter ranges', () => {
    const lowpass = createFilterNodeConfig('lowpass', 'same')

    expect(() => validateFilterChain([lowpass, { ...lowpass }])).toThrow('unique')
    expect(() => validateFilterChain([{ ...lowpass, frequencyHz: 0 }])).toThrow('frequency')
    expect(() => validateFilterChain([{ ...lowpass, q: Number.NaN }])).toThrow('Filter Q')
    expect(() => validateFilterChain([{ ...lowpass, gainDb: 41 }])).toThrow('gain')
    expect(() => validateFilterChain([{
      ...createFilterNodeConfig('resampler', 'rate'),
      targetSampleRateHz: 2_999,
    }])).toThrow('sample rate')
    expect(() => validateFilterChain([{
      ...createFilterNodeConfig('resampler', 'rate'),
      resamplingAlgorithm: 'nearest' as never,
    }])).toThrow('algorithm')
    expect(() => validateFilterChain([{
      ...createFilterNodeConfig('equalizer', 'eq'),
      eqGainsDb: [0, 0],
    }])).toThrow('10 bands')
    expect(() => validateFilterChain([{
      ...createFilterNodeConfig('equalizer', 'eq'),
      eqGainsDb: [0, 0, 0, 0, 0, 0, 0, 0, 0, 25],
    }])).toThrow('Equalizer gain')
    expect(() => validateFilterChain([{
      ...createFilterNodeConfig('equalizer', 'eq'),
      eqBandCount: 12 as EqBandCount,
    }])).toThrow('band count')
  })
})
