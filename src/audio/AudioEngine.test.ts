import { describe, expect, it } from 'vitest'

import { AudioEngine } from './AudioEngine'
import { createFilterNodeConfig } from './filterGraph'

class FakeAudioParam {
  value = 1
  readonly calls: Array<
    | { type: 'cancel'; time: number }
    | { type: 'hold'; time: number }
    | { type: 'set'; value: number; time: number }
    | { type: 'ramp'; value: number; time: number }
  > = []

  cancelScheduledValues(time: number): FakeAudioParam {
    this.calls.push({ type: 'cancel', time })
    return this
  }

  cancelAndHoldAtTime(time: number): FakeAudioParam {
    this.calls.push({ type: 'hold', time })
    return this
  }

  setValueAtTime(value: number, time: number): FakeAudioParam {
    this.value = value
    this.calls.push({ type: 'set', value, time })
    return this
  }

  linearRampToValueAtTime(value: number, time: number): FakeAudioParam {
    this.value = value
    this.calls.push({ type: 'ramp', value, time })
    return this
  }
}

interface FakeConnection {
  readonly destination: unknown
  readonly output: number
  readonly input: number
}

class FakeGainNode {
  readonly gain = new FakeAudioParam()
  readonly connections: FakeConnection[] = []
  connected = false
  disconnected = false

  connect(destination: unknown, output = 0, input = 0): FakeGainNode {
    this.connected = true
    this.connections.push({ destination, output, input })
    return this
  }

  disconnect(): void {
    this.disconnected = true
  }
}

class FakeChannelSplitterNode {
  readonly connections: FakeConnection[] = []
  disconnected = false

  constructor(readonly numberOfOutputs: number) {}

  connect(destination: unknown, output = 0, input = 0): FakeChannelSplitterNode {
    this.connections.push({ destination, output, input })
    return this
  }

  disconnect(): void {
    this.disconnected = true
  }
}

class FakeChannelMergerNode {
  readonly connections: FakeConnection[] = []
  disconnected = false

  constructor(readonly numberOfInputs: number) {}

  connect(destination: unknown, output = 0, input = 0): FakeChannelMergerNode {
    this.connections.push({ destination, output, input })
    return this
  }

  disconnect(): void {
    this.disconnected = true
  }
}

class FakeBiquadFilterNode {
  type: BiquadFilterType = 'lowpass'
  responseMagnitude = 0.5
  readonly frequency = new FakeAudioParam()
  readonly Q = new FakeAudioParam()
  readonly gain = new FakeAudioParam()
  readonly connections: FakeConnection[] = []
  disconnected = false

  connect(destination: unknown, output = 0, input = 0): FakeBiquadFilterNode {
    this.connections.push({ destination, output, input })
    return this
  }

  disconnect(): void {
    this.disconnected = true
  }

  getFrequencyResponse(
    _frequencyHz: Float32Array,
    magnitude: Float32Array,
    phase: Float32Array,
  ): void {
    magnitude.fill(this.responseMagnitude)
    phase.fill(0)
  }
}

class FakeBufferSourceNode {
  buffer: AudioBuffer | null = null
  readonly playbackRate = new FakeAudioParam()
  onended: (() => void) | null = null
  readonly starts: Array<{ when: number; offset: number; duration: number | undefined }> = []
  readonly connections: FakeConnection[] = []
  connected = false
  disconnected = false
  stopped = false

  connect(destination: unknown, output = 0, input = 0): FakeBufferSourceNode {
    this.connected = true
    this.connections.push({ destination, output, input })
    return this
  }

  disconnect(): void {
    this.disconnected = true
  }

  start(when = 0, offset = 0, duration?: number): void {
    this.starts.push({ when, offset, duration })
  }

  stop(): void {
    this.stopped = true
  }

  finish(): void {
    this.onended?.()
  }
}

class FakeAudioContext {
  currentTime = 0
  readonly sampleRate = 48_000
  state: AudioContextState
  readonly destination = {} as AudioDestinationNode
  readonly gains: FakeGainNode[] = []
  readonly splitters: FakeChannelSplitterNode[] = []
  readonly mergers: FakeChannelMergerNode[] = []
  readonly filters: FakeBiquadFilterNode[] = []
  readonly sources: FakeBufferSourceNode[] = []
  resumeError: Error | null = null
  closed = false
  private readonly stateListeners = new Set<() => void>()

  constructor(state: AudioContextState = 'running') {
    this.state = state
  }

  get gain(): FakeGainNode {
    const masterGain = this.gains[0]
    if (!masterGain) {
      throw new Error('Master gain has not been created')
    }
    return masterGain
  }

  createGain(): GainNode {
    const gain = new FakeGainNode()
    this.gains.push(gain)
    return gain as unknown as GainNode
  }

  createChannelSplitter(numberOfOutputs = 6): ChannelSplitterNode {
    const splitter = new FakeChannelSplitterNode(numberOfOutputs)
    this.splitters.push(splitter)
    return splitter as unknown as ChannelSplitterNode
  }

  createChannelMerger(numberOfInputs = 6): ChannelMergerNode {
    const merger = new FakeChannelMergerNode(numberOfInputs)
    this.mergers.push(merger)
    return merger as unknown as ChannelMergerNode
  }

  createBiquadFilter(): BiquadFilterNode {
    const filter = new FakeBiquadFilterNode()
    this.filters.push(filter)
    return filter as unknown as BiquadFilterNode
  }

  createBufferSource(): AudioBufferSourceNode {
    const source = new FakeBufferSourceNode()
    this.sources.push(source)
    return source as unknown as AudioBufferSourceNode
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'statechange') {
      this.stateListeners.add(toListener(listener))
    }
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (type === 'statechange') {
      this.stateListeners.delete(toListener(listener))
    }
  }

  async resume(): Promise<void> {
    if (this.resumeError) {
      throw this.resumeError
    }
    this.setState('running')
  }

  async close(): Promise<void> {
    this.closed = true
    this.setState('closed')
  }

  setState(state: AudioContextState): void {
    this.state = state
    for (const listener of this.stateListeners) {
      listener()
    }
  }
}

const listenerWrappers = new WeakMap<EventListenerObject, () => void>()

function toListener(listener: EventListenerOrEventListenerObject): () => void {
  if (typeof listener === 'function') {
    return listener as () => void
  }
  const existing = listenerWrappers.get(listener)
  if (existing) {
    return existing
  }
  const wrapper = () => listener.handleEvent(new Event('statechange'))
  listenerWrappers.set(listener, wrapper)
  return wrapper
}

function createAudioBuffer(length = 1_000, sampleRate = 1_000, channels = 2): AudioBuffer {
  const channelData = Array.from({ length: channels }, () => new Float32Array(length))
  return {
    duration: length / sampleRate,
    length,
    numberOfChannels: channels,
    sampleRate,
    getChannelData: (channel: number) => channelData[channel],
  } as unknown as AudioBuffer
}

function createEngine(context: FakeAudioContext): AudioEngine {
  return new AudioEngine({ context: context as unknown as AudioContext, gainRampSeconds: 0 })
}

describe('AudioEngine', () => {
  it('loads an AudioBuffer and exposes an integer-sample snapshot', () => {
    const context = new FakeAudioContext()
    const engine = createEngine(context)

    const snapshot = engine.load('asset-a', createAudioBuffer())

    expect(snapshot).toMatchObject({
      kind: 'ready',
      assetId: 'asset-a',
      positionSample: 0,
      durationSamples: 1_000,
      durationSeconds: 1,
      sampleRate: 1_000,
      numberOfChannels: 2,
      channelMuted: [false, false],
      channelSolo: [false, false],
    })
  })

  it('routes every source channel through an independent gain and rebuilds on load', async () => {
    const context = new FakeAudioContext()
    const engine = createEngine(context)

    engine.load('asset-a', createAudioBuffer(1_000, 1_000, 3))

    const firstSplitter = context.splitters[0]
    const firstMerger = context.mergers[0]
    const firstChannelGains = context.gains.slice(1, 4)
    expect(firstSplitter?.numberOfOutputs).toBe(3)
    expect(firstMerger?.numberOfInputs).toBe(3)
    expect(firstSplitter?.connections).toEqual(
      firstChannelGains.map((gain, channelIndex) => ({
        destination: gain,
        output: channelIndex,
        input: 0,
      })),
    )
    firstChannelGains.forEach((gain, channelIndex) => {
      expect(gain.connections).toEqual([
        { destination: firstMerger, output: 0, input: channelIndex },
      ])
    })
    expect(firstMerger?.connections).toEqual([
      { destination: context.gain, output: 0, input: 0 },
    ])

    await engine.play()
    expect(context.sources[0]?.connections).toEqual([
      { destination: firstSplitter, output: 0, input: 0 },
    ])

    engine.setChannelMuted(1, true)
    engine.setChannelSolo(2, true)
    const nextSnapshot = engine.load('asset-b', createAudioBuffer(1_000, 1_000, 2))

    expect(context.sources[0]).toMatchObject({ stopped: true, disconnected: true, buffer: null })
    expect(firstSplitter?.disconnected).toBe(true)
    expect(firstMerger?.disconnected).toBe(true)
    expect(firstChannelGains.every((gain) => gain.disconnected)).toBe(true)
    expect(context.splitters[1]?.numberOfOutputs).toBe(2)
    expect(context.mergers[1]?.numberOfInputs).toBe(2)
    expect(nextSnapshot).toMatchObject({
      assetId: 'asset-b',
      numberOfChannels: 2,
      channelMuted: [false, false],
      channelSolo: [false, false],
    })
  })

  it('applies deterministic per-channel mute and solo precedence', () => {
    const context = new FakeAudioContext()
    const engine = createEngine(context)
    const initial = engine.load(createAudioBuffer(1_000, 1_000, 4))
    const channelGains = context.gains.slice(1, 5)

    expect(initial.channelMuted).toEqual([false, false, false, false])
    expect(initial.channelSolo).toEqual([false, false, false, false])
    expect(channelGains.map((gain) => gain.gain.value)).toEqual([1, 1, 1, 1])

    expect(engine.setChannelMuted(1, true)).toMatchObject({
      channelMuted: [false, true, false, false],
      channelSolo: [false, false, false, false],
    })
    expect(channelGains.map((gain) => gain.gain.value)).toEqual([1, 0, 1, 1])

    engine.setChannelSolo(2, true)
    expect(channelGains.map((gain) => gain.gain.value)).toEqual([0, 0, 1, 0])

    engine.setChannelSolo(1, true)
    expect(channelGains.map((gain) => gain.gain.value)).toEqual([0, 0, 1, 0])

    engine.setChannelSolo(2, false)
    expect(channelGains.map((gain) => gain.gain.value)).toEqual([0, 0, 0, 0])

    engine.setChannelMuted(1, false)
    expect(engine.snapshot()).toMatchObject({
      channelMuted: [false, false, false, false],
      channelSolo: [false, true, false, false],
    })
    expect(channelGains.map((gain) => gain.gain.value)).toEqual([0, 1, 0, 0])

    engine.setChannelSolo(1, false)
    expect(channelGains.map((gain) => gain.gain.value)).toEqual([1, 1, 1, 1])
  })

  it('ramps channel changes without restarting playback or touching the master gain', async () => {
    const context = new FakeAudioContext()
    const engine = new AudioEngine({
      context: context as unknown as AudioContext,
      gainRampSeconds: 0.02,
    })
    engine.load(createAudioBuffer(1_000, 1_000, 2))
    await engine.play()

    const source = context.sources[0]
    const channelGains = context.gains.slice(1, 3)
    const masterCallCount = context.gain.gain.calls.length
    channelGains.forEach((gain) => {
      gain.gain.calls.length = 0
    })
    context.currentTime = 0.25

    engine.setChannelSolo(0, true)

    expect(context.sources).toHaveLength(1)
    expect(source).toMatchObject({ stopped: false, disconnected: false })
    expect(context.gain.gain.calls).toHaveLength(masterCallCount)
    expect(channelGains[0]?.gain.calls).toContainEqual({ type: 'hold', time: 0.25 })
    expect(channelGains[1]?.gain.calls).toContainEqual({ type: 'hold', time: 0.25 })
    expect(channelGains[0]?.gain.calls).toContainEqual({ type: 'ramp', value: 1, time: 0.27 })
    expect(channelGains[1]?.gain.calls).toContainEqual({ type: 'ramp', value: 0, time: 0.27 })
  })

  it('compiles a serial filter chain and switches dry/filtered audition without restarting', async () => {
    const context = new FakeAudioContext()
    const engine = createEngine(context)
    engine.load(createAudioBuffer())
    await engine.play()
    const source = context.sources[0]
    const merger = context.mergers[0]

    engine.setFilterChain([
      { ...createFilterNodeConfig('highpass', 'cut-rumble'), frequencyHz: 90 },
      { ...createFilterNodeConfig('notch', 'bypass-hum'), enabled: false },
      { ...createFilterNodeConfig('peaking', 'presence'), frequencyHz: 3_200, gainDb: 4 },
    ])

    const dryGain = context.gains.at(-2)
    const filteredGain = context.gains.at(-1)
    expect(context.filters).toHaveLength(2)
    expect(context.filters.map((filter) => filter.type)).toEqual(['highpass', 'peaking'])
    expect(context.filters[0]?.connections[0]?.destination).toBe(context.filters[1])
    expect(context.filters[1]?.connections[0]?.destination).toBe(filteredGain)
    expect(merger?.connections.slice(-2).map(({ destination }) => destination)).toEqual([
      dryGain,
      context.filters[0],
    ])
    expect([dryGain?.gain.value, filteredGain?.gain.value]).toEqual([1, 0])

    engine.setFilterAudition('filtered')

    expect([dryGain?.gain.value, filteredGain?.gain.value]).toEqual([0, 1])
    expect(context.sources).toHaveLength(1)
    expect(source).toMatchObject({ stopped: false, disconnected: false })
    expect(engine.getFilterAudition()).toBe('filtered')
  })

  it('combines compiled filter magnitude responses in decibels', () => {
    const context = new FakeAudioContext()
    const engine = createEngine(context)
    engine.setFilterChain([
      createFilterNodeConfig('highpass', 'remove-rumble'),
      { ...createFilterNodeConfig('notch', 'bypass-hum'), enabled: false },
      createFilterNodeConfig('peaking', 'presence'),
    ])

    const response = engine.getFilterFrequencyResponseDb(
      new Float32Array([0, 1_000, 24_000, 48_000]),
    )

    expect(response).toHaveLength(4)
    expect(Array.from(response)).toEqual(
      expect.arrayContaining([
        expect.closeTo(20 * Math.log10(0.25), 5),
      ]),
    )
    expect(Array.from(response).every((value) => value === response[0])).toBe(true)
  })

  it('includes the resampler anti-alias response in spectrum previews', () => {
    const engine = createEngine(new FakeAudioContext())
    engine.setFilterChain([{
      ...createFilterNodeConfig('resampler', 'rate'),
      targetSampleRateHz: 12_000,
    }])

    const response = engine.getFilterFrequencyResponseDb(
      new Float32Array([0, 1_000, 10_000, 20_000]),
    )

    expect(response[0]).toBeCloseTo(0, 5)
    expect(response[2]).toBeLessThan(response[1] ?? 0)
    expect(response[3]).toBeLessThan(response[2] ?? 0)
  })

  it('releases replaced filter nodes and keeps exposed configuration immutable', () => {
    const context = new FakeAudioContext()
    const engine = createEngine(context)
    const first = createFilterNodeConfig('lowpass', 'tone')

    engine.setFilterChain([first])
    engine.load(createAudioBuffer())
    const exposed = engine.getFilterChain()
    const exposedNode = exposed[0] as unknown as { frequencyHz: number }
    exposedNode.frequencyHz = 10
    expect(engine.getFilterChain()[0]?.frequencyHz).toBe(first.frequencyHz)

    const oldFilter = context.filters[0]
    const oldDry = context.gains[1]
    const oldFiltered = context.gains[2]
    engine.setFilterChain([{ ...first, frequencyHz: 2_500 }])

    expect(context.filters).toHaveLength(1)
    expect(oldFilter?.frequency.value).toBe(2_500)
    expect(oldFilter?.disconnected).toBe(false)

    engine.setFilterChain([
      { ...createFilterNodeConfig('highpass', first.id), frequencyHz: 2_500 },
    ])

    expect(oldFilter?.disconnected).toBe(true)
    expect(oldDry?.disconnected).toBe(true)
    expect(oldFiltered?.disconnected).toBe(true)
    expect(engine.getFilterChain()[0]?.frequencyHz).toBe(2_500)

    engine.setFilterChain([])
    expect(engine.getFilterChain()).toEqual([])
    expect(context.mergers[0]?.connections.at(-1)?.destination).toBe(context.gain)
  })

  it('returns channel state copies that cannot mutate engine state', () => {
    const engine = createEngine(new FakeAudioContext())
    const snapshot = engine.load(createAudioBuffer())
    const exposedMuted = snapshot.channelMuted as boolean[]
    const exposedSolo = snapshot.channelSolo as boolean[]

    exposedMuted[0] = true
    exposedSolo[1] = true

    expect(engine.snapshot()).toMatchObject({
      channelMuted: [false, false],
      channelSolo: [false, false],
    })
  })

  it('derives playback position from the context clock and freezes it on pause', async () => {
    const context = new FakeAudioContext()
    const engine = createEngine(context)
    engine.load(createAudioBuffer())

    await engine.play()
    context.currentTime = 0.2514

    expect(engine.snapshot().positionSample).toBe(251)
    expect(engine.pause()).toMatchObject({ kind: 'paused', positionSample: 251 })
    expect(context.sources[0]).toMatchObject({ stopped: true, disconnected: true, buffer: null })

    context.currentTime = 2
    expect(engine.snapshot().positionSample).toBe(251)
  })

  it('ignores an ended callback from a superseded seek session', async () => {
    const context = new FakeAudioContext()
    const engine = createEngine(context)
    engine.load(createAudioBuffer())
    await engine.play()

    const firstSource = context.sources[0]
    const staleEnded = firstSource?.onended
    engine.seek(400)

    expect(context.sources).toHaveLength(2)
    expect(engine.snapshot()).toMatchObject({ kind: 'playing', positionSample: 400 })

    staleEnded?.()
    expect(engine.snapshot()).toMatchObject({ kind: 'playing', positionSample: 400 })

    context.sources[1]?.finish()
    expect(engine.snapshot()).toMatchObject({ kind: 'ended', positionSample: 1_000 })
  })

  it('rebuilds sessions at exact selection boundaries when looping', async () => {
    const context = new FakeAudioContext()
    const engine = createEngine(context)
    engine.load(createAudioBuffer())
    engine.setSelection({ start: 100, end: 200 })
    engine.setLoop(true)

    await engine.play()
    expect(context.sources[0]?.starts[0]).toEqual({ when: 0, offset: 0.1, duration: 0.1 })

    context.sources[0]?.finish()

    expect(context.sources).toHaveLength(2)
    expect(context.sources[1]?.starts[0]).toEqual({ when: 0, offset: 0.1, duration: 0.1 })
    expect(engine.snapshot()).toMatchObject({
      kind: 'playing',
      positionSample: 100,
      selection: { start: 100, end: 200 },
      loop: true,
    })
  })

  it('does not interrupt active playback when editing a non-looping selection', async () => {
    const context = new FakeAudioContext()
    const engine = createEngine(context)
    engine.load(createAudioBuffer())
    await engine.play()

    engine.setSelection({ start: 100, end: 200 })

    expect(context.sources).toHaveLength(1)
    expect(context.sources[0]).toMatchObject({ stopped: false, disconnected: false })
    expect(engine.snapshot()).toMatchObject({
      kind: 'playing',
      selection: { start: 100, end: 200 },
    })
  })

  it('returns stop to the selection start and preserves volume and rate', async () => {
    const context = new FakeAudioContext()
    const engine = createEngine(context)
    engine.load(createAudioBuffer())
    engine.setSelection({ start: 120, end: 400 })
    engine.setVolume(0.25)
    engine.setMuted(true)
    expect(context.gain.gain.value).toBe(0)
    engine.setMuted(false)
    expect(context.gain.gain.value).toBe(0.25)

    await engine.play()
    context.currentTime = 0.1
    engine.setRate(2)

    expect(context.sources[1]?.playbackRate.value).toBe(2)
    context.currentTime = 0.2
    expect(engine.snapshot().positionSample).toBe(300)
    expect(engine.stop()).toMatchObject({
      kind: 'ready',
      positionSample: 120,
      volume: 0.25,
      playbackRate: 2,
    })
  })

  it('resumes a locked context only as part of play', async () => {
    const context = new FakeAudioContext('suspended')
    const engine = createEngine(context)

    expect(engine.load(createAudioBuffer()).kind).toBe('locked')
    expect(context.sources).toHaveLength(0)

    await engine.play()
    expect(engine.snapshot().kind).toBe('playing')
    expect(context.sources).toHaveLength(1)
  })

  it('preserves a sampled position and locks when the context is suspended', async () => {
    const context = new FakeAudioContext()
    const engine = createEngine(context)
    engine.load(createAudioBuffer())
    await engine.play()
    context.currentTime = 0.175

    context.setState('suspended')

    expect(engine.snapshot()).toMatchObject({ kind: 'locked', positionSample: 175 })
    expect(context.sources[0]).toMatchObject({ stopped: true, disconnected: true, buffer: null })
  })

  it('unloads sources and rejects stale ended events after resource release', async () => {
    const context = new FakeAudioContext()
    const engine = createEngine(context)
    engine.load(createAudioBuffer())
    const splitter = context.splitters[0]
    const merger = context.mergers[0]
    const channelGains = context.gains.slice(1, 3)
    await engine.play()
    const staleEnded = context.sources[0]?.onended

    expect(engine.unload().kind).toBe('empty')
    staleEnded?.()

    expect(engine.snapshot()).toMatchObject({
      kind: 'empty',
      assetId: null,
      durationSamples: 0,
      sessionId: null,
      channelMuted: [],
      channelSolo: [],
    })
    expect(context.sources[0]).toMatchObject({ stopped: true, disconnected: true, buffer: null })
    expect(splitter?.disconnected).toBe(true)
    expect(merger?.disconnected).toBe(true)
    expect(channelGains.every((gain) => gain.disconnected)).toBe(true)

    await engine.dispose()
    expect(context.gain.disconnected).toBe(true)
    expect(context.closed).toBe(false)
  })

  it('closes a context created by the engine when disposed', async () => {
    const context = new FakeAudioContext()
    const engine = new AudioEngine({
      contextFactory: () => context as unknown as AudioContext,
      gainRampSeconds: 0,
    })
    engine.load(createAudioBuffer())

    await engine.dispose()

    expect(context.gain.disconnected).toBe(true)
    expect(context.closed).toBe(true)
    await expect(engine.dispose()).resolves.toBeUndefined()
  })

  it('validates sample boundaries and playback controls', () => {
    const engine = createEngine(new FakeAudioContext())
    engine.load(createAudioBuffer())

    expect(() => engine.seek(1.5)).toThrow(RangeError)
    expect(() => engine.setSelection({ start: 10, end: 10 })).toThrow(RangeError)
    expect(() => engine.setVolume(1.1)).toThrow(RangeError)
    expect(() => engine.setPlaybackRate(2.1)).toThrow(RangeError)
    expect(() => engine.setChannelMuted(-1, true)).toThrow(RangeError)
    expect(() => engine.setChannelMuted(2, true)).toThrow(RangeError)
    expect(() => engine.setChannelSolo(0.5, true)).toThrow(RangeError)

    engine.unload()
    expect(() => engine.setChannelSolo(0, true)).toThrow(RangeError)
  })
})
