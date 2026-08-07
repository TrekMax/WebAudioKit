import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import {
  Activity,
  AudioWaveform,
  GripHorizontal,
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
import {
  MIN_TRACK_LANE_HEIGHT,
  buildTrackPreviewAxes,
  buildTrackOverview,
  buildTrackSpectrogramPixels,
  defaultTrackLaneHeight,
  maximumTrackLaneHeight,
  trackPreviewAxisValueToPosition,
  type TrackPreviewAxes,
  type TrackOverview,
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
}

type TrackViewMode = 'waveform' | 'spectrum' | 'spectrogram'

interface TrackResizeSession {
  readonly pointerId: number
  readonly startY: number
  readonly startHeight: number
  readonly maximumHeight: number
}

interface TrackLaneProps {
  readonly mode: FilterAuditionMode
  readonly title: string
  readonly detail: string
  readonly color: string
  readonly active: boolean
  readonly disabled?: boolean
  readonly playing: boolean
  readonly progress: number
  readonly durationSeconds: number
  readonly overview: TrackOverview
  readonly width: number
  readonly height: number
  readonly viewMode: TrackViewMode
  readonly spectrum: StftPreviewResult | null
  readonly spectrogram: StftPreviewResult | null
  readonly spectrogramResponseDb: Float32Array | null
  readonly getFilterFrequencyResponseDb: (frequenciesHz: Float32Array) => Float32Array | null
  readonly onSelect: () => void
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

function drawTrackAxes(
  context: CanvasRenderingContext2D,
  axes: TrackPreviewAxes,
  bounds: TrackPlotBounds,
  canvasHeight: number,
  active: boolean,
): void {
  const right = bounds.left + bounds.width
  const bottom = bounds.top + bounds.height
  context.save()
  context.lineWidth = 1
  context.strokeStyle = active ? 'rgba(31,223,178,0.14)' : 'rgba(92,112,132,0.14)'
  context.fillStyle = active ? '#81968f' : '#738393'
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

  context.strokeStyle = active ? 'rgba(31,223,178,0.28)' : 'rgba(112,132,152,0.24)'
  context.strokeRect(bounds.left + 0.5, bounds.top + 0.5, bounds.width - 1, bounds.height - 1)
  context.fillStyle = active ? 'rgba(177,207,197,0.82)' : 'rgba(151,168,184,0.78)'
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
  active,
  disabled = false,
  playing,
  progress,
  durationSeconds,
  overview,
  width,
  height,
  viewMode,
  spectrum,
  spectrogram,
  spectrogramResponseDb,
  getFilterFrequencyResponseDb,
  onSelect,
}: TrackLaneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
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
      horizontalTickCount: plotWidth < 320 ? 3 : 5,
      verticalTickCount: plotHeight < 54 ? 3 : 5,
    })
    context.fillStyle = 'rgba(5,10,16,0.58)'
    context.fillRect(plotLeft, plotTop, plotWidth, plotHeight)
    if (viewMode === 'spectrogram' && spectrogramBitmap) {
      context.imageSmoothingEnabled = true
      context.drawImage(spectrogramBitmap, plotLeft, plotTop, plotWidth, plotHeight)
    }
    drawTrackAxes(context, axes, { left: plotLeft, top: plotTop, width: plotWidth, height: plotHeight }, height, active)

    if (viewMode === 'waveform') {
      const center = plotTop + plotHeight / 2
      const { mins, maxs } = overview
      context.strokeStyle = disabled ? '#4c5966' : color
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

      const cursorX = plotLeft + progress * plotWidth
      context.strokeStyle = active ? '#f4fbf8' : 'rgba(210,222,232,0.38)'
      context.lineWidth = active ? 1.5 : 1
      context.beginPath()
      context.moveTo(cursorX, plotTop + 3)
      context.lineTo(cursorX, plotBottom - 3)
      context.stroke()
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
        context.strokeStyle = disabled ? '#4c5966' : color
        context.globalAlpha = disabled ? 0.42 : active ? 0.95 : 0.68
        context.lineWidth = active ? 1.5 : 1
        context.stroke()
        context.globalAlpha = 1
      }
    } else if (viewMode === 'spectrogram') {
      if (!spectrogramBitmap) {
        context.fillStyle = '#647586'
        context.font = '12px Inter, system-ui, sans-serif'
        context.textAlign = 'center'
        context.fillText('完成 FFT 分析后显示二维声谱', plotLeft + plotWidth / 2, plotTop + plotHeight / 2)
      } else {
        const cursorX = plotLeft + progress * plotWidth
        context.strokeStyle = active ? '#f4fbf8' : 'rgba(255,179,92,0.68)'
        context.lineWidth = active ? 1.5 : 1
        context.beginPath()
        context.moveTo(cursorX, plotTop + 3)
        context.lineTo(cursorX, plotBottom - 3)
        context.stroke()
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
    progress,
    spectrum,
    spectrogram,
    spectrogramBitmap,
    viewMode,
    width,
  ])

  return (
    <button
      type="button"
      className={`audition-track ${active ? 'active' : ''}`}
      aria-pressed={active}
      disabled={disabled}
      style={{ height: `${height}px` }}
      onClick={onSelect}
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
}: FilterTrackPreviewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const resizeSessionRef = useRef<TrackResizeSession | null>(null)
  const [trackHeight, setTrackHeight] = useState(() => defaultTrackLaneHeight(
    typeof window === 'undefined' ? 0 : window.innerHeight,
  ))
  const [maximumTrackHeight, setMaximumTrackHeight] = useState(() => (
    maximumTrackLaneHeight(typeof window === 'undefined' ? 0 : window.innerHeight)
  ))
  const [resizing, setResizing] = useState(false)
  const [viewMode, setViewMode] = useState<TrackViewMode>('waveform')
  const size = useElementSize(hostRef)
  const laneWidth = Math.max(0, size.width - 20)
  const columns = Math.max(64, Math.min(1_200, Math.round(laneWidth - 156)))
  const overview = useMemo(() => {
    const channels = buffer
      ? Array.from(
          { length: Math.min(2, buffer.numberOfChannels) },
          (_, channel) => buffer.getChannelData(channel),
        )
      : []
    return buildTrackOverview(channels, columns)
  }, [buffer, columns])
  const progress = buffer && buffer.length > 0
    ? Math.max(0, Math.min(1, currentSample / buffer.length))
    : 0
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
  const spectrogramStartTime = spectrogram?.timesSeconds[0]
  const spectrogramEndTime = spectrogram?.timesSeconds.at(-1)
  const spectrogramProgress = spectrogram
    && typeof spectrogramStartTime === 'number'
    && typeof spectrogramEndTime === 'number'
    && spectrogramEndTime > spectrogramStartTime
    ? Math.max(0, Math.min(
        1,
        (currentSample / spectrogram.sampleRate - spectrogramStartTime)
          / (spectrogramEndTime - spectrogramStartTime),
      ))
    : progress
  const laneProgress = viewMode === 'spectrogram' ? spectrogramProgress : progress
  const previewIcon = viewMode === 'waveform'
    ? <AudioWaveform size={14} />
    : viewMode === 'spectrum'
      ? <Activity size={14} />
      : <ScanLine size={14} />
  const previewDescription = viewMode === 'waveform'
    ? '共享源时间轮廓 · 实时监听路径独立'
    : viewMode === 'spectrum'
      ? '当前播放位置 · B 轨叠加实时节点响应'
      : '时间—频率能量 · B 轨叠加节点响应'

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
          color="#64a9ff"
          active={auditionMode === 'original'}
          playing={playing}
          progress={laneProgress}
          durationSeconds={buffer?.duration ?? 0}
          overview={overview}
          width={laneWidth}
          height={trackHeight}
          viewMode={viewMode}
          spectrum={spectrum}
          spectrogram={spectrogram}
          spectrogramResponseDb={null}
          getFilterFrequencyResponseDb={getFilterFrequencyResponseDb}
          onSelect={() => onAuditionModeChange('original')}
        />
        <TrackLane
          mode="filtered"
          title="处理结果"
          detail={viewMode === 'waveform'
            ? filterSummary
            : viewMode === 'spectrum'
              ? spectrum ? `${spectrumRange} · 响应叠加` : '等待频谱分析'
              : spectrogram ? `${spectrogram.frameCount} 帧 · 响应叠加` : '先执行 FFT 分析'}
          color="#1fdfb2"
          active={auditionMode === 'filtered'}
          disabled={filters.length === 0}
          playing={playing}
          progress={laneProgress}
          durationSeconds={buffer?.duration ?? 0}
          overview={overview}
          width={laneWidth}
          height={trackHeight}
          viewMode={viewMode}
          spectrum={spectrum}
          spectrogram={spectrogram}
          spectrogramResponseDb={spectrogramResponseDb}
          getFilterFrequencyResponseDb={getFilterFrequencyResponseDb}
          onSelect={() => onAuditionModeChange('filtered')}
        />
      </div>
    </div>
  )
}
