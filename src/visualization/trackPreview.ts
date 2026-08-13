import type { StftPreviewResult } from '../audio/analysis'
import {
  isResamplingAlgorithm,
  type ResamplingAlgorithm,
} from '../audio/filterGraph'
import { normalizeDb, spectrumColor } from './colorMap'

const MAX_PREVIEW_CHANNELS = 2
const DEFAULT_SAMPLES_PER_COLUMN = 24
const DEFAULT_TRACK_PREVIEW_VIEWPORT_RATIO = 0.5
const TRACK_PREVIEW_VIEWPORT_RATIO = 0.6
const TRACK_PREVIEW_CHROME_HEIGHT = 72
const MAX_TRACK_SPECTROGRAM_WIDTH = 1_024
const MAX_TRACK_SPECTROGRAM_HEIGHT = 384
const MAX_RESAMPLER_PREVIEW_WARMUP_SAMPLES = 64
const RESAMPLER_SINC_TAPS = 16
const RESAMPLER_SINC_DELAY_SAMPLES = RESAMPLER_SINC_TAPS / 2

export const MIN_TRACK_LANE_HEIGHT = 56

function trackLaneHeightForViewportRatio(viewportHeight: number, ratio: number): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return MIN_TRACK_LANE_HEIGHT
  }
  return Math.max(
    MIN_TRACK_LANE_HEIGHT,
    Math.floor((viewportHeight * ratio - TRACK_PREVIEW_CHROME_HEIGHT) / 2),
  )
}

export function defaultTrackLaneHeight(viewportHeight: number): number {
  return trackLaneHeightForViewportRatio(viewportHeight, DEFAULT_TRACK_PREVIEW_VIEWPORT_RATIO)
}

export function maximumTrackLaneHeight(viewportHeight: number): number {
  return trackLaneHeightForViewportRatio(viewportHeight, TRACK_PREVIEW_VIEWPORT_RATIO)
}

export interface TrackSpectrogramPixels {
  readonly width: number
  readonly height: number
  readonly pixels: Uint8ClampedArray
}

export function buildTrackSpectrogramPixels(
  result: Pick<StftPreviewResult, 'frameCount' | 'binCount' | 'minDb' | 'maxDb' | 'valuesDbfs'>,
  responseDb: Float32Array | null = null,
  maximumWidth = MAX_TRACK_SPECTROGRAM_WIDTH,
  maximumHeight = MAX_TRACK_SPECTROGRAM_HEIGHT,
): TrackSpectrogramPixels | null {
  if (result.frameCount <= 0 || result.binCount <= 0) return null
  if (
    !Number.isSafeInteger(maximumWidth)
    || !Number.isSafeInteger(maximumHeight)
    || maximumWidth <= 0
    || maximumHeight <= 0
    || maximumWidth > 2_048
    || maximumHeight > 1_024
  ) {
    throw new RangeError('Track spectrogram dimensions exceed the bounded preview range')
  }
  if (result.valuesDbfs.length < result.frameCount * result.binCount) {
    throw new RangeError('Track spectrogram source matrix is incomplete')
  }
  if (responseDb && responseDb.length < result.binCount) {
    throw new RangeError('Track spectrogram response does not cover every frequency bin')
  }

  const width = Math.min(result.frameCount, maximumWidth)
  const height = Math.min(result.binCount, maximumHeight)
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let x = 0; x < width; x += 1) {
    const frame = width <= 1
      ? 0
      : Math.round((x / (width - 1)) * (result.frameCount - 1))
    for (let y = 0; y < height; y += 1) {
      const bin = height <= 1
        ? 0
        : Math.round((1 - y / (height - 1)) * (result.binCount - 1))
      const sourceDb = result.valuesDbfs[frame * result.binCount + bin] ?? result.minDb
      const valueDb = sourceDb + (responseDb?.[bin] ?? 0)
      const [red, green, blue] = spectrumColor(normalizeDb(
        valueDb,
        result.minDb,
        result.maxDb,
      ))
      const target = (y * width + x) * 4
      pixels[target] = red
      pixels[target + 1] = green
      pixels[target + 2] = blue
      pixels[target + 3] = 255
    }
  }
  return { width, height, pixels }
}

export interface TrackOverview {
  readonly mins: Float32Array
  readonly maxs: Float32Array
}

export interface TrackResamplerPreviewConfig {
  readonly sourceSampleRateHz: number
  readonly contextSampleRateHz: number
  readonly targetSampleRateHz: number
  readonly algorithm: ResamplingAlgorithm
}

export interface TrackTimeViewport {
  readonly startSample: number
  readonly endSample: number
  readonly domainStartSample: number
  readonly domainEndSample: number
}

export function createTrackTimeViewport(
  domainStartSample: number,
  domainEndSample: number,
): TrackTimeViewport {
  assertValidTrackTimeDomain(domainStartSample, domainEndSample)
  return {
    startSample: domainStartSample,
    endSample: domainEndSample,
    domainStartSample,
    domainEndSample,
  }
}

export function resolveTrackTimeViewport(
  viewport: TrackTimeViewport,
  domainStartSample: number,
  domainEndSample: number,
): TrackTimeViewport {
  assertValidTrackTimeDomain(domainStartSample, domainEndSample)
  if (
    viewport.domainStartSample !== domainStartSample
    || viewport.domainEndSample !== domainEndSample
    || viewport.startSample < domainStartSample
    || viewport.endSample > domainEndSample
    || viewport.endSample <= viewport.startSample
  ) {
    return createTrackTimeViewport(domainStartSample, domainEndSample)
  }
  return viewport
}

export function zoomTrackTimeViewport(
  viewport: TrackTimeViewport,
  anchorSample: number,
  wheelDeltaY: number,
  minimumSpanSamples = 64,
): TrackTimeViewport {
  const domainSpan = viewport.domainEndSample - viewport.domainStartSample
  if (
    domainSpan <= 0
    || !Number.isFinite(anchorSample)
    || !Number.isFinite(wheelDeltaY)
    || !Number.isSafeInteger(minimumSpanSamples)
    || minimumSpanSamples <= 0
  ) {
    return viewport
  }

  const currentSpan = viewport.endSample - viewport.startSample
  const nextSpan = Math.round(Math.min(
    domainSpan,
    Math.max(Math.min(minimumSpanSamples, domainSpan), currentSpan * Math.exp(wheelDeltaY * 0.0014)),
  ))
  const clampedAnchor = Math.min(viewport.endSample, Math.max(viewport.startSample, anchorSample))
  const anchorPosition = currentSpan > 0
    ? (clampedAnchor - viewport.startSample) / currentSpan
    : 0
  const unclampedStart = Math.round(clampedAnchor - anchorPosition * nextSpan)
  const startSample = Math.min(
    viewport.domainEndSample - nextSpan,
    Math.max(viewport.domainStartSample, unclampedStart),
  )
  return {
    ...viewport,
    startSample,
    endSample: startSample + nextSpan,
  }
}

export function trackTimeViewportSampleAtPosition(
  viewport: Pick<TrackTimeViewport, 'startSample' | 'endSample'>,
  position: number,
): number {
  const clampedPosition = Number.isFinite(position)
    ? Math.min(1, Math.max(0, position))
    : 0
  return Math.round(
    viewport.startSample + clampedPosition * (viewport.endSample - viewport.startSample),
  )
}

export function trackTimeViewportPositionForSample(
  viewport: Pick<TrackTimeViewport, 'startSample' | 'endSample'>,
  sample: number,
): number | null {
  const span = viewport.endSample - viewport.startSample
  if (
    !Number.isFinite(sample)
    || span <= 0
    || sample < viewport.startSample
    || sample > viewport.endSample
  ) {
    return null
  }
  return (sample - viewport.startSample) / span
}

function assertValidTrackTimeDomain(startSample: number, endSample: number): void {
  if (
    !Number.isSafeInteger(startSample)
    || !Number.isSafeInteger(endSample)
    || startSample < 0
    || endSample < startSample
  ) {
    throw new RangeError('Track time domain must be a non-negative safe sample range')
  }
}

export type TrackPreviewAxisMode = 'waveform' | 'spectrum' | 'spectrogram'

export interface TrackPreviewAxisTick {
  readonly position: number
  readonly value: number
  readonly label: string
}

export interface TrackPreviewAxis {
  readonly minimum: number
  readonly maximum: number
  readonly scale: 'linear' | 'log'
  readonly unitLabel: string
  readonly ticks: readonly TrackPreviewAxisTick[]
}

export interface TrackPreviewAxes {
  readonly horizontal: TrackPreviewAxis
  readonly vertical: TrackPreviewAxis
}

export function trackPreviewAxisValueToPosition(
  axis: Pick<TrackPreviewAxis, 'minimum' | 'maximum' | 'scale'>,
  value: number,
): number {
  if (!Number.isFinite(value) || axis.maximum <= axis.minimum) return 0
  if (axis.scale === 'log') {
    if (axis.minimum <= 0 || value <= 0) return 0
    return (
      (Math.log10(value) - Math.log10(axis.minimum))
      / (Math.log10(axis.maximum) - Math.log10(axis.minimum))
    )
  }
  return (value - axis.minimum) / (axis.maximum - axis.minimum)
}

type TrackPreviewAnalysisAxesSource = Pick<
  StftPreviewResult,
  'sampleRate' | 'range' | 'minDb' | 'maxDb' | 'timesSeconds' | 'frequenciesHz'
>

export interface TrackPreviewAxisOptions {
  readonly mode: TrackPreviewAxisMode
  readonly durationSeconds: number
  readonly analysis: TrackPreviewAnalysisAxesSource | null
  readonly timeRangeSeconds?: readonly [number, number]
  readonly horizontalTickCount?: number
  readonly verticalTickCount?: number
}

/**
 * Describes the exact coordinate space used by the compact A/B preview. Axis
 * ticks and rendered data consume these same bounds so their mappings cannot
 * drift apart when the source or analysis range changes.
 */
export function buildTrackPreviewAxes({
  mode,
  durationSeconds,
  analysis,
  timeRangeSeconds,
  horizontalTickCount = 5,
  verticalTickCount = 5,
}: TrackPreviewAxisOptions): TrackPreviewAxes {
  const safeDuration = Number.isFinite(durationSeconds)
    ? Math.max(0, durationSeconds)
    : 0

  if (mode === 'waveform') {
    const [startTime, endTime] = resolveRequestedTimeBounds(
      timeRangeSeconds,
      0,
      safeDuration,
    )
    return {
      horizontal: createLinearAxis(
        startTime,
        endTime,
        horizontalTickCount,
        (value, step) => formatSeconds(value, step),
        '时间',
      ),
      vertical: createLinearAxis(
        -1,
        1,
        Math.min(3, verticalTickCount),
        (value) => value > 0 ? `+${trimFraction(value.toFixed(1))}` : trimFraction(value.toFixed(1)),
        '幅度',
      ),
    }
  }

  const maximumFrequency = resolveMaximumFrequency(analysis)
  if (mode === 'spectrum') {
    const minimumFrequency = maximumFrequency > 20
      ? 20
      : Math.max(1, maximumFrequency)
    const minimumDb = analysis && Number.isFinite(analysis.minDb) ? analysis.minDb : -100
    const maximumDb = analysis && Number.isFinite(analysis.maxDb) && analysis.maxDb > minimumDb
      ? analysis.maxDb
      : 0
    return {
      horizontal: createLogAxis(
        minimumFrequency,
        Math.max(minimumFrequency, maximumFrequency),
        horizontalTickCount,
        formatFrequency,
        '频率',
      ),
      vertical: createLinearAxis(
        minimumDb,
        maximumDb,
        verticalTickCount,
        (value) => `${Math.round(value)}`,
        'dBFS',
      ),
    }
  }

  const [analysisStartTime, analysisEndTime] = resolveAnalysisTimeBounds(analysis, safeDuration)
  const [startTime, endTime] = resolveRequestedTimeBounds(
    timeRangeSeconds,
    analysisStartTime,
    analysisEndTime,
  )
  return {
    horizontal: createLinearAxis(
      startTime,
      endTime,
      horizontalTickCount,
      (value, step) => formatSeconds(value, step),
      '时间',
    ),
    vertical: createLinearAxis(
      0,
      maximumFrequency,
      verticalTickCount,
      (value) => formatFrequency(value),
      '频率',
    ),
  }
}

function resolveRequestedTimeBounds(
  requested: readonly [number, number] | undefined,
  fallbackStart: number,
  fallbackEnd: number,
): readonly [number, number] {
  if (
    requested
    && Number.isFinite(requested[0])
    && Number.isFinite(requested[1])
    && requested[1] > requested[0]
  ) {
    return requested
  }
  return [fallbackStart, fallbackEnd]
}

function createLinearAxis(
  minimum: number,
  maximum: number,
  count: number,
  format: (value: number, step: number) => string,
  unitLabel: string,
): TrackPreviewAxis {
  const tickCount = normalizeTickCount(count)
  const span = Math.max(0, maximum - minimum)
  const step = tickCount > 1 ? span / (tickCount - 1) : 0
  const ticks = span > 0
    ? Array.from({ length: tickCount }, (_, index) => {
        const position = index / (tickCount - 1)
        const value = index === tickCount - 1 ? maximum : minimum + position * span
        return { position, value, label: format(value, step) }
      })
    : [{ position: 0, value: minimum, label: format(minimum, 0) }]
  return { minimum, maximum, scale: 'linear', unitLabel, ticks }
}

function createLogAxis(
  minimum: number,
  maximum: number,
  count: number,
  format: (value: number) => string,
  unitLabel: string,
): TrackPreviewAxis {
  const tickCount = normalizeTickCount(count)
  if (minimum <= 0 || maximum <= minimum) {
    return {
      minimum,
      maximum,
      scale: 'log',
      unitLabel,
      ticks: [{ position: 0, value: minimum, label: format(minimum) }],
    }
  }
  const minimumLog = Math.log10(minimum)
  const logSpan = Math.log10(maximum) - minimumLog
  const ticks = Array.from({ length: tickCount }, (_, index) => {
    const position = index / (tickCount - 1)
    const value = index === tickCount - 1
      ? maximum
      : 10 ** (minimumLog + position * logSpan)
    return { position, value, label: format(value) }
  })
  return { minimum, maximum, scale: 'log', unitLabel, ticks }
}

function normalizeTickCount(count: number): number {
  return Number.isFinite(count)
    ? Math.max(2, Math.min(7, Math.trunc(count)))
    : 5
}

function resolveMaximumFrequency(analysis: TrackPreviewAnalysisAxesSource | null): number {
  const lastFrequency = analysis?.frequenciesHz.at(-1)
  if (typeof lastFrequency === 'number' && Number.isFinite(lastFrequency) && lastFrequency > 0) {
    return lastFrequency
  }
  if (analysis && Number.isFinite(analysis.sampleRate) && analysis.sampleRate > 0) {
    return analysis.sampleRate / 2
  }
  return 24_000
}

function resolveAnalysisTimeBounds(
  analysis: TrackPreviewAnalysisAxesSource | null,
  fallbackEnd: number,
): readonly [number, number] {
  const firstTime = analysis?.timesSeconds[0]
  const lastTime = analysis?.timesSeconds.at(-1)
  if (
    typeof firstTime === 'number'
    && typeof lastTime === 'number'
    && Number.isFinite(firstTime)
    && Number.isFinite(lastTime)
    && lastTime > firstTime
  ) {
    return [firstTime, lastTime]
  }
  if (analysis && Number.isFinite(analysis.sampleRate) && analysis.sampleRate > 0) {
    const start = analysis.range.start / analysis.sampleRate
    const end = analysis.range.end / analysis.sampleRate
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      return [start, end]
    }
  }
  return [0, fallbackEnd]
}

function formatSeconds(value: number, step: number): string {
  if (!Number.isFinite(value)) return '0 s'
  if (Math.abs(value) >= 60) {
    const minutes = Math.floor(Math.max(0, value) / 60)
    const seconds = Math.max(0, value) - minutes * 60
    return `${minutes}:${seconds.toFixed(step < 1 ? 1 : 0).padStart(step < 1 ? 4 : 2, '0')}`
  }
  const decimals = step > 0 && step < 0.1 ? 2 : step < 1 ? 1 : 0
  return `${trimFraction(value.toFixed(decimals))} s`
}

function formatFrequency(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 Hz'
  if (value >= 1_000) {
    const kilohertz = value / 1_000
    const decimals = kilohertz >= 10 ? 0 : 1
    return `${trimFraction(kilohertz.toFixed(decimals))} kHz`
  }
  return `${Math.round(value)} Hz`
}

function trimFraction(value: string): string {
  return value.includes('.')
    ? value.replace(/\.0+$|(?<=\.[0-9]*[1-9])0+$/, '')
    : value
}

/**
 * Builds a bounded-cost visual overview without copying source PCM. Each
 * column samples a fixed number of frames from at most two source channels.
 */
export function buildTrackOverview(
  channels: readonly Float32Array[],
  columns: number,
  samplesPerColumn = DEFAULT_SAMPLES_PER_COLUMN,
): TrackOverview {
  return buildTrackOverviewRange(
    channels,
    columns,
    { start: 0, end: minimumTrackSourceLength(channels) },
    samplesPerColumn,
  )
}

export function buildTrackOverviewRange(
  channels: readonly Float32Array[],
  columns: number,
  range: { readonly start: number; readonly end: number },
  samplesPerColumn = DEFAULT_SAMPLES_PER_COLUMN,
): TrackOverview {
  const sourceChannels = channels.slice(0, MAX_PREVIEW_CHANNELS)
  validateTrackOverviewRequest(sourceChannels, columns, range, samplesPerColumn)
  return buildTrackOverviewFromAccessor(
    sourceChannels.length,
    columns,
    range,
    samplesPerColumn,
    (channelIndex, sampleIndex) => finiteSample(sourceChannels[channelIndex]?.[sampleIndex]),
  )
}

/**
 * Builds a bounded, visible-range-only approximation of the realtime sampler.
 * It follows the Worklet phase/hold rules. Filtered modes use a short causal
 * warm-up for the one-pole anti-alias filter instead of scanning from the file
 * start; raw point sampling intentionally skips that filter.
 */
export function buildTrackResamplerOverviewRange(
  channels: readonly Float32Array[],
  columns: number,
  range: { readonly start: number; readonly end: number },
  config: TrackResamplerPreviewConfig,
  samplesPerColumn = DEFAULT_SAMPLES_PER_COLUMN,
): TrackOverview {
  if (
    !Number.isFinite(config.sourceSampleRateHz)
    || config.sourceSampleRateHz <= 0
    || !Number.isFinite(config.contextSampleRateHz)
    || config.contextSampleRateHz <= 0
    || !Number.isFinite(config.targetSampleRateHz)
    || config.targetSampleRateHz <= 0
  ) {
    throw new RangeError('Track resampler preview sample rates must be positive and finite')
  }
  if (!isResamplingAlgorithm(config.algorithm)) {
    throw new RangeError(`Unsupported track resampler preview algorithm: ${String(config.algorithm)}`)
  }
  if (config.targetSampleRateHz >= config.contextSampleRateHz) {
    return buildTrackOverviewRange(channels, columns, range, samplesPerColumn)
  }

  const sourceChannels = channels.slice(0, MAX_PREVIEW_CHANNELS)
  validateTrackOverviewRequest(sourceChannels, columns, range, samplesPerColumn)
  const ratio = config.targetSampleRateHz / config.contextSampleRateHz
  const cutoffHz = Math.min(
    config.contextSampleRateHz * 0.45,
    config.targetSampleRateHz * 0.45,
  )
  const lowpassAlpha = 1 - Math.exp(
    (-2 * Math.PI * cutoffHz) / config.contextSampleRateHz,
  )
  const feedback = 1 - lowpassAlpha
  const settlingSamples = feedback > 0
    ? Math.min(
        MAX_RESAMPLER_PREVIEW_WARMUP_SAMPLES,
        Math.max(1, Math.ceil(Math.log(1e-4) / Math.log(feedback))),
      )
    : 1
  const filteredCaches = sourceChannels.map(() => new Map<number, number>())

  const sourceSampleAtContextFrame = (channelIndex: number, contextFrame: number): number => {
    const channel = sourceChannels[channelIndex]
    if (!channel || channel.length === 0) return 0
    const sourcePosition = contextFrame * config.sourceSampleRateHz / config.contextSampleRateHz
    const lowerIndex = Math.min(channel.length - 1, Math.max(0, Math.floor(sourcePosition)))
    const upperIndex = Math.min(channel.length - 1, lowerIndex + 1)
    const fraction = Math.min(1, Math.max(0, sourcePosition - lowerIndex))
    const lower = finiteSample(channel[lowerIndex])
    return lower + (finiteSample(channel[upperIndex]) - lower) * fraction
  }

  const filteredSampleAt = (channelIndex: number, contextFrame: number): number => {
    const cache = filteredCaches[channelIndex]
    const cached = cache?.get(contextFrame)
    if (cached !== undefined) return cached
    const clampedFrame = Math.max(0, contextFrame)
    const warmupStart = Math.max(0, clampedFrame - settlingSamples)
    let filtered = warmupStart === 0
      ? 0
      : sourceSampleAtContextFrame(channelIndex, warmupStart)
    const firstFilteredIndex = warmupStart === 0 ? 0 : warmupStart + 1
    for (let frame = firstFilteredIndex; frame <= clampedFrame; frame += 1) {
      filtered += lowpassAlpha * (
        sourceSampleAtContextFrame(channelIndex, frame) - filtered
      )
    }
    cache?.set(contextFrame, filtered)
    return filtered
  }

  const eventSampleIndex = (step: number): number => (
    step <= 0 ? 0 : Math.max(0, Math.ceil(step / ratio) - 1)
  )
  const sampledEventAt = config.algorithm === 'point'
    ? sourceSampleAtContextFrame
    : filteredSampleAt
  const sampleAt = (channelIndex: number, sampleIndex: number): number => {
    const contextFrame = Math.round(
      sampleIndex * config.contextSampleRateHz / config.sourceSampleRateHz,
    )
    const phasePosition = (contextFrame + 1) * ratio
    const currentStep = Math.floor(phasePosition)
    const current = sampledEventAt(channelIndex, eventSampleIndex(currentStep))
    if (config.algorithm === 'point' || config.algorithm === 'hold') return current
    const previous = sampledEventAt(channelIndex, eventSampleIndex(currentStep - 1))
    const phase = phasePosition - currentStep
    if (config.algorithm === 'linear') {
      return previous + (current - previous) * phase
    }
    if (config.algorithm === 'cubic') {
      const p0 = sampledEventAt(channelIndex, eventSampleIndex(currentStep - 3))
      const p1 = sampledEventAt(channelIndex, eventSampleIndex(currentStep - 2))
      return catmullRom(
        p0,
        p1,
        previous,
        current,
        phase,
      )
    }

    let reconstructed = 0
    let coefficientSum = 0
    for (let tap = 0; tap < RESAMPLER_SINC_TAPS; tap += 1) {
      const distance = tap - RESAMPLER_SINC_DELAY_SAMPLES + phase
      if (Math.abs(distance) >= RESAMPLER_SINC_DELAY_SAMPLES) continue
      const coefficient = normalizedSinc(distance)
        * normalizedSinc(distance / RESAMPLER_SINC_DELAY_SAMPLES)
      reconstructed += sampledEventAt(
        channelIndex,
        eventSampleIndex(currentStep - tap),
      ) * coefficient
      coefficientSum += coefficient
    }
    return reconstructed / (Math.abs(coefficientSum) > 1e-12 ? coefficientSum : 1)
  }

  return buildTrackOverviewFromAccessor(
    sourceChannels.length,
    columns,
    range,
    samplesPerColumn,
    sampleAt,
  )
}

function normalizedSinc(value: number): number {
  if (Math.abs(value) < 1e-12) return 1
  const radians = Math.PI * value
  return Math.sin(radians) / radians
}

function catmullRom(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  phase: number,
): number {
  const phaseSquared = phase * phase
  const phaseCubed = phaseSquared * phase
  return 0.5 * (
    2 * p1
    + (-p0 + p2) * phase
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * phaseSquared
    + (-p0 + 3 * p1 - 3 * p2 + p3) * phaseCubed
  )
}

function validateTrackOverviewRequest(
  channels: readonly Float32Array[],
  columns: number,
  range: { readonly start: number; readonly end: number },
  samplesPerColumn: number,
): void {
  if (!Number.isSafeInteger(columns) || columns <= 0 || columns > 4_096) {
    throw new RangeError('Track preview columns must be within [1, 4096]')
  }
  if (!Number.isSafeInteger(samplesPerColumn) || samplesPerColumn <= 0 || samplesPerColumn > 256) {
    throw new RangeError('Track preview samples per column must be within [1, 256]')
  }
  const sourceLength = minimumTrackSourceLength(channels)
  if (
    !Number.isSafeInteger(range.start)
    || !Number.isSafeInteger(range.end)
    || range.start < 0
    || range.end < range.start
    || range.end > sourceLength
  ) {
    throw new RangeError('Track preview range must fit the available source samples')
  }
}

function buildTrackOverviewFromAccessor(
  channelCount: number,
  columns: number,
  range: { readonly start: number; readonly end: number },
  samplesPerColumn: number,
  sampleAt: (channelIndex: number, sampleIndex: number) => number,
): TrackOverview {
  const mins = new Float32Array(columns)
  const maxs = new Float32Array(columns)
  const length = range.end - range.start
  if (channelCount <= 0 || length <= 0) return { mins, maxs }

  for (let column = 0; column < columns; column += 1) {
    const start = range.start + Math.floor((column / columns) * length)
    const end = Math.min(
      range.end,
      Math.max(start + 1, range.start + Math.floor(((column + 1) / columns) * length)),
    )
    const span = Math.max(1, end - start)
    const sampleCount = Math.min(samplesPerColumn, span)
    let minimum = 1
    let maximum = -1

    for (let sample = 0; sample < sampleCount; sample += 1) {
      const sampleRatio = sampleCount <= 1 ? 0 : sample / (sampleCount - 1)
      const index = Math.min(range.end - 1, start + Math.floor(sampleRatio * (span - 1)))
      for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
        const value = sampleAt(channelIndex, index)
        if (!Number.isFinite(value)) continue
        minimum = Math.min(minimum, value)
        maximum = Math.max(maximum, value)
      }
    }

    mins[column] = minimum <= maximum ? minimum : 0
    maxs[column] = minimum <= maximum ? maximum : 0
  }
  return { mins, maxs }
}

function finiteSample(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function minimumTrackSourceLength(channels: readonly Float32Array[]): number {
  const sourceChannels = channels.slice(0, MAX_PREVIEW_CHANNELS)
  if (sourceChannels.length === 0) return 0
  return sourceChannels.reduce(
    (minimum, channel) => Math.min(minimum, channel.length),
    Number.POSITIVE_INFINITY,
  )
}
