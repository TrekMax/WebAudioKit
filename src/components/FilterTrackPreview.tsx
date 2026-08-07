import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'
import { Activity, AudioWaveform, GripHorizontal, MoveVertical, Radio, Waves } from 'lucide-react'

import type { StftPreviewResult } from '../audio/analysis'
import {
  FILTER_DEFINITIONS,
  type FilterAuditionMode,
  type FilterNodeConfig,
} from '../audio/filterGraph'
import { useElementSize } from '../hooks/useElementSize'
import {
  MIN_TRACK_LANE_HEIGHT,
  buildTrackOverview,
  maximumTrackLaneHeight,
  type TrackOverview,
} from '../visualization/trackPreview'

interface FilterTrackPreviewProps {
  readonly buffer: AudioBuffer | null
  readonly currentSample: number
  readonly filters: readonly FilterNodeConfig[]
  readonly auditionMode: FilterAuditionMode
  readonly playing: boolean
  readonly spectrum: StftPreviewResult | null
  readonly getFilterFrequencyResponseDb: (frequenciesHz: Float32Array) => Float32Array | null
  readonly onAuditionModeChange: (mode: FilterAuditionMode) => void
}

type TrackViewMode = 'waveform' | 'spectrum'

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
  readonly overview: TrackOverview
  readonly width: number
  readonly height: number
  readonly viewMode: TrackViewMode
  readonly spectrum: StftPreviewResult | null
  readonly getFilterFrequencyResponseDb: (frequenciesHz: Float32Array) => Float32Array | null
  readonly onSelect: () => void
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
  overview,
  width,
  height,
  viewMode,
  spectrum,
  getFilterFrequencyResponseDb,
  onSelect,
}: TrackLaneProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

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

    const plotLeft = 142
    const plotRight = 14
    const plotWidth = Math.max(1, width - plotLeft - plotRight)
    context.strokeStyle = active ? 'rgba(31,223,178,0.13)' : 'rgba(76,96,116,0.13)'
    context.lineWidth = 1
    for (let line = 0; line <= 8; line += 1) {
      const x = plotLeft + (line / 8) * plotWidth
      context.beginPath()
      context.moveTo(x, 0)
      context.lineTo(x, height)
      context.stroke()
    }

    if (viewMode === 'waveform') {
      const center = height / 2
      const { mins, maxs } = overview
      context.strokeStyle = disabled ? '#4c5966' : color
      context.globalAlpha = disabled ? 0.42 : active ? 0.95 : 0.62
      context.lineWidth = 1
      context.beginPath()
      for (let column = 0; column < mins.length; column += 1) {
        const x = plotLeft + (column / Math.max(1, mins.length - 1)) * plotWidth
        const top = center - (maxs[column] ?? 0) * (height * 0.38)
        const bottom = center - (mins[column] ?? 0) * (height * 0.38)
        context.moveTo(x, top)
        context.lineTo(x, bottom)
      }
      context.stroke()
      context.globalAlpha = 1

      const cursorX = plotLeft + progress * plotWidth
      context.strokeStyle = active ? '#f4fbf8' : 'rgba(210,222,232,0.38)'
      context.lineWidth = active ? 1.5 : 1
      context.beginPath()
      context.moveTo(cursorX, 5)
      context.lineTo(cursorX, height - 5)
      context.stroke()
    } else if (spectrum && spectrum.frameCount > 0 && spectrum.binCount > 1) {
      const frameOffset = (spectrum.frameCount - 1) * spectrum.binCount
      const maximumFrequencyHz = spectrum.frequenciesHz.at(-1) ?? 0
      const minimumFrequencyHz = Math.min(20, maximumFrequencyHz)
      const frequencySpan = Math.max(1, Math.log10(Math.max(1, maximumFrequencyHz)) - Math.log10(Math.max(1, minimumFrequencyHz)))
      const filterResponseDb = mode === 'filtered'
        ? getFilterFrequencyResponseDb(Float32Array.from(spectrum.frequenciesHz))
        : null
      const points: Array<readonly [number, number]> = []
      for (let bin = 0; bin < spectrum.binCount; bin += 1) {
        const frequencyHz = spectrum.frequenciesHz[bin] ?? 0
        if (frequencyHz < minimumFrequencyHz || frequencyHz > maximumFrequencyHz) continue
        const sourceDb = spectrum.valuesDbfs[frameOffset + bin] ?? spectrum.minDb
        const responseDb = filterResponseDb?.[bin] ?? 0
        const valueDb = sourceDb + responseDb
        const unitX = (Math.log10(Math.max(1, frequencyHz)) - Math.log10(Math.max(1, minimumFrequencyHz))) / frequencySpan
        const unitY = Math.max(0, Math.min(1, (valueDb - spectrum.minDb) / (spectrum.maxDb - spectrum.minDb)))
        points.push([
          plotLeft + unitX * plotWidth,
          6 + (1 - unitY) * Math.max(1, height - 12),
        ])
      }
      const first = points[0]
      if (first && points.length > 1) {
        const gradient = context.createLinearGradient(0, height, 0, 0)
        gradient.addColorStop(0, 'rgba(31,223,178,0.015)')
        gradient.addColorStop(1, mode === 'filtered' ? 'rgba(31,223,178,0.22)' : 'rgba(100,169,255,0.2)')
        context.beginPath()
        context.moveTo(first[0], height - 5)
        context.lineTo(first[0], first[1])
        for (const point of points.slice(1)) context.lineTo(point[0], point[1])
        const last = points.at(-1)
        if (last) context.lineTo(last[0], height - 5)
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
    }
  }, [
    active,
    color,
    disabled,
    getFilterFrequencyResponseDb,
    height,
    mode,
    overview,
    progress,
    spectrum,
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
  getFilterFrequencyResponseDb,
  onAuditionModeChange,
}: FilterTrackPreviewProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const resizeSessionRef = useRef<TrackResizeSession | null>(null)
  const [trackHeight, setTrackHeight] = useState(() => Math.min(
    72,
    maximumTrackLaneHeight(typeof window === 'undefined' ? 0 : window.innerHeight),
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
        <span>{viewMode === 'waveform' ? <AudioWaveform size={14} /> : <Activity size={14} />}<strong>声轨 A/B 试听</strong><small>{viewMode === 'waveform' ? '共享源时间轮廓 · 实时监听路径独立' : '当前播放位置 · B 轨叠加实时节点响应'}</small></span>
        <span className="audition-preview-actions">
          <span className="audition-view-switch" role="group" aria-label="声轨显示模式">
            <button type="button" className={viewMode === 'waveform' ? 'active' : ''} aria-pressed={viewMode === 'waveform'} onClick={() => setViewMode('waveform')}><AudioWaveform size={12} /> 波形</button>
            <button type="button" className={viewMode === 'spectrum' ? 'active' : ''} aria-pressed={viewMode === 'spectrum'} onClick={() => setViewMode('spectrum')}><Activity size={12} /> 频谱</button>
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
          detail={viewMode === 'waveform' ? '不可变源 PCM' : spectrum ? spectrumRange : '等待频谱分析'}
          color="#64a9ff"
          active={auditionMode === 'original'}
          playing={playing}
          progress={progress}
          overview={overview}
          width={laneWidth}
          height={trackHeight}
          viewMode={viewMode}
          spectrum={spectrum}
          getFilterFrequencyResponseDb={getFilterFrequencyResponseDb}
          onSelect={() => onAuditionModeChange('original')}
        />
        <TrackLane
          mode="filtered"
          title="处理结果"
          detail={viewMode === 'waveform' ? filterSummary : spectrum ? `${spectrumRange} · 响应叠加` : '等待频谱分析'}
          color="#1fdfb2"
          active={auditionMode === 'filtered'}
          disabled={filters.length === 0}
          playing={playing}
          progress={progress}
          overview={overview}
          width={laneWidth}
          height={trackHeight}
          viewMode={viewMode}
          spectrum={spectrum}
          getFilterFrequencyResponseDb={getFilterFrequencyResponseDb}
          onSelect={() => onAuditionModeChange('filtered')}
        />
      </div>
    </div>
  )
}
