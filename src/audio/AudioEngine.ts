import {
  assertSampleRange,
  assertSampleRate,
  isSampleIndex,
  sampleIndexToSeconds,
  secondsToSampleIndex,
  type AssetId,
  type AudioEngineOptions,
  type LoadAudioOptions,
  type PlaybackKind,
  type PlaybackListener,
  type PlaybackSnapshot,
  type SampleIndex,
  type SampleRange,
} from './types'
import {
  applyFilterNodeConfig,
  cloneFilterNodeConfig,
  compileFilterChain,
  compiledFilterNodeCount,
  validateFilterChain,
  type FilterAuditionMode,
  type FilterNodeConfig,
} from './filterGraph'
import resamplerWorkletUrl from '../worklets/resampler.worklet.js?worker&url'

const MIN_PLAYBACK_RATE = 0.5
const MAX_PLAYBACK_RATE = 2
const DEFAULT_GAIN_RAMP_SECONDS = 0.005

interface PlaybackSession {
  readonly id: string
  readonly node: AudioBufferSourceNode
  readonly anchorContextTime: number
  readonly anchorSample: SampleIndex
  readonly endSample: SampleIndex
  readonly rate: number
}

interface ChannelRouting {
  readonly splitter: ChannelSplitterNode
  readonly gains: GainNode[]
  readonly merger: ChannelMergerNode
}

interface FilterRouting {
  readonly dryGain: GainNode
  readonly filteredGain: GainNode
  readonly filters: readonly AudioNode[]
  readonly filterGroups: readonly {
    readonly id: string
    readonly type: FilterNodeConfig['type']
    readonly nodes: readonly AudioNode[]
  }[]
  readonly responseFilters: readonly BiquadFilterNode[]
}

const RESAMPLER_PROCESSOR_NAME = 'webaudio-kit-resampler'

type StateBeforeLock = 'ready' | 'paused' | 'ended'

/**
 * Owns the one-shot AudioBufferSourceNode lifecycle for a single active asset.
 * Positions and selections are stored as integer PCM frame indexes; seconds are
 * only calculated at the Web Audio and UI boundaries.
 */
export class AudioEngine {
  private readonly context: AudioContext
  private readonly gainNode: GainNode
  private readonly ownsContext: boolean
  private readonly gainRampSeconds: number
  private readonly listeners = new Set<PlaybackListener>()

  private buffer: AudioBuffer | null = null
  private splitterNode: ChannelSplitterNode | null = null
  private mergerNode: ChannelMergerNode | null = null
  private channelGainNodes: GainNode[] = []
  private channelMuted: boolean[] = []
  private channelSolo: boolean[] = []
  private filterRouting: FilterRouting | null = null
  private filterChain: FilterNodeConfig[] = []
  private filterAudition: FilterAuditionMode = 'original'
  private assetId: AssetId | null = null
  private kind: PlaybackKind = 'empty'
  private positionSample: SampleIndex = 0
  private selection: SampleRange | null = null
  private loop = false
  private volume = 1
  private muted = false
  private outputChannelEnabled: [boolean, boolean] = [true, true]
  private outputBalance = 0
  private playbackRate = 1
  private activeSession: PlaybackSession | null = null
  private sessionSequence = 0
  private loadSequence = 0
  private stateBeforeLock: StateBeforeLock | null = null
  private errorMessage: string | null = null
  private disposed = false
  private resamplerWorkletReady = false

  private readonly handleContextStateChange = (): void => {
    if (this.disposed || !this.buffer) {
      return
    }

    if (this.context.state === 'running') {
      if (this.kind === 'locked') {
        this.kind = this.stateBeforeLock ?? 'paused'
        this.stateBeforeLock = null
        this.emit()
      }
      return
    }

    if (this.context.state === 'closed') {
      this.positionSample = this.getCurrentPositionSample()
      this.stopActiveSession()
      this.kind = 'error'
      this.errorMessage = 'Audio context is closed'
      this.stateBeforeLock = null
      this.emit()
      return
    }

    const previousKind = this.kind
    this.positionSample = this.getCurrentPositionSample()
    this.stopActiveSession()
    this.stateBeforeLock = previousKind === 'playing' ? 'paused' : toStateBeforeLock(previousKind)
    this.kind = 'locked'
    this.emit()
  }

  constructor(options: AudioEngineOptions = {}) {
    if (options.context && options.contextFactory) {
      throw new Error('Provide either an AudioContext or a context factory, not both')
    }

    this.gainRampSeconds = options.gainRampSeconds ?? DEFAULT_GAIN_RAMP_SECONDS
    if (!Number.isFinite(this.gainRampSeconds) || this.gainRampSeconds < 0) {
      throw new RangeError('Gain ramp duration must be a non-negative finite number')
    }

    if (options.context) {
      this.context = options.context
      this.ownsContext = false
    } else {
      const contextFactory = options.contextFactory ?? createDefaultAudioContext
      this.context = contextFactory()
      this.ownsContext = true
    }

    this.gainNode = this.context.createGain()
    this.gainNode.gain.setValueAtTime(1, this.context.currentTime)
    this.gainNode.connect(this.context.destination)
    this.context.addEventListener('statechange', this.handleContextStateChange)
    this.prepareResamplerWorklet()
  }

  get audioContext(): AudioContext {
    return this.context
  }

  load(buffer: AudioBuffer, options?: LoadAudioOptions): PlaybackSnapshot
  load(assetId: AssetId, buffer: AudioBuffer, options?: Omit<LoadAudioOptions, 'assetId'>): PlaybackSnapshot
  load(
    bufferOrAssetId: AudioBuffer | AssetId,
    bufferOrOptions: AudioBuffer | LoadAudioOptions = {},
    maybeOptions: Omit<LoadAudioOptions, 'assetId'> = {},
  ): PlaybackSnapshot {
    this.assertNotDisposed()

    const { buffer, options } = resolveLoadArguments(bufferOrAssetId, bufferOrOptions, maybeOptions)
    validateAudioBuffer(buffer)

    const selection = options.selection ?? null
    if (selection) {
      assertSampleRange(selection, buffer.length)
    }

    const requestedPosition = options.positionSample ?? selection?.start ?? 0
    if (!isSampleIndex(requestedPosition) || requestedPosition > buffer.length) {
      throw new RangeError(`Playback position must be within [0, ${buffer.length}]`)
    }

    const nextAssetId = options.assetId ?? `audio-${++this.loadSequence}`
    if (nextAssetId.length === 0) {
      throw new RangeError('Asset id must not be empty')
    }

    // Build the replacement graph before releasing the current one so a
    // browser allocation/connection failure cannot leave the existing asset
    // in a partially unloaded state.
    const nextRouting = this.createChannelRouting(buffer.numberOfChannels)

    this.stopActiveSession()
    this.releaseChannelRouting()
    this.splitterNode = nextRouting.splitter
    this.channelGainNodes = nextRouting.gains
    this.mergerNode = nextRouting.merger
    this.channelMuted = Array.from({ length: buffer.numberOfChannels }, () => false)
    this.channelSolo = Array.from({ length: buffer.numberOfChannels }, () => false)
    this.applyChannelGains()
    this.buffer = buffer
    this.assetId = nextAssetId
    this.positionSample = requestedPosition
    this.selection = selection ? { start: selection.start, end: selection.end } : null
    this.loop = false
    this.errorMessage = null

    if (this.context.state === 'running') {
      this.kind = requestedPosition === buffer.length ? 'ended' : 'ready'
      this.stateBeforeLock = null
    } else if (this.context.state === 'closed') {
      this.kind = 'error'
      this.errorMessage = 'Audio context is closed'
      this.stateBeforeLock = null
    } else {
      this.kind = 'locked'
      this.stateBeforeLock = requestedPosition === buffer.length ? 'ended' : 'ready'
    }

    this.emit()
    return this.snapshot()
  }

  unload(): PlaybackSnapshot {
    this.assertNotDisposed()
    this.stopActiveSession()
    this.releaseChannelRouting()
    this.buffer = null
    this.assetId = null
    this.kind = 'empty'
    this.positionSample = 0
    this.selection = null
    this.loop = false
    this.stateBeforeLock = null
    this.errorMessage = null
    this.emit()
    return this.snapshot()
  }

  async play(): Promise<PlaybackSnapshot> {
    this.assertNotDisposed()
    if (!this.buffer || this.kind === 'playing') {
      return this.snapshot()
    }

    if (this.context.state === 'closed') {
      this.setError('Audio context is closed')
      return this.snapshot()
    }

    if (this.context.state !== 'running') {
      this.kind = 'locked'
      this.stateBeforeLock ??= this.positionSample === this.buffer.length ? 'ended' : 'paused'
      this.emit()

      try {
        await this.context.resume()
      } catch (error) {
        this.setError(`Unable to resume audio context: ${getErrorMessage(error)}`)
        return this.snapshot()
      }

      if (!isAudioContextRunning(this.context)) {
        this.kind = 'locked'
        this.emit()
        return this.snapshot()
      }
    }

    this.errorMessage = null
    const bounds = this.getPlaybackBounds()
    let startSample = this.positionSample
    if (
      this.kind === 'ended' ||
      startSample >= bounds.end ||
      (this.hasActiveLoopRange() && startSample < bounds.start)
    ) {
      startSample = bounds.start
    }

    this.startSession(startSample, bounds.end)
    this.emit()
    return this.snapshot()
  }

  pause(): PlaybackSnapshot {
    this.assertNotDisposed()
    if (this.kind !== 'playing') {
      return this.snapshot()
    }

    this.positionSample = this.getCurrentPositionSample()
    this.stopActiveSession()
    this.kind = 'paused'
    this.errorMessage = null
    this.emit()
    return this.snapshot()
  }

  stop(): PlaybackSnapshot {
    this.assertNotDisposed()
    if (!this.buffer) {
      return this.snapshot()
    }

    this.stopActiveSession()
    this.positionSample = this.selection?.start ?? 0
    this.errorMessage = null
    if (this.context.state === 'running') {
      this.kind = 'ready'
      this.stateBeforeLock = null
    } else if (this.context.state === 'closed') {
      this.kind = 'error'
      this.errorMessage = 'Audio context is closed'
      this.stateBeforeLock = null
    } else {
      this.kind = 'locked'
      this.stateBeforeLock = 'ready'
    }
    this.emit()
    return this.snapshot()
  }

  seek(positionSample: SampleIndex): PlaybackSnapshot {
    this.assertNotDisposed()
    if (!this.buffer) {
      return this.snapshot()
    }
    if (!isSampleIndex(positionSample) || positionSample > this.buffer.length) {
      throw new RangeError(`Playback position must be within [0, ${this.buffer.length}]`)
    }

    let nextPosition = positionSample
    if (this.hasActiveLoopRange() && this.selection) {
      if (nextPosition < this.selection.start || nextPosition >= this.selection.end) {
        nextPosition = this.selection.start
      }
    }

    const wasPlaying = this.kind === 'playing'
    this.stopActiveSession()
    this.positionSample = nextPosition
    this.errorMessage = null

    if (wasPlaying && nextPosition < this.getPlaybackBounds().end) {
      this.startSession(nextPosition, this.getPlaybackBounds().end)
    } else if (nextPosition === this.buffer.length) {
      this.kind = 'ended'
    } else if (this.context.state === 'closed') {
      this.kind = 'error'
      this.errorMessage = 'Audio context is closed'
      this.stateBeforeLock = null
    } else if (this.context.state !== 'running') {
      this.kind = 'locked'
      this.stateBeforeLock = 'paused'
    } else if (this.kind === 'ended' || this.kind === 'error' || wasPlaying) {
      this.kind = 'paused'
    }

    this.emit()
    return this.snapshot()
  }

  seekSeconds(seconds: number): PlaybackSnapshot {
    this.assertNotDisposed()
    if (!this.buffer) {
      return this.snapshot()
    }
    return this.seek(secondsToSampleIndex(seconds, this.buffer.sampleRate, this.buffer.length))
  }

  setSelection(selection: SampleRange | null): PlaybackSnapshot {
    this.assertNotDisposed()
    if (!this.buffer) {
      if (selection) {
        throw new Error('Cannot set a selection without loaded audio')
      }
      return this.snapshot()
    }
    if (selection) {
      assertSampleRange(selection, this.buffer.length)
    }

    const currentPosition = this.getCurrentPositionSample()
    const wasPlaying = this.kind === 'playing'
    const mustRestart = wasPlaying && this.loop
    if (mustRestart) {
      this.stopActiveSession()
    }
    this.selection = selection ? { start: selection.start, end: selection.end } : null
    if (mustRestart) {
      this.positionSample = currentPosition
    }

    if (mustRestart) {
      const bounds = this.getPlaybackBounds()
      const start =
        this.hasActiveLoopRange() &&
        (currentPosition < bounds.start || currentPosition >= bounds.end)
          ? bounds.start
          : currentPosition
      this.positionSample = start
      this.startSession(start, bounds.end)
    }

    this.emit()
    return this.snapshot()
  }

  clearSelection(): PlaybackSnapshot {
    return this.setSelection(null)
  }

  setLoop(enabled: boolean): PlaybackSnapshot {
    this.assertNotDisposed()
    if (this.loop === enabled) {
      return this.snapshot()
    }

    const currentPosition = this.getCurrentPositionSample()
    const wasPlaying = this.kind === 'playing'
    const mustRestart = wasPlaying && this.selection !== null
    if (mustRestart) {
      this.stopActiveSession()
    }
    this.loop = enabled
    if (mustRestart) {
      this.positionSample = currentPosition
    }

    if (mustRestart && this.buffer) {
      const bounds = this.getPlaybackBounds()
      const start =
        this.hasActiveLoopRange() &&
        (currentPosition < bounds.start || currentPosition >= bounds.end)
          ? bounds.start
          : currentPosition
      this.positionSample = start
      this.startSession(start, bounds.end)
    }

    this.emit()
    return this.snapshot()
  }

  setVolume(volume: number): PlaybackSnapshot {
    this.assertNotDisposed()
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
      throw new RangeError('Volume must be within [0, 1]')
    }
    this.volume = volume
    this.applyGain()
    this.emit()
    return this.snapshot()
  }

  setMuted(muted: boolean): PlaybackSnapshot {
    this.assertNotDisposed()
    this.muted = muted
    this.applyGain()
    this.emit()
    return this.snapshot()
  }

  toggleMuted(): PlaybackSnapshot {
    return this.setMuted(!this.muted)
  }

  setOutputChannelEnabled(channelIndex: 0 | 1, enabled: boolean): PlaybackSnapshot {
    this.assertNotDisposed()
    if ((channelIndex !== 0 && channelIndex !== 1) || typeof enabled !== 'boolean') {
      throw new RangeError('Output channel must be left (0) or right (1) with a boolean state')
    }
    if (this.outputChannelEnabled[channelIndex] === enabled) {
      return this.snapshot()
    }

    this.outputChannelEnabled[channelIndex] = enabled
    this.applyChannelGains()
    this.emit()
    return this.snapshot()
  }

  setOutputBalance(balance: number): PlaybackSnapshot {
    this.assertNotDisposed()
    if (!Number.isFinite(balance) || balance < -1 || balance > 1) {
      throw new RangeError('Output balance must be within [-1, 1]')
    }
    if (this.outputBalance === balance) {
      return this.snapshot()
    }

    this.outputBalance = balance
    this.applyChannelGains()
    this.emit()
    return this.snapshot()
  }

  setChannelMuted(channelIndex: number, muted: boolean): PlaybackSnapshot {
    this.assertNotDisposed()
    this.assertChannelIndex(channelIndex)
    if (this.channelMuted[channelIndex] === muted) {
      return this.snapshot()
    }

    this.channelMuted[channelIndex] = muted
    this.applyChannelGains()
    this.emit()
    return this.snapshot()
  }

  setChannelSolo(channelIndex: number, solo: boolean): PlaybackSnapshot {
    this.assertNotDisposed()
    this.assertChannelIndex(channelIndex)
    if (this.channelSolo[channelIndex] === solo) {
      return this.snapshot()
    }

    this.channelSolo[channelIndex] = solo
    this.applyChannelGains()
    this.emit()
    return this.snapshot()
  }

  setPlaybackRate(rate: number): PlaybackSnapshot {
    this.assertNotDisposed()
    if (!Number.isFinite(rate) || rate < MIN_PLAYBACK_RATE || rate > MAX_PLAYBACK_RATE) {
      throw new RangeError(
        `Playback rate must be within [${MIN_PLAYBACK_RATE}, ${MAX_PLAYBACK_RATE}]`,
      )
    }
    if (rate === this.playbackRate) {
      return this.snapshot()
    }

    const currentPosition = this.getCurrentPositionSample()
    const wasPlaying = this.kind === 'playing'
    this.stopActiveSession()
    this.positionSample = currentPosition
    this.playbackRate = rate

    if (wasPlaying && this.buffer) {
      const bounds = this.getPlaybackBounds()
      if (currentPosition < bounds.end) {
        this.startSession(currentPosition, bounds.end)
      } else {
        this.kind = 'ended'
      }
    }

    this.emit()
    return this.snapshot()
  }

  setRate(rate: number): PlaybackSnapshot {
    return this.setPlaybackRate(rate)
  }

  setFilterChain(filters: readonly FilterNodeConfig[]): void {
    this.assertNotDisposed()
    validateFilterChain(filters)

    if (filters.length === 0) {
      const merger = this.mergerNode
      if (merger) tryDisconnect(merger)
      this.releaseFilterRouting()
      if (merger) merger.connect(this.gainNode)
      this.filterChain = []
      return
    }

    const currentActiveFilters = this.filterChain.filter((filter) => filter.enabled)
    const nextActiveFilters = filters.filter((filter) => filter.enabled)
    if (
      this.filterRouting
      && currentActiveFilters.length === nextActiveFilters.length
      && currentActiveFilters.every((filter, index) => (
        filter.id === nextActiveFilters[index]?.id
        && filter.type === nextActiveFilters[index]?.type
        && compiledFilterNodeCount(filter) === compiledFilterNodeCount(nextActiveFilters[index]!)
      ))
    ) {
      nextActiveFilters.forEach((filter, index) => {
        const group = this.filterRouting?.filterGroups[index]
        if (group) applyFilterNodeConfig(group.nodes, filter, this.context.currentTime)
      })
      this.filterChain = filters.map(cloneFilterNodeConfig)
      return
    }

    const nextRouting = this.createFilterRouting(filters)
    this.replaceFilterRouting(nextRouting)
    this.filterChain = filters.map(cloneFilterNodeConfig)
  }

  getFilterChain(): readonly FilterNodeConfig[] {
    return this.filterChain.map(cloneFilterNodeConfig)
  }

  getFilterFrequencyResponseDb(frequenciesHz: Float32Array): Float32Array {
    this.assertNotDisposed()
    const responseDb = new Float32Array(frequenciesHz.length)
    const filters = this.filterRouting?.responseFilters
    if (frequenciesHz.length === 0) {
      return responseDb
    }

    const queryFrequenciesHz = new Float32Array(frequenciesHz.length)
    const nyquist = this.context.sampleRate / 2
    for (let index = 0; index < frequenciesHz.length; index += 1) {
      const frequencyHz = frequenciesHz[index]
      if (frequencyHz === undefined || !Number.isFinite(frequencyHz) || frequencyHz < 0) {
        throw new RangeError('Filter response frequencies must be finite and non-negative')
      }
      queryFrequenciesHz[index] = Math.min(frequencyHz, nyquist)
    }

    const magnitude = new Float32Array(frequenciesHz.length)
    const phase = new Float32Array(frequenciesHz.length)
    for (const filter of filters ?? []) {
      filter.getFrequencyResponse(queryFrequenciesHz, magnitude, phase)
      for (let index = 0; index < responseDb.length; index += 1) {
        const value = magnitude[index]
        if (value === undefined || !Number.isFinite(value)) continue
        responseDb[index] = (responseDb[index] ?? 0) + 20 * Math.log10(Math.max(value, 1e-12))
      }
    }
    for (const filter of this.filterChain) {
      if (!filter.enabled || filter.type !== 'resampler') continue
      const targetSampleRateHz = Math.min(filter.targetSampleRateHz, this.context.sampleRate)
      if (targetSampleRateHz >= this.context.sampleRate) continue
      const cutoffHz = Math.min(this.context.sampleRate * 0.45, targetSampleRateHz * 0.45)
      const alpha = 1 - Math.exp((-2 * Math.PI * cutoffHz) / this.context.sampleRate)
      const feedback = 1 - alpha
      for (let index = 0; index < responseDb.length; index += 1) {
        const frequencyHz = queryFrequenciesHz[index] ?? 0
        const omega = (2 * Math.PI * frequencyHz) / this.context.sampleRate
        const denominator = Math.sqrt(
          1 + feedback * feedback - 2 * feedback * Math.cos(omega),
        )
        const filterMagnitude = alpha / Math.max(denominator, 1e-12)
        responseDb[index] = (responseDb[index] ?? 0)
          + 20 * Math.log10(Math.max(filterMagnitude, 1e-12))
      }
    }
    return responseDb
  }

  setFilterAudition(mode: FilterAuditionMode): void {
    this.assertNotDisposed()
    if (mode !== 'original' && mode !== 'filtered') {
      throw new RangeError(`Unsupported filter audition mode: ${String(mode)}`)
    }
    this.filterAudition = mode
    this.applyFilterAudition()
  }

  getFilterAudition(): FilterAuditionMode {
    return this.filterAudition
  }

  snapshot(): PlaybackSnapshot {
    const positionSample = this.getCurrentPositionSample()
    const sampleRate = this.buffer?.sampleRate ?? null
    const durationSamples = this.buffer?.length ?? 0

    return {
      kind: this.kind,
      assetId: this.assetId,
      positionSample,
      durationSamples,
      positionSeconds: sampleRate ? positionSample / sampleRate : 0,
      durationSeconds: sampleRate ? durationSamples / sampleRate : 0,
      sampleRate,
      numberOfChannels: this.buffer?.numberOfChannels ?? 0,
      selection: this.selection
        ? { start: this.selection.start, end: this.selection.end }
        : null,
      loop: this.loop,
      volume: this.volume,
      muted: this.muted,
      outputChannelEnabled: [...this.outputChannelEnabled],
      outputBalance: this.outputBalance,
      channelMuted: [...this.channelMuted],
      channelSolo: [...this.channelSolo],
      playbackRate: this.playbackRate,
      contextState: this.context.state,
      sessionId: this.activeSession?.id ?? null,
      errorMessage: this.errorMessage,
    }
  }

  subscribe(listener: PlaybackListener): () => void {
    this.assertNotDisposed()
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return
    }

    this.unload()
    this.releaseFilterRouting()
    this.disposed = true
    this.listeners.clear()
    this.context.removeEventListener('statechange', this.handleContextStateChange)
    this.gainNode.disconnect()

    if (this.ownsContext && this.context.state !== 'closed') {
      await this.context.close()
    }
  }

  private startSession(startSample: SampleIndex, endSample: SampleIndex): void {
    const buffer = this.buffer
    if (!buffer) {
      return
    }

    if (startSample >= endSample) {
      this.positionSample = endSample
      this.kind = 'ended'
      return
    }

    const node = this.context.createBufferSource()
    const sessionId = `${this.assetId ?? 'audio'}:${++this.sessionSequence}`

    try {
      if (!this.splitterNode) {
        throw new Error('Channel routing is unavailable')
      }
      node.buffer = buffer
      node.playbackRate.setValueAtTime(this.playbackRate, this.context.currentTime)
      node.connect(this.splitterNode)

      const session: PlaybackSession = {
        id: sessionId,
        node,
        anchorContextTime: this.context.currentTime,
        anchorSample: startSample,
        endSample,
        rate: this.playbackRate,
      }
      node.onended = () => this.handleSourceEnded(sessionId)
      this.activeSession = session
      this.positionSample = startSample
      this.kind = 'playing'
      this.stateBeforeLock = null

      node.start(
        0,
        sampleIndexToSeconds(startSample, buffer.sampleRate),
        sampleIndexToSeconds(endSample - startSample, buffer.sampleRate),
      )
    } catch (error) {
      if (this.activeSession?.id === sessionId) {
        this.activeSession = null
      }
      node.onended = null
      tryDisconnect(node)
      releaseSourceBuffer(node)
      this.kind = 'error'
      this.errorMessage = `Unable to start playback: ${getErrorMessage(error)}`
    }
  }

  private handleSourceEnded(sessionId: string): void {
    const session = this.activeSession
    if (!session || session.id !== sessionId || !this.buffer) {
      return
    }

    this.activeSession = null
    session.node.onended = null
    tryDisconnect(session.node)
    releaseSourceBuffer(session.node)
    this.positionSample = session.endSample

    if (this.hasActiveLoopRange() && this.selection) {
      this.positionSample = this.selection.start
      this.startSession(this.selection.start, this.selection.end)
    } else {
      this.kind = 'ended'
    }
    this.emit()
  }

  private stopActiveSession(): void {
    const session = this.activeSession
    if (!session) {
      return
    }

    // Invalidate ownership before stop(): some implementations may dispatch an
    // ended event synchronously, and delayed callbacks from older sessions must
    // never mutate current playback state.
    this.activeSession = null
    session.node.onended = null
    try {
      session.node.stop()
    } catch {
      // A naturally ended or not-yet-started one-shot node may reject stop().
    }
    tryDisconnect(session.node)
    releaseSourceBuffer(session.node)
  }

  private getCurrentPositionSample(): SampleIndex {
    const session = this.activeSession
    const buffer = this.buffer
    if (!session || !buffer || this.kind !== 'playing') {
      return this.positionSample
    }

    const elapsedSeconds = Math.max(0, this.context.currentTime - session.anchorContextTime)
    const elapsedSamples = Math.round(elapsedSeconds * buffer.sampleRate * session.rate)
    return Math.min(session.endSample, session.anchorSample + elapsedSamples)
  }

  private getPlaybackBounds(): SampleRange {
    if (!this.buffer) {
      return { start: 0, end: 0 }
    }
    if (this.hasActiveLoopRange() && this.selection) {
      return this.selection
    }
    return { start: this.selection?.start ?? 0, end: this.buffer.length }
  }

  private hasActiveLoopRange(): boolean {
    return this.loop && this.selection !== null
  }

  private applyGain(): void {
    const target = this.muted ? 0 : this.volume
    this.rampGain(this.gainNode.gain, target)
  }

  private applyChannelGains(): void {
    const hasSolo = this.channelSolo.some(Boolean)
    for (let channelIndex = 0; channelIndex < this.channelGainNodes.length; channelIndex += 1) {
      const channelGain = this.channelGainNodes[channelIndex]
      if (!channelGain) {
        continue
      }
      const audible =
        !this.channelMuted[channelIndex] && (!hasSolo || this.channelSolo[channelIndex])
      let outputGain = 1
      if (channelIndex === 0) {
        outputGain = this.outputChannelEnabled[0]
          ? this.outputBalance > 0 ? 1 - this.outputBalance : 1
          : 0
      } else if (channelIndex === 1) {
        outputGain = this.outputChannelEnabled[1]
          ? this.outputBalance < 0 ? 1 + this.outputBalance : 1
          : 0
      }
      this.rampGain(channelGain.gain, audible ? outputGain : 0)
    }
  }

  private rampGain(gain: AudioParam, target: number): void {
    const now = this.context.currentTime
    if (typeof gain.cancelAndHoldAtTime === 'function') {
      gain.cancelAndHoldAtTime(now)
    } else {
      gain.cancelScheduledValues(now)
      gain.setValueAtTime(gain.value, now)
    }
    if (this.gainRampSeconds === 0) {
      gain.setValueAtTime(target, now)
      return
    }
    gain.linearRampToValueAtTime(target, now + this.gainRampSeconds)
  }

  private createChannelRouting(numberOfChannels: number): ChannelRouting {
    let splitter: ChannelSplitterNode | null = null
    let merger: ChannelMergerNode | null = null
    const gains: GainNode[] = []

    try {
      splitter = this.context.createChannelSplitter(numberOfChannels)
      merger = this.context.createChannelMerger(numberOfChannels)

      for (let channelIndex = 0; channelIndex < numberOfChannels; channelIndex += 1) {
        const gain = this.context.createGain()
        gains.push(gain)
        gain.gain.setValueAtTime(1, this.context.currentTime)
        splitter.connect(gain, channelIndex, 0)
        gain.connect(merger, 0, channelIndex)
      }
      this.connectMergerOutput(merger, this.filterRouting)

      return { splitter, gains, merger }
    } catch (error) {
      if (splitter) {
        tryDisconnect(splitter)
      }
      for (const gain of gains) {
        tryDisconnect(gain)
      }
      if (merger) {
        tryDisconnect(merger)
      }
      throw error
    }
  }

  private releaseChannelRouting(): void {
    const splitter = this.splitterNode
    const merger = this.mergerNode
    const gains = this.channelGainNodes

    this.splitterNode = null
    this.mergerNode = null
    this.channelGainNodes = []
    this.channelMuted = []
    this.channelSolo = []

    if (splitter) {
      tryDisconnect(splitter)
    }
    for (const gain of gains) {
      tryDisconnect(gain)
    }
    if (merger) {
      tryDisconnect(merger)
    }
  }

  private createFilterRouting(filters: readonly FilterNodeConfig[]): FilterRouting {
    const activeFilters = filters.filter((filter) => filter.enabled)
    const compiled = compileFilterChain(
      this.context,
      filters,
      (filter) => this.createResamplerNode(filter),
    )
    let compiledOffset = 0
    const filterGroups = activeFilters.map((filter) => {
      const count = compiledFilterNodeCount(filter)
      const nodes = compiled.slice(compiledOffset, compiledOffset + count)
      compiledOffset += count
      return { id: filter.id, type: filter.type, nodes }
    })
    if (compiledOffset !== compiled.length) {
      for (const node of compiled) tryDisconnect(node)
      throw new Error('Compiled filter groups do not cover the runtime chain')
    }
    const responseFilters = filterGroups.flatMap((group) => (
      group.type === 'resampler'
        ? []
        : group.nodes.map((node) => node as BiquadFilterNode)
    ))
    let dryGain: GainNode | null = null
    let filteredGain: GainNode | null = null

    try {
      dryGain = this.context.createGain()
      filteredGain = this.context.createGain()
      const originalActive = this.filterAudition === 'original'
      dryGain.gain.setValueAtTime(originalActive ? 1 : 0, this.context.currentTime)
      filteredGain.gain.setValueAtTime(originalActive ? 0 : 1, this.context.currentTime)
      dryGain.connect(this.gainNode)
      filteredGain.connect(this.gainNode)
      for (let index = 0; index < compiled.length - 1; index += 1) {
        compiled[index]?.connect(compiled[index + 1]!)
      }
      compiled.at(-1)?.connect(filteredGain)
      return { dryGain, filteredGain, filters: compiled, filterGroups, responseFilters }
    } catch (error) {
      for (const node of compiled) tryDisconnect(node)
      if (dryGain) tryDisconnect(dryGain)
      if (filteredGain) tryDisconnect(filteredGain)
      throw error
    }
  }

  private connectMergerOutput(merger: ChannelMergerNode, routing: FilterRouting | null): void {
    if (!routing) {
      merger.connect(this.gainNode)
      return
    }
    merger.connect(routing.dryGain)
    merger.connect(routing.filters[0] ?? routing.filteredGain)
  }

  private applyFilterAudition(): void {
    const routing = this.filterRouting
    if (!routing) return
    const originalActive = this.filterAudition === 'original'
    this.rampGain(routing.dryGain.gain, originalActive ? 1 : 0)
    this.rampGain(routing.filteredGain.gain, originalActive ? 0 : 1)
  }

  private releaseFilterRouting(): void {
    const routing = this.filterRouting
    this.filterRouting = null
    this.releaseRouting(routing)
  }

  private releaseRouting(routing: FilterRouting | null): void {
    if (!routing) return
    for (const filter of routing.filters) tryDisconnect(filter)
    tryDisconnect(routing.dryGain)
    tryDisconnect(routing.filteredGain)
  }

  private replaceFilterRouting(nextRouting: FilterRouting): void {
    const merger = this.mergerNode
    const previousRouting = this.filterRouting
    if (merger) {
      try {
        tryDisconnect(merger)
        this.connectMergerOutput(merger, nextRouting)
      } catch (error) {
        tryDisconnect(merger)
        try {
          this.connectMergerOutput(merger, previousRouting)
        } catch {
          // Preserve the original graph objects for disposal even if reconnecting fails.
        }
        this.releaseRouting(nextRouting)
        throw error
      }
    }
    this.releaseFilterRouting()
    this.filterRouting = nextRouting
  }

  private prepareResamplerWorklet(): void {
    if (typeof AudioWorkletNode === 'undefined' || !this.context.audioWorklet) return
    void this.context.audioWorklet.addModule(resamplerWorkletUrl).then(() => {
      if (this.disposed) return
      this.resamplerWorkletReady = true
      this.rebuildResamplerRouting()
    }).catch(() => {
      // The graph keeps a transparent GainNode fallback when AudioWorklet is unavailable.
    })
  }

  private createResamplerNode(filter: FilterNodeConfig): AudioNode {
    if (!this.resamplerWorkletReady) {
      const fallback = this.context.createGain()
      fallback.gain.setValueAtTime(1, this.context.currentTime)
      return fallback
    }
    return new AudioWorkletNode(this.context, RESAMPLER_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCountMode: 'max',
      parameterData: { targetSampleRateHz: filter.targetSampleRateHz },
    })
  }

  private rebuildResamplerRouting(): void {
    if (!this.filterChain.some((filter) => filter.enabled && filter.type === 'resampler')) return
    let nextRouting: FilterRouting
    try {
      nextRouting = this.createFilterRouting(this.filterChain)
    } catch {
      return
    }
    try {
      this.replaceFilterRouting(nextRouting)
    } catch {
      // Keep the transparent fallback route if the worklet graph cannot be attached.
    }
  }

  private assertChannelIndex(channelIndex: number): void {
    const numberOfChannels = this.buffer?.numberOfChannels ?? 0
    if (
      !Number.isSafeInteger(channelIndex) ||
      channelIndex < 0 ||
      channelIndex >= numberOfChannels
    ) {
      throw new RangeError(
        `Channel index must reference a loaded source channel within [0, ${numberOfChannels})`,
      )
    }
  }

  private setError(message: string): void {
    this.stopActiveSession()
    this.kind = 'error'
    this.errorMessage = message
    this.stateBeforeLock = null
    this.emit()
  }

  private emit(): void {
    if (this.listeners.size === 0) {
      return
    }
    const snapshot = this.snapshot()
    for (const listener of this.listeners) {
      listener(snapshot)
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error('AudioEngine has been disposed')
    }
  }
}

function createDefaultAudioContext(): AudioContext {
  if (typeof globalThis.AudioContext !== 'function') {
    throw new Error('AUDIO_CONTEXT_UNAVAILABLE: Web Audio API is not available')
  }
  return new globalThis.AudioContext()
}

function isAudioContextRunning(context: AudioContext): boolean {
  return context.state === 'running'
}

function resolveLoadArguments(
  bufferOrAssetId: AudioBuffer | AssetId,
  bufferOrOptions: AudioBuffer | LoadAudioOptions,
  maybeOptions: Omit<LoadAudioOptions, 'assetId'>,
): { buffer: AudioBuffer; options: LoadAudioOptions } {
  if (typeof bufferOrAssetId === 'string') {
    if (!isAudioBuffer(bufferOrOptions)) {
      throw new TypeError('AudioBuffer is required when loading by asset id')
    }
    return {
      buffer: bufferOrOptions,
      options: { ...maybeOptions, assetId: bufferOrAssetId },
    }
  }

  if (isAudioBuffer(bufferOrOptions)) {
    throw new TypeError('Unexpected second AudioBuffer argument')
  }
  return { buffer: bufferOrAssetId, options: bufferOrOptions }
}

function isAudioBuffer(value: AudioBuffer | LoadAudioOptions): value is AudioBuffer {
  return typeof (value as AudioBuffer).getChannelData === 'function'
}

function validateAudioBuffer(buffer: AudioBuffer): void {
  assertSampleRate(buffer.sampleRate)
  if (!isSampleIndex(buffer.length) || buffer.length === 0) {
    throw new RangeError('AudioBuffer must contain at least one PCM frame')
  }
  if (!Number.isSafeInteger(buffer.numberOfChannels) || buffer.numberOfChannels <= 0) {
    throw new RangeError('AudioBuffer must contain at least one channel')
  }
}

function toStateBeforeLock(kind: PlaybackKind): StateBeforeLock {
  if (kind === 'ready' || kind === 'ended') {
    return kind
  }
  return 'paused'
}

function tryDisconnect(node: AudioNode): void {
  try {
    node.disconnect()
  } catch {
    // disconnect() is intentionally idempotent at the engine boundary.
  }
}

function releaseSourceBuffer(node: AudioBufferSourceNode): void {
  try {
    node.buffer = null
  } catch {
    // Some engines disallow changing buffer after start; dropping the source
    // reference still permits collection once the playback session is cleared.
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
