import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from 'react'
import {
  Activity,
  AudioWaveform,
  GripHorizontal,
  Maximize2,
  MoveVertical,
  Radio,
  ScanLine,
  Waves,
} from 'lucide-react'

import type { StftPreviewResult } from '../audio/analysis'
import {
  FILTER_DEFINITIONS,
  type FilterAuditionMode,
  type FilterNodeConfig,
} from '../audio/filterGraph'
import { useElementSize } from '../hooks/useElementSize'
import { useResolvedTheme } from '../hooks/useResolvedTheme'
import type { ResolvedTheme } from '../theme'
import {
  MIN_TRACK_LANE_HEIGHT,
  buildTrackPreviewAxes,
  buildTrackOverviewRange,
  buildTrackSpectrogramPixels,
  createTrackTimeViewport,
  defaultTrackLaneHeight,
  maximumTrackLaneHeight,
  resolveTrackTimeViewport,
  trackPreviewAxisValueToPosition,
  trackTimeViewportPositionForSample,
  trackTimeViewportSampleAtPosition,
  type TrackPreviewAxes,
  type TrackOverview,
  type TrackTimeViewport,
  zoomTrackTimeViewport,
} from '../visualization/trackPreview'

interface FilterTrackPreviewProps {
  readonly buffer: AudioBuffer | null
  readonly currentSample: number
  readonly filters: readonly FilterNodeConfig[]
  readonly auditionMode: FilterAuditionMode
  readonly playing: boolean
  readonly spectrum: StftPreviewResult | null
  readonly spectrogram: StftPreviewResult | null
  readonly getFilterFrequencyResponseDb: (frequenciesHz: Float32Array) => Float32Array | null
  readonly onAuditionModeChange: (mode: FilterAuditionMode) => void
  readonly onSeekSample: (sample: number) => void
}

type TrackViewMode = 'waveform' | 'spectrum' | 'spectrogram'

interface TrackResizeSession {
  readonly pointerId: number
  readonly startY: number
  readonly startHeight: number
  readonly maximumHeight: number
}

interface TrackTimeViewportState {
  readonly viewport: TrackTimeViewport
  readonly buffer: AudioBuffer | null
  readonly viewMode: TrackViewMode
  readonly spectrogram: StftPreviewResult | null
}

interface TrackLaneProps {
  readonly mode: FilterAuditionMode
  readonly title: string
  readonly detail: string
  readonly color: string
  readonly theme: ResolvedTheme
  readonly active: boolean
  readonly disabled?: boolean
  readonly playing: boolean
  readonly currentSample: number
  readonly sampleRate: number
  readonly durationSeconds: number
  readonly overview: TrackOverview
  readonly width: number
  readonly height: number
  readonly viewMode: TrackViewMode
  readonly spectrum: StftPreviewResult | null
  readonly spectrogram: StftPreviewResult | null
  readonly spectrogramResponseDb: Float32Array | null
  readonly timeViewport: TrackTimeViewport
  readonly minimumTimeSpanSamples: number
  readonly getFilterFrequencyResponseDb: (frequenciesHz: Float32Array) => Float32Array | null
  readonly onSelect: () => void
  readonly onSeekSample: (sample: number) => void
  readonly onTimeViewportChange: (viewport: TrackTimeViewport) => void
}

const TRACK_PLOT_MARGIN = {
  top: 12,
  right: 14,
  bottom: 24,
  left: 176,
} as const

interface TrackPlotBounds {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

interface TrackCanvasPalette {
  readonly plotBackground: string
  readonly activeGrid: string
  readonly inactiveGrid: string
  readonly activeText: string
  readonly inactiveText: string
  readonly activeBorder: string
  readonly inactiveBorder: string
  readonly activeUnit: string
  readonly inactiveUnit: string
  readonly disabledStroke: string
  readonly activePlayhead: string
  readonly inactivePlayhead: string
  readonly emptyText: string
}

const TRACK_CANVAS_PALETTES: Readonly<Record<ResolvedTheme, TrackCanvasPalette>> = {
  dark: {
    plotBackground: 'rgba(5,10,16,0.58)',
    activeGrid: 'rgba(31,223,178,0.14)',
    inactiveGrid: 'rgba(92,112,132,0.14)',
    activeText: '#81968f',
    inactiveText: '#738393',
    activeBorder: 'rgba(31,223,178,0.28)',
    inactiveBorder: 'rgba(112,132,152,0.24)',
    activeUnit: 'rgba(177,207,197,0.82)',
    inactiveUnit: 'rgba(151,168,184,0.78)',
    disabledStroke: '#4c5966',
    activePlayhead: '#f4fbf8',
    inactivePlayhead: 'rgba(210,222,232,0.38)',
    emptyText: '#647586',
  },
  light: {
    plotBackground: 'rgba(255,255,255,0.94)',
    activeGrid: 'rgba(8,126,105,0.16)',
    inactiveGrid: 'rgba(74,101,111,0.16)',
    activeText: '#477268',
    inactiveText: '#60747d',
    activeBorder: 'rgba(8,126,105,0.34)',
    inactiveBorder: 'rgba(91,116,126,0.3)',
    activeUnit: '#426d63',
    inactiveUnit: '#5e747d',
    disabledStroke: '#9aabb2',
    activePlayhead: '#087e69',
    inactivePlayhead: 'rgba(55,80,89,0.46)',
    emptyText: '#60747d',
  },
}

function trackPlotPositionAtClientX(
  target: HTMLElement,
  clientX: number,
): number | null {
  const rect = target.getBoundingClientRect()
  const plotWidth = rect.width - TRACK_PLOT_MARGIN.left - TRACK_PLOT_MARGIN.right
  const localX = clientX - rect.left - TRACK_PLOT_MARGIN.left
  if (plotWidth <= 0 || localX < 0 || localX > plotWidth) return null
  return localX / plotWidth
}

function resolvePreviewTimeDomain(
  buffer: AudioBuffer | null,
  viewMode: TrackViewMode,
  spectrogram: StftPreviewResult | null,
): readonly [number, number] {
  const sourceLength = buffer?.length ?? 0
  if (!buffer || sourceLength <= 0 || viewMode !== 'spectrogram' || !spectrogram) {
    return [0, sourceLength]
  }

  const firstTime = spectrogram.timesSeconds[0]
  const lastTime = spectrogram.timesSeconds.at(-1)
  if (
    typeof firstTime === 'number'
    && typeof lastTime === 'number'
    && Number.isFinite(firstTime)
    && Number.isFinite(lastTime)
    && lastTime > firstTime
  ) {
    const startSample = Math.max(0, Math.min(sourceLength, Math.round(firstTime * buffer.sampleRate)))
    const endSample = Math.max(0, Math.min(sourceLength, Math.round(lastTime * buffer.sampleRate)))
    if (endSample > startSample) return [startSample, endSample]
  }

  const scale = buffer.sampleRate / spectrogram.sampleRate
  const startSample = Math.max(
    0,
    Math.min(sourceLength, Math.round(spectrogram.range.start * scale)),
  )
  const endSample = Math.max(
    0,
    Math.min(sourceLength, Math.round(spectrogram.range.end * scale)),
  )
  return endSample > startSample ? [startSample, endSample] : [0, sourceLength]
}

function drawTrackAxes(
  context: CanvasRenderingContext2D,
  axes: TrackPreviewAxes,
  bounds: TrackPlotBounds,
  canvasHeight: number,
  active: boolean,
  palette: TrackCanvasPalette,
): void {
  const right = bounds.left + bounds.width
  const bottom = bounds.top + bounds.height
  context.save()
  context.lineWidth = 1
  context.strokeStyle = active ? palette.activeGrid : palette.inactiveGrid
  context.fillStyle = active ? palette.activeText : palette.inactiveText
  context.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace'

  for (const [index, tick] of axes.horizontal.ticks.entries()) {
    const x = bounds.left + tick.position * bounds.width
    context.beginPath()
    context.moveTo(x + 0.5, bounds.top)
    context.lineTo(x + 0.5, bottom)
    context.stroke()
    context.textBaseline = 'alphabetic'
    context.textAlign = index === 0
      ? 'left'
      : index === axes.horizontal.ticks.length - 1
        ? 'right'
        : 'center'
    context.fillText(tick.label, x, canvasHeight - 7)
  }

  for (const tick of axes.vertical.ticks) {
    const y = bottom - tick.position * bounds.height
    context.beginPath()
    context.moveTo(bounds.left, y + 0.5)
    context.lineTo(right, y + 0.5)
    context.stroke()
    context.textAlign = 'right'
    context.textBaseline = 'middle'
    context.fillText(tick.label, bounds.left - 7, y)
  }

  context.strokeStyle = active ? palette.activeBorder : palette.inactiveBorder
  context.strokeRect(bounds.left + 0.5, bounds.top + 0.5, bounds.width - 1, bounds.height - 1)
  context.fillStyle = active ? palette.activeUnit : palette.inactiveUnit
  context.font = '8px ui-monospace, SFMono-Regular, Menlo, monospace'
  context.textAlign = 'left'
  context.textBaseline = 'top'
  context.fillText(axes.vertical.unitLabel, bounds.left + 5, bounds.top + 4)
  context.restore()
}

function TrackLane({
  mode,
  title,
  detail,
  color,
  theme,
  active,
  disabled = false,
  playing,
  currentSample,
  sampleRate,
  durationSeconds,
  overview,
  width,
  height,
  viewMode,
  spectrum,
  spectrogram,
  spectrogramResponseDb,
  timeViewport,
  minimumTimeSpanSamples,
  getFilterFrequencyResponseDb,
  onSelect,
  onSeekSample,
  onTimeViewportChange,
}: TrackLaneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const palette = TRACK_CANVAS_PALETTES[theme]
  const timeMode = viewMode !== 'spectrum'
  const playheadPosition = timeMode
    ? trackTimeViewportPositionForSample(timeViewport, currentSample)
    : null
  const spectrogramBitmap = useMemo(() => {
    if (viewMode !== 'spectrogram' || !spectrogram) return null
    const raster = buildTrackSpectrogramPixels(
      spectrogram,
      mode === 'filtered' ? spectrogramResponseDb : null,
    )
    if (!raster) return null
    const offscreen = document.createElement('canvas')
    offscreen.width = raster.width
    offscreen.height = raster.height
    const context = offscreen.getContext('2d')
    if (!context) return null
    const image = context.createImageData(raster.width, raster.height)
    image.data.set(raster.pixels)
    context.putImageData(image, 0, 0)
    return offscreen
  }, [mode, spectrogram, spectrogramResponseDb, viewMode])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || width <= 0) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.max(1, Math.round(width * dpr))
    canvas.height = Math.round(height * dpr)
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, width, height)

    const plotLeft = TRACK_PLOT_MARGIN.left
    const plotTop = TRACK_PLOT_MARGIN.top
    const plotWidth = Math.max(1, width - plotLeft - TRACK_PLOT_MARGIN.right)
    const plotHeight = Math.max(1, height - plotTop - TRACK_PLOT_MARGIN.bottom)
    const plotBottom = plotTop + plotHeight
    const axes = buildTrackPreviewAxes({
      mode: viewMode,
      durationSeconds,
      analysis: viewMode === 'spectrum'
        ? spectrum
        : viewMode === 'spectrogram'
          ? spectrogram
          : null,
      timeRangeSeconds: timeMode && sampleRate > 0
        ? [timeViewport.startSample / sampleRate, timeViewport.endSample / sampleRate]
        : undefined,
      horizontalTickCount: plotWidth < 320 ? 3 : 5,
      verticalTickCount: plotHeight < 54 ? 3 : 5,
    })
    context.fillStyle = viewMode === 'spectrogram'
      ? TRACK_CANVAS_PALETTES.dark.plotBackground
      : palette.plotBackground
    context.fillRect(plotLeft, plotTop, plotWidth, plotHeight)
    if (viewMode === 'spectrogram' && spectrogramBitmap) {
      context.imageSmoothingEnabled = true
      const domainSpan = timeViewport.domainEndSample - timeViewport.domainStartSample
      const sourceStart = domainSpan > 0
        ? ((timeViewport.startSample - timeViewport.domainStartSample) / domainSpan)
          * spectrogramBitmap.width
        : 0
      const sourceWidth = domainSpan > 0
        ? ((timeViewport.endSample - timeViewport.startSample) / domainSpan)
          * spectrogramBitmap.width
        : spectrogramBitmap.width
      context.drawImage(
        spectrogramBitmap,
        sourceStart,
        0,
        Math.max(1, sourceWidth),
        spectrogramBitmap.height,
        plotLeft,
        plotTop,
        plotWidth,
        plotHeight,
      )
    }
    drawTrackAxes(
      context,
      axes,
      { left: plotLeft, top: plotTop, width: plotWidth, height: plotHeight },
      height,
      active,
      palette,
    )

    if (viewMode === 'waveform') {
      const center = plotTop + plotHeight / 2
      const { mins, maxs } = overview
      context.strokeStyle = disabled ? palette.disabledStroke : color
      context.globalAlpha = disabled ? 0.42 : active ? 0.95 : 0.62
      context.lineWidth = 1
      context.beginPath()
      for (let column = 0; column < mins.length; column += 1) {
        const x = plotLeft + (column / Math.max(1, mins.length - 1)) * plotWidth
        const top = center - (maxs[column] ?? 0) * (plotHeight / 2)
        const bottom = center - (mins[column] ?? 0) * (plotHeight / 2)
        context.moveTo(x, top)
        context.lineTo(x, bottom)
      }
      context.stroke()
      context.globalAlpha = 1

      if (playheadPosition !== null) {
        const cursorX = plotLeft + playheadPosition * plotWidth
        context.strokeStyle = active ? palette.activePlayhead : palette.inactivePlayhead
        context.lineWidth = active ? 1.5 : 1
        context.beginPath()
        context.moveTo(cursorX, plotTop + 3)
        context.lineTo(cursorX, plotBottom - 3)
        context.stroke()
      }
    } else if (
      viewMode === 'spectrum'
      && spectrum
      && spectrum.frameCount > 0
      && spectrum.binCount > 1
    ) {
      const frameOffset = (spectrum.frameCount - 1) * spectrum.binCount
      const filterResponseDb = mode === 'filtered'
        ? getFilterFrequencyResponseDb(Float32Array.from(spectrum.frequenciesHz))
        : null
      const points: Array<readonly [number, number]> = []
      for (let bin = 0; bin < spectrum.binCount; bin += 1) {
        const frequencyHz = spectrum.frequenciesHz[bin] ?? 0
        if (frequencyHz < axes.horizontal.minimum || frequencyHz > axes.horizontal.maximum) continue
        const sourceDb = spectrum.valuesDbfs[frameOffset + bin] ?? spectrum.minDb
        const responseDb = filterResponseDb?.[bin] ?? 0
        const valueDb = sourceDb + responseDb
        const unitX = Math.max(0, Math.min(1, trackPreviewAxisValueToPosition(axes.horizontal, frequencyHz)))
        const unitY = Math.max(0, Math.min(1, trackPreviewAxisValueToPosition(axes.vertical, valueDb)))
        points.push([
          plotLeft + unitX * plotWidth,
          plotTop + (1 - unitY) * plotHeight,
        ])
      }
      const first = points[0]
      if (first && points.length > 1) {
        const gradient = context.createLinearGradient(0, plotBottom, 0, plotTop)
        gradient.addColorStop(0, 'rgba(31,223,178,0.015)')
        gradient.addColorStop(1, mode === 'filtered' ? 'rgba(31,223,178,0.22)' : 'rgba(100,169,255,0.2)')
        context.beginPath()
        context.moveTo(first[0], plotBottom)
        context.lineTo(first[0], first[1])
        for (const point of points.slice(1)) context.lineTo(point[0], point[1])
        const last = points.at(-1)
        if (last) context.lineTo(last[0], plotBottom)
        context.closePath()
        context.fillStyle = gradient
        context.fill()

        context.beginPath()
        context.moveTo(first[0], first[1])
        for (const point of points.slice(1)) context.lineTo(point[0], point[1])
        context.strokeStyle = disabled ? palette.disabledStroke : color
        context.globalAlpha = disabled ? 0.42 : active ? 0.95 : 0.68
        context.lineWidth = active ? 1.5 : 1
        context.stroke()
        context.globalAlpha = 1
      }
    } else if (viewMode === 'spectrogram') {
      if (!spectrogramBitmap) {
        context.fillStyle = palette.emptyText
        context.font = '12px Inter, system-ui, sans-serif'
        context.textAlign = 'center'
        context.fillText('完成 FFT 分析后显示二维声谱', plotLeft + plotWidth / 2, plotTop + plotHeight / 2)
      } else {
        if (playheadPosition !== null) {
          const cursorX = plotLeft + playheadPosition * plotWidth
          context.strokeStyle = active ? '#f4fbf8' : 'rgba(255,179,92,0.68)'
          context.lineWidth = active ? 1.5 : 1
          context.beginPath()
          context.moveTo(cursorX, plotTop + 3)
          context.lineTo(cursorX, plotBottom - 3)
          context.stroke()
        }
      }
    }
  }, [
    active,
    color,
    disabled,
    durationSeconds,
    getFilterFrequencyResponseDb,
    height,
    mode,
    overview,
    palette,
    playheadPosition,
    sampleRate,
    spectrum,
    spectrogram,
    spectrogramBitmap,
    timeMode,
    timeViewport,
    viewMode,
    width,
  ])

  const handleClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    onSelect()
    if (!timeMode) return
    const position = trackPlotPositionAtClientX(event.currentTarget, event.clientX)
    if (position === null) return
    onSeekSample(trackTimeViewportSampleAtPosition(timeViewport, position))
  }

  const handleWheel = (event: ReactWheelEvent<HTMLButtonElement>) => {
    if (!timeMode) return
    const position = trackPlotPositionAtClientX(event.currentTarget, event.clientX)
    if (position === null) return
    event.preventDefault()
    const anchorSample = trackTimeViewportSampleAtPosition(timeViewport, position)
    onTimeViewportChange(zoomTrackTimeViewport(
      timeViewport,
      anchorSample,
      event.deltaY,
      minimumTimeSpanSamples,
    ))
  }

  return (
    <button
      type="button"
      className={`audition-track ${active ? 'active' : ''}`}
      aria-pressed={active}
      aria-label={`${title}；${timeMode ? '点击绘图区跳转时间，滚轮缩放时间轴' : '点击切换试听'}`}
      disabled={disabled}
      style={{ height: `${height}px` }}
      onClick={handleClick}
      onWheel={handleWheel}
    >
      <canvas ref={canvasRef} aria-hidden="true" />
      <span className="audition-track-copy">
        <span className="audition-track-letter">{mode === 'original' ? 'A' : 'B'}</span>
        <span><strong>{title}</strong><small>{detail}</small></span>
      </span>
      <span className="audition-track-state">{active ? <><Radio size={11} /> {playing ? '正在监听' : '当前监听'}</> : '点击试听'}</span>
    </button>
  )
}

export function FilterTrackPreview({
  buffer,
  currentSample,
  filters,
  auditionMode,
  playing,
  spectrum,
  spectrogram,
  getFilterFrequencyResponseDb,
  onAuditionModeChange,
  onSeekSample,
}: FilterTrackPreviewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const theme = useResolvedTheme()
  const resizeSessionRef = useRef<TrackResizeSession | null>(null)
  const [trackHeight, setTrackHeight] = useState(() => defaultTrackLaneHeight(
    typeof window === 'undefined' ? 0 : window.innerHeight,
  ))
  const [maximumTrackHeight, setMaximumTrackHeight] = useState(() => (
    maximumTrackLaneHeight(typeof window === 'undefined' ? 0 : window.innerHeight)
  ))
  const [resizing, setResizing] = useState(false)
  const [viewMode, setViewMode] = useState<TrackViewMode>('waveform')
  const [timeViewportState, setTimeViewportState] = useState<TrackTimeViewportState>(() => ({
    viewport: createTrackTimeViewport(0, 0),
    buffer: null,
    viewMode: 'waveform',
    spectrogram: null,
  }))
  const size = useElementSize(hostRef)
  const laneWidth = Math.max(0, size.width - 20)
  const columns = Math.max(64, Math.min(1_200, Math.round(laneWidth - 156)))
  const timeDomain = useMemo(
    () => resolvePreviewTimeDomain(buffer, viewMode, spectrogram),
    [buffer, spectrogram, viewMode],
  )
  const viewportRevisionMatches = timeViewportState.buffer === buffer
    && timeViewportState.viewMode === viewMode
    && timeViewportState.spectrogram === (viewMode === 'spectrogram' ? spectrogram : null)
  const timeViewport = useMemo(() => (
    viewportRevisionMatches
      ? resolveTrackTimeViewport(timeViewportState.viewport, timeDomain[0], timeDomain[1])
      : createTrackTimeViewport(timeDomain[0], timeDomain[1])
  ), [timeDomain, timeViewportState.viewport, viewportRevisionMatches])
  const setTimeViewport = useCallback((viewport: TrackTimeViewport) => {
    setTimeViewportState({
      viewport,
      buffer,
      viewMode,
      spectrogram: viewMode === 'spectrogram' ? spectrogram : null,
    })
  }, [buffer, spectrogram, viewMode])
  const timeViewportZoomed = timeViewport.startSample !== timeViewport.domainStartSample
    || timeViewport.endSample !== timeViewport.domainEndSample
  const sampleRate = buffer?.sampleRate ?? spectrogram?.sampleRate ?? 0
  const minimumTimeSpanSamples = viewMode === 'spectrogram' && spectrogram && sampleRate > 0
    ? Math.max(64, Math.round(
        spectrogram.hopSize * 2 * (sampleRate / spectrogram.sampleRate),
      ))
    : 64
  const overview = useMemo(() => {
    const channels = buffer
      ? Array.from(
          { length: Math.min(2, buffer.numberOfChannels) },
          (_, channel) => buffer.getChannelData(channel),
        )
      : []
    const range = viewMode === 'waveform'
      ? { start: timeViewport.startSample, end: timeViewport.endSample }
      : { start: 0, end: buffer?.length ?? 0 }
    return buildTrackOverviewRange(channels, columns, range)
  }, [buffer, columns, timeViewport, viewMode])
  const activeFilters = filters.filter((filter) => filter.enabled)
  const filterSummary = activeFilters.length > 0
    ? activeFilters.slice(0, 3).map((filter) => FILTER_DEFINITIONS[filter.type].label).join(' → ')
    : '没有活动处理节点'
  const maximumFrequencyHz = spectrum?.frequenciesHz.at(-1) ?? 0
  const spectrumRange = maximumFrequencyHz >= 1_000
    ? `20 Hz–${Number((maximumFrequencyHz / 1_000).toFixed(1))} kHz`
    : `0–${Math.round(maximumFrequencyHz)} Hz`
  const filterResponseRevision = JSON.stringify(filters)
  const spectrogramResponseDb = useMemo(() => (
    spectrogram && filterResponseRevision.length > 2
      ? getFilterFrequencyResponseDb(Float32Array.from(spectrogram.frequenciesHz))
      : null
  ), [filterResponseRevision, getFilterFrequencyResponseDb, spectrogram])
  const previewIcon = viewMode === 'waveform'
    ? <AudioWaveform size={14} />
    : viewMode === 'spectrum'
      ? <Activity size={14} />
      : <ScanLine size={14} />
  const previewDescription = viewMode === 'waveform'
    ? '共享时间视口 · 点击定位 · 滚轮缩放'
    : viewMode === 'spectrum'
      ? '当前播放位置 · B 轨叠加实时节点响应'
      : '共享分析时段 · 点击定位 · 滚轮缩放'

  useEffect(() => {
    const handleViewportResize = () => {
      const maximumHeight = maximumTrackLaneHeight(window.innerHeight)
      setMaximumTrackHeight(maximumHeight)
      setTrackHeight((height) => Math.min(height, maximumHeight))
    }
    window.addEventListener('resize', handleViewportResize)
    return () => window.removeEventListener('resize', handleViewportResize)
  }, [])

  const startTrackResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const maximumHeight = maximumTrackLaneHeight(window.innerHeight)
    resizeSessionRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: trackHeight,
      maximumHeight,
    }
    setMaximumTrackHeight(maximumHeight)
    setResizing(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const moveTrackResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const session = resizeSessionRef.current
    if (!session || session.pointerId !== event.pointerId) return
    const nextHeight = session.startHeight + session.startY - event.clientY
    setTrackHeight(Math.max(
      MIN_TRACK_LANE_HEIGHT,
      Math.min(session.maximumHeight, Math.round(nextHeight)),
    ))
  }

  const finishTrackResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const session = resizeSessionRef.current
    if (!session || session.pointerId !== event.pointerId) return
    resizeSessionRef.current = null
    setResizing(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const handleResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const increments: Partial<Record<string, number>> = {
      ArrowUp: 8,
      ArrowDown: -8,
      PageUp: 32,
      PageDown: -32,
    }
    const increment = increments[event.key]
    if (increment !== undefined) {
      event.preventDefault()
      setTrackHeight((height) => Math.max(
        MIN_TRACK_LANE_HEIGHT,
        Math.min(maximumTrackHeight, height + increment),
      ))
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      setTrackHeight(event.key === 'Home' ? MIN_TRACK_LANE_HEIGHT : maximumTrackHeight)
    }
  }

  return (
    <div className={`audition-track-preview ${resizing ? 'resizing' : ''}`} ref={hostRef}>
      <div
        className="track-resize-handle"
        role="separator"
        tabIndex={0}
        aria-label="拖拽调整声轨高度，最高为屏幕高度的 60%"
        aria-orientation="horizontal"
        aria-valuemin={MIN_TRACK_LANE_HEIGHT}
        aria-valuemax={maximumTrackHeight}
        aria-valuenow={trackHeight}
        title="上下拖拽调整声轨高度（预览最高占屏幕 60%）"
        onPointerDown={startTrackResize}
        onPointerMove={moveTrackResize}
        onPointerUp={finishTrackResize}
        onPointerCancel={finishTrackResize}
        onKeyDown={handleResizeKeyDown}
      ><GripHorizontal size={15} /></div>
      <header>
        <span>{previewIcon}<strong>声轨 A/B 试听</strong><small>{previewDescription}</small></span>
        <span className="audition-preview-actions">
          <span className="audition-view-switch" role="group" aria-label="声轨显示模式">
            <button type="button" className={viewMode === 'waveform' ? 'active' : ''} aria-pressed={viewMode === 'waveform'} onClick={() => setViewMode('waveform')}><AudioWaveform size={12} /> 波形</button>
            <button type="button" className={viewMode === 'spectrum' ? 'active' : ''} aria-pressed={viewMode === 'spectrum'} onClick={() => setViewMode('spectrum')}><Activity size={12} /> 频谱</button>
            <button type="button" className={viewMode === 'spectrogram' ? 'active' : ''} aria-pressed={viewMode === 'spectrogram'} onClick={() => setViewMode('spectrogram')}><ScanLine size={12} /> 二维声谱</button>
          </span>
          <button
            type="button"
            className="mini-button audition-fit-button"
            disabled={viewMode === 'spectrum' || !buffer || !timeViewportZoomed}
            onClick={() => setTimeViewport(createTrackTimeViewport(timeDomain[0], timeDomain[1]))}
            title="适应当前时间范围"
          ><Maximize2 size={11} /> 适应范围</button>
          <span className="track-height-readout">
            <MoveVertical size={12} />
            <span>拖拽轨高</span>
            <output>{trackHeight}px</output>
            <small>≤60%</small>
          </span>
          <span className={`audition-preview-live ${playing ? 'live' : ''}`}><Waves size={12} /> {playing ? 'PLAYING' : 'READY'}</span>
        </span>
      </header>
      <div className="audition-track-list" role="group" aria-label="处理前后声轨试听">
        <TrackLane
          mode="original"
          title="原始音频"
          detail={viewMode === 'waveform'
            ? '不可变源 PCM'
            : viewMode === 'spectrum'
              ? spectrum ? spectrumRange : '等待频谱分析'
              : spectrogram ? `${spectrogram.frameCount} 帧 · 源 STFT` : '先执行 FFT 分析'}
          color={theme === 'light' ? '#2f6fb6' : '#64a9ff'}
          theme={theme}
          active={auditionMode === 'original'}
          playing={playing}
          currentSample={currentSample}
          sampleRate={sampleRate}
          durationSeconds={buffer?.duration ?? 0}
          overview={overview}
          width={laneWidth}
          height={trackHeight}
          viewMode={viewMode}
          spectrum={spectrum}
          spectrogram={spectrogram}
          spectrogramResponseDb={null}
          timeViewport={timeViewport}
          minimumTimeSpanSamples={minimumTimeSpanSamples}
          getFilterFrequencyResponseDb={getFilterFrequencyResponseDb}
          onSelect={() => onAuditionModeChange('original')}
          onSeekSample={onSeekSample}
          onTimeViewportChange={setTimeViewport}
        />
        <TrackLane
          mode="filtered"
          title="处理结果"
          detail={viewMode === 'waveform'
            ? filterSummary
            : viewMode === 'spectrum'
              ? spectrum ? `${spectrumRange} · 响应叠加` : '等待频谱分析'
              : spectrogram ? `${spectrogram.frameCount} 帧 · 响应叠加` : '先执行 FFT 分析'}
          color={theme === 'light' ? '#087e69' : '#1fdfb2'}
          theme={theme}
          active={auditionMode === 'filtered'}
          disabled={filters.length === 0}
          playing={playing}
          currentSample={currentSample}
          sampleRate={sampleRate}
          durationSeconds={buffer?.duration ?? 0}
          overview={overview}
          width={laneWidth}
          height={trackHeight}
          viewMode={viewMode}
          spectrum={spectrum}
          spectrogram={spectrogram}
          spectrogramResponseDb={spectrogramResponseDb}
          timeViewport={timeViewport}
          minimumTimeSpanSamples={minimumTimeSpanSamples}
          getFilterFrequencyResponseDb={getFilterFrequencyResponseDb}
          onSelect={() => onAuditionModeChange('filtered')}
          onSeekSample={onSeekSample}
          onTimeViewportChange={setTimeViewport}
        />
      </div>
    </div>
  )
}
