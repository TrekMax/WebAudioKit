import type { StftPreviewResult } from '../audio/analysis'
import { normalizeDb, spectrumColor } from './colorMap'

const MAX_PREVIEW_CHANNELS = 2
const DEFAULT_SAMPLES_PER_COLUMN = 24
const DEFAULT_TRACK_PREVIEW_VIEWPORT_RATIO = 0.5
const TRACK_PREVIEW_VIEWPORT_RATIO = 0.6
const TRACK_PREVIEW_CHROME_HEIGHT = 72
const MAX_TRACK_SPECTROGRAM_WIDTH = 1_024
const MAX_TRACK_SPECTROGRAM_HEIGHT = 384

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
  if (!Number.isSafeInteger(columns) || columns <= 0 || columns > 4_096) {
    throw new RangeError('Track preview columns must be within [1, 4096]')
  }
  if (!Number.isSafeInteger(samplesPerColumn) || samplesPerColumn <= 0 || samplesPerColumn > 256) {
    throw new RangeError('Track preview samples per column must be within [1, 256]')
  }

  const mins = new Float32Array(columns)
  const maxs = new Float32Array(columns)
  const sourceChannels = channels.slice(0, MAX_PREVIEW_CHANNELS)
  const sourceLength = minimumTrackSourceLength(sourceChannels)
  if (
    !Number.isSafeInteger(range.start)
    || !Number.isSafeInteger(range.end)
    || range.start < 0
    || range.end < range.start
    || range.end > sourceLength
  ) {
    throw new RangeError('Track preview range must fit the available source samples')
  }
  const length = range.end - range.start
  if (sourceChannels.length === 0 || sourceLength <= 0 || length <= 0) {
    return { mins, maxs }
  }

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
      const ratio = sampleCount <= 1 ? 0 : sample / (sampleCount - 1)
      const index = Math.min(range.end - 1, start + Math.floor(ratio * (span - 1)))
      for (const channel of sourceChannels) {
        const value = channel[index] ?? 0
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

function minimumTrackSourceLength(channels: readonly Float32Array[]): number {
  const sourceChannels = channels.slice(0, MAX_PREVIEW_CHANNELS)
  if (sourceChannels.length === 0) return 0
  return sourceChannels.reduce(
    (minimum, channel) => Math.min(minimum, channel.length),
    Number.POSITIVE_INFINITY,
  )
}
