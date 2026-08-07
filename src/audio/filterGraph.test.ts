import { describe, expect, it } from 'vitest'

import {
  EQ_BAND_FREQUENCIES_HZ,
  EQ_BAND_Q,
  FILTER_DEFINITIONS,
  cloneFilterNodeConfig,
  compileFilterChain,
  createFilterNodeConfig,
  validateFilterChain,
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
    })
    expect(createFilterNodeConfig('equalizer', 'eq').eqGainsDb).toEqual(
      EQ_BAND_FREQUENCIES_HZ.map(() => 0),
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

  it('compiles one equalizer node into an ordered seven-band peaking bank', () => {
    const context = new FakeFilterContext()
    const equalizer = {
      ...createFilterNodeConfig('equalizer', 'tone-shape'),
      eqGainsDb: [-6, -3, 0, 2, 4, 1, -2],
    }

    const compiled = compileFilterChain(context, [equalizer])

    expect(compiled).toHaveLength(EQ_BAND_FREQUENCIES_HZ.length)
    expect(context.nodes.map((node) => node.type)).toEqual(
      EQ_BAND_FREQUENCIES_HZ.map(() => 'peaking'),
    )
    expect(context.nodes.map((node) => node.frequency.value)).toEqual(EQ_BAND_FREQUENCIES_HZ)
    expect(context.nodes.map((node) => node.Q.value)).toEqual(
      EQ_BAND_FREQUENCIES_HZ.map(() => EQ_BAND_Q),
    )
    expect(context.nodes.map((node) => node.gain.value)).toEqual(equalizer.eqGainsDb)
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
      ...createFilterNodeConfig('equalizer', 'eq'),
      eqGainsDb: [0, 0],
    }])).toThrow('7 bands')
    expect(() => validateFilterChain([{
      ...createFilterNodeConfig('equalizer', 'eq'),
      eqGainsDb: [0, 0, 0, 0, 0, 0, 25],
    }])).toThrow('Equalizer gain')
  })
})
