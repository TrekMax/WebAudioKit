import { describe, expect, it } from 'vitest'

import { AudioEngine } from './AudioEngine'

class FakeAudioParam {
  value = 1

  cancelScheduledValues(): FakeAudioParam {
    return this
  }

  setValueAtTime(value: number): FakeAudioParam {
    this.value = value
    return this
  }

  linearRampToValueAtTime(value: number): FakeAudioParam {
    this.value = value
    return this
  }
}

class FakeGainNode {
  readonly gain = new FakeAudioParam()
  connected = false
  disconnected = false

  connect(): FakeGainNode {
    this.connected = true
    return this
  }

  disconnect(): void {
    this.disconnected = true
  }
}

class FakeBufferSourceNode {
  buffer: AudioBuffer | null = null
  readonly playbackRate = new FakeAudioParam()
  onended: (() => void) | null = null
  readonly starts: Array<{ when: number; offset: number; duration: number | undefined }> = []
  connected = false
  disconnected = false
  stopped = false

  connect(): FakeBufferSourceNode {
    this.connected = true
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
  state: AudioContextState
  readonly destination = {} as AudioDestinationNode
  readonly gain = new FakeGainNode()
  readonly sources: FakeBufferSourceNode[] = []
  resumeError: Error | null = null
  closed = false
  private readonly stateListeners = new Set<() => void>()

  constructor(state: AudioContextState = 'running') {
    this.state = state
  }

  createGain(): GainNode {
    return this.gain as unknown as GainNode
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
    await engine.play()
    const staleEnded = context.sources[0]?.onended

    expect(engine.unload().kind).toBe('empty')
    staleEnded?.()

    expect(engine.snapshot()).toMatchObject({
      kind: 'empty',
      assetId: null,
      durationSamples: 0,
      sessionId: null,
    })
    expect(context.sources[0]).toMatchObject({ stopped: true, disconnected: true, buffer: null })

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
  })
})
