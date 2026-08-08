import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PeakLevel, WaveformPyramid } from '../audio/peaks'
import { useElementSize } from '../hooks/useElementSize'
import { useResolvedTheme } from '../hooks/useResolvedTheme'
import type { ResolvedTheme } from '../theme'
import type { SampleSelection } from '../workspaceTypes'
import {
  WAVEFORM_AXIS_HEIGHT,
  calculateWaveformCanvasHeight,
  normalizeVisibleChannels,
} from './waveformLayout'

interface WaveformCanvasProps {
  buffer: AudioBuffer | null
  peaks: WaveformPyramid | null
  visibleChannels: readonly number[]
  currentSample: number
  selection: SampleSelection | null
  onSeek: (sample: number) => void
  onSelectionChange: (selection: SampleSelection | null) => void
  onControlsReady?: (controls: { fit: () => void; zoomToSelection: () => void }) => void
}

interface DragState {
  pointerId: number
  anchorSample: number
  currentSample: number
  kind: 'selection' | 'pan'
  viewStartAtPointerDown: number
  viewEndAtPointerDown: number
  pointerXAtStart: number
}

const LEFT_GUTTER = 46
const RIGHT_GUTTER = 10
const AXIS_HEIGHT = WAVEFORM_AXIS_HEIGHT

interface WaveformCanvasPalette {
  readonly axisBackground: string
  readonly axisBorder: string
  readonly axisText: string
  readonly axisTick: string
  readonly canvasBackground: string
  readonly trackEven: string
  readonly trackOdd: string
  readonly centerLine: string
  readonly channelLabel: string
  readonly emptyText: string
  readonly waveform: string
  readonly selectionFill: string
  readonly selectionBorder: string
  readonly playhead: string
}

const WAVEFORM_CANVAS_PALETTES: Readonly<Record<ResolvedTheme, WaveformCanvasPalette>> = {
  dark: {
    axisBackground: '#090e15',
    axisBorder: '#1d2937',
    axisText: '#5f6e80',
    axisTick: '#273544',
    canvasBackground: '#080d14',
    trackEven: '#0a1018',
    trackOdd: '#090f16',
    centerLine: 'rgba(113,137,159,0.18)',
    channelLabel: '#566576',
    emptyText: '#657386',
    waveform: '#25d7ac',
    selectionFill: 'rgba(255,179,92,0.11)',
    selectionBorder: '#ffb35c',
    playhead: '#eef6fa',
  },
  light: {
    axisBackground: '#f2f7f8',
    axisBorder: '#cad8dc',
    axisText: '#5c727b',
    axisTick: '#9fb3ba',
    canvasBackground: '#f4f8f9',
    trackEven: '#ffffff',
    trackOdd: '#f1f6f7',
    centerLine: 'rgba(74,101,111,0.2)',
    channelLabel: '#526870',
    emptyText: '#5f747c',
    waveform: '#087e69',
    selectionFill: 'rgba(185,107,23,0.14)',
    selectionBorder: '#b96b17',
    playhead: '#263e47',
  },
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function choosePeakLevel(
  pyramid: WaveformPyramid,
  samplesPerPixel: number,
): PeakLevel | null {
  let best = pyramid.levels[0]
  if (!best) return null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const level of pyramid.levels) {
    const distance = Math.abs(Math.log2(level.samplesPerBlock / Math.max(1, samplesPerPixel)))
    if (distance < bestDistance) {
      best = level
      bestDistance = distance
    }
  }
  return best
}

function niceTimeStep(secondsPerPixel: number): number {
  const target = secondsPerPixel * 90
  const exponent = 10 ** Math.floor(Math.log10(Math.max(target, 0.001)))
  for (const multiplier of [1, 2, 5, 10]) {
    const step = exponent * multiplier
    if (step >= target) return step
  }
  return exponent * 10
}

function drawTimeAxis(
  context: CanvasRenderingContext2D,
  width: number,
  buffer: AudioBuffer | null,
  view: { start: number; end: number },
  plotWidth: number,
  palette: WaveformCanvasPalette,
): void {
  context.clearRect(0, 0, width, AXIS_HEIGHT)
  context.fillStyle = palette.axisBackground
  context.fillRect(0, 0, width, AXIS_HEIGHT)
  context.strokeStyle = palette.axisBorder
  context.beginPath()
  context.moveTo(0, 0.5)
  context.lineTo(width, 0.5)
  context.stroke()
  if (!buffer) return

  const secondsPerPixel = (view.end - view.start) / buffer.sampleRate / plotWidth
  const step = niceTimeStep(secondsPerPixel)
  const startSeconds = view.start / buffer.sampleRate
  const endSeconds = view.end / buffer.sampleRate
  const firstTick = Math.ceil(startSeconds / step) * step
  context.fillStyle = palette.axisText
  context.strokeStyle = palette.axisTick
  context.font = '11px DM Mono, monospace'
  context.textAlign = 'center'
  for (let time = firstTick; time <= endSeconds + step * 0.01; time += step) {
    const x = LEFT_GUTTER + ((time - startSeconds) / (endSeconds - startSeconds)) * plotWidth
    context.beginPath()
    context.moveTo(x + 0.5, 0)
    context.lineTo(x + 0.5, 5)
    context.stroke()
    context.fillText(`${time.toFixed(step < 1 ? 2 : 1)}s`, x, 16)
  }
}

export function WaveformCanvas({
  buffer,
  peaks,
  visibleChannels,
  currentSample,
  selection,
  onSeek,
  onSelectionChange,
  onControlsReady,
}: WaveformCanvasProps) {
  const scrollAreaRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const axisCanvasRef = useRef<HTMLCanvasElement>(null)
  const theme = useResolvedTheme()
  const palette = WAVEFORM_CANVAS_PALETTES[theme]
  const size = useElementSize(scrollAreaRef)
  const sourceLength = Math.max(1, buffer?.length ?? 1)
  const channelIndexes = useMemo(
    () => normalizeVisibleChannels(visibleChannels, buffer?.numberOfChannels ?? 0),
    [buffer?.numberOfChannels, visibleChannels],
  )
  const layoutHeight = calculateWaveformCanvasHeight(
    size.height + AXIS_HEIGHT,
    channelIndexes.length,
  )
  const trackCanvasHeight = Math.max(1, layoutHeight - AXIS_HEIGHT)
  const hasVerticalTrackScroll = trackCanvasHeight > size.height
  const [viewState, setView] = useState({ start: 0, end: 1, sourceLength: 0 })
  const view = useMemo(
    () => viewState.sourceLength === sourceLength
      ? viewState
      : { start: 0, end: sourceLength, sourceLength },
    [sourceLength, viewState],
  )
  const [drag, setDrag] = useState<DragState | null>(null)
  const [hoverSample, setHoverSample] = useState<number | null>(null)

  const fit = useCallback(() => {
    const length = Math.max(1, buffer?.length ?? 1)
    setView({ start: 0, end: length, sourceLength: length })
  }, [buffer])

  const zoomToSelection = useCallback(() => {
    if (!buffer || !selection || selection.end <= selection.start) return
    const padding = Math.max(16, (selection.end - selection.start) * 0.08)
    setView({
      start: clamp(selection.start - padding, 0, buffer.length),
      end: clamp(selection.end + padding, 0, buffer.length),
      sourceLength: buffer.length,
    })
  }, [buffer, selection])

  useEffect(() => {
    onControlsReady?.({ fit, zoomToSelection })
  }, [fit, onControlsReady, zoomToSelection])

  const plotWidth = Math.max(1, size.width - LEFT_GUTTER - RIGHT_GUTTER)
  const sampleAtClientX = useCallback((clientX: number): number => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect || !buffer) return 0
    const unit = clamp((clientX - rect.left - LEFT_GUTTER) / Math.max(1, rect.width - LEFT_GUTTER - RIGHT_GUTTER), 0, 1)
    return Math.round(view.start + unit * (view.end - view.start))
  }, [buffer, view])

  const displaySelection = useMemo<SampleSelection | null>(() => {
    if (drag?.kind !== 'selection') return selection
    return {
      start: Math.min(drag.anchorSample, drag.currentSample),
      end: Math.max(drag.anchorSample, drag.currentSample),
    }
  }, [drag, selection])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || size.width <= 0 || size.height <= 0) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(size.width * dpr)
    canvas.height = Math.round(trackCanvasHeight * dpr)
    canvas.style.width = `${size.width}px`
    canvas.style.height = `${trackCanvasHeight}px`
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, size.width, trackCanvasHeight)
    context.fillStyle = palette.canvasBackground
    context.fillRect(0, 0, size.width, trackCanvasHeight)

    const plotHeight = trackCanvasHeight
    const channelHeight = channelIndexes.length > 0
      ? plotHeight / channelIndexes.length
      : plotHeight
    for (let trackIndex = 0; trackIndex < channelIndexes.length; trackIndex += 1) {
      const channelIndex = channelIndexes[trackIndex]
      if (channelIndex === undefined) continue
      const top = trackIndex * channelHeight
      const center = top + channelHeight / 2
      context.fillStyle = trackIndex % 2 ? palette.trackOdd : palette.trackEven
      context.fillRect(LEFT_GUTTER, top, plotWidth, channelHeight)
      context.strokeStyle = palette.centerLine
      context.beginPath()
      context.moveTo(LEFT_GUTTER, center + 0.5)
      context.lineTo(LEFT_GUTTER + plotWidth, center + 0.5)
      context.stroke()
      context.fillStyle = palette.channelLabel
      context.font = '11px DM Mono, monospace'
      context.textAlign = 'center'
      const label = buffer?.numberOfChannels === 1 ? 'MONO' : `CH ${channelIndex + 1}`
      context.fillText(label, LEFT_GUTTER / 2, center + 3)
    }

    if (buffer && channelIndexes.length === 0) {
      context.fillStyle = palette.emptyText
      context.font = '13px Inter, sans-serif'
      context.textAlign = 'center'
      context.fillText('请选择要显示的声道', LEFT_GUTTER + plotWidth / 2, plotHeight / 2)
    } else if (buffer && peaks && peaks.levels.length > 0) {
      const samplesPerPixel = (view.end - view.start) / plotWidth
      const level = choosePeakLevel(peaks, samplesPerPixel)
      if (level) {
        const scaleY = channelHeight * 0.43
        context.strokeStyle = palette.waveform
        context.lineWidth = 1
        context.globalAlpha = 0.9
        for (let trackIndex = 0; trackIndex < channelIndexes.length; trackIndex += 1) {
          const channelIndex = channelIndexes[trackIndex]
          if (channelIndex === undefined) continue
          const peakChannel = level.channels[channelIndex]
          if (!peakChannel || peakChannel.mins.length === 0) continue
          const center = trackIndex * channelHeight + channelHeight / 2
          context.beginPath()
          for (let x = 0; x < plotWidth; x += 1) {
            const sampleStart = view.start + (x / plotWidth) * (view.end - view.start)
            const sampleEnd = view.start + ((x + 1) / plotWidth) * (view.end - view.start)
            const firstBlock = clamp(Math.floor(sampleStart / level.samplesPerBlock), 0, peakChannel.mins.length - 1)
            const lastBlock = clamp(Math.floor(sampleEnd / level.samplesPerBlock), firstBlock, peakChannel.mins.length - 1)
            let min = 1
            let max = -1
            for (let block = firstBlock; block <= Math.min(lastBlock, firstBlock + 4); block += 1) {
              min = Math.min(min, peakChannel.mins[block] ?? 0)
              max = Math.max(max, peakChannel.maxs[block] ?? 0)
            }
            const canvasX = LEFT_GUTTER + x + 0.5
            context.moveTo(canvasX, center - max * scaleY)
            context.lineTo(canvasX, center - min * scaleY)
          }
          context.stroke()
        }
        context.globalAlpha = 1
      }
    } else if (buffer) {
      context.fillStyle = palette.emptyText
      context.font = '13px Inter, sans-serif'
      context.textAlign = 'center'
      context.fillText('正在构建多分辨率波形…', LEFT_GUTTER + plotWidth / 2, plotHeight / 2)
    } else {
      context.fillStyle = palette.emptyText
      context.font = '13px Inter, sans-serif'
      context.textAlign = 'center'
      context.fillText('导入音频后显示波形', LEFT_GUTTER + plotWidth / 2, plotHeight / 2)
    }

    if (buffer && displaySelection && displaySelection.end > displaySelection.start) {
      const startX = LEFT_GUTTER + ((displaySelection.start - view.start) / (view.end - view.start)) * plotWidth
      const endX = LEFT_GUTTER + ((displaySelection.end - view.start) / (view.end - view.start)) * plotWidth
      const visibleStart = clamp(startX, LEFT_GUTTER, LEFT_GUTTER + plotWidth)
      const visibleEnd = clamp(endX, LEFT_GUTTER, LEFT_GUTTER + plotWidth)
      context.fillStyle = palette.selectionFill
      context.fillRect(visibleStart, 0, Math.max(0, visibleEnd - visibleStart), plotHeight)
      context.strokeStyle = palette.selectionBorder
      context.lineWidth = 1
      for (const x of [startX, endX]) {
        if (x < LEFT_GUTTER || x > LEFT_GUTTER + plotWidth) continue
        context.beginPath()
        context.moveTo(x + 0.5, 0)
        context.lineTo(x + 0.5, plotHeight)
        context.stroke()
        context.fillStyle = palette.selectionBorder
        context.fillRect(x - 2, 3, 5, 13)
      }
    }

    if (buffer && currentSample >= view.start && currentSample <= view.end) {
      const x = LEFT_GUTTER + ((currentSample - view.start) / (view.end - view.start)) * plotWidth
      context.strokeStyle = palette.playhead
      context.lineWidth = 1
      context.beginPath()
      context.moveTo(x + 0.5, 0)
      context.lineTo(x + 0.5, plotHeight)
      context.stroke()
      context.fillStyle = palette.playhead
      context.beginPath()
      context.moveTo(x - 4, 0)
      context.lineTo(x + 5, 0)
      context.lineTo(x + 0.5, 6)
      context.closePath()
      context.fill()
    }

    const axisCanvas = axisCanvasRef.current
    const axisContext = axisCanvas?.getContext('2d')
    if (axisCanvas && axisContext) {
      axisCanvas.width = Math.round(size.width * dpr)
      axisCanvas.height = Math.round(AXIS_HEIGHT * dpr)
      axisCanvas.style.width = `${size.width}px`
      axisCanvas.style.height = `${AXIS_HEIGHT}px`
      axisContext.setTransform(dpr, 0, 0, dpr, 0, 0)
      drawTimeAxis(axisContext, size.width, buffer, view, plotWidth, palette)
    }
  }, [buffer, channelIndexes, currentSample, displaySelection, palette, peaks, plotWidth, size, trackCanvasHeight, view])

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!buffer || event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const sample = sampleAtClientX(event.clientX)
    setDrag({
      pointerId: event.pointerId,
      anchorSample: sample,
      currentSample: sample,
      kind: event.shiftKey ? 'pan' : 'selection',
      viewStartAtPointerDown: view.start,
      viewEndAtPointerDown: view.end,
      pointerXAtStart: event.clientX,
    })
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!buffer) return
    const sample = sampleAtClientX(event.clientX)
    setHoverSample(sample)
    if (!drag || drag.pointerId !== event.pointerId) return
    if (drag.kind === 'selection') {
      setDrag({ ...drag, currentSample: sample })
      return
    }
    const sampleDelta = ((event.clientX - drag.pointerXAtStart) / plotWidth) * (drag.viewEndAtPointerDown - drag.viewStartAtPointerDown)
    const length = drag.viewEndAtPointerDown - drag.viewStartAtPointerDown
    const start = clamp(drag.viewStartAtPointerDown - sampleDelta, 0, buffer.length - length)
    setView({ start, end: start + length, sourceLength: buffer.length })
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    if (drag.kind === 'selection') {
      const start = Math.min(drag.anchorSample, drag.currentSample)
      const end = Math.max(drag.anchorSample, drag.currentSample)
      if (end - start < 2) {
        onSelectionChange(null)
        onSeek(start)
      } else {
        onSelectionChange({ start, end })
        onSeek(start)
      }
    }
    setDrag(null)
  }

  const handleWheel = (event: React.WheelEvent<HTMLCanvasElement>) => {
    if (!buffer) return
    if (
      hasVerticalTrackScroll
      && !event.ctrlKey
      && !event.metaKey
      && Math.abs(event.deltaY) >= Math.abs(event.deltaX)
    ) return

    event.preventDefault()
    const anchor = sampleAtClientX(event.clientX)
    const currentLength = view.end - view.start
    const factor = Math.exp(event.deltaY * 0.0014)
    const nextLength = clamp(currentLength * factor, 64, buffer.length)
    const anchorUnit = (anchor - view.start) / currentLength
    let start = anchor - anchorUnit * nextLength
    start = clamp(start, 0, buffer.length - nextLength)
    setView({ start, end: start + nextLength, sourceLength: buffer.length })
  }

  return (
    <div className="plot-host waveform-host">
      <div
        ref={scrollAreaRef}
        className="waveform-scroll-area"
        role="region"
        aria-label="波形声道轨道"
        tabIndex={hasVerticalTrackScroll ? 0 : -1}
      >
        <canvas
          ref={canvasRef}
          aria-label={hasVerticalTrackScroll
            ? '音频波形；拖动创建选区，Shift 拖动平移，滚轮滚动声道，Ctrl 或 Command 加滚轮缩放'
            : '音频波形；拖动创建选区，Shift 拖动平移，滚轮缩放'}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={() => setDrag(null)}
          onPointerLeave={() => setHoverSample(null)}
          onWheel={handleWheel}
        />
      </div>
      <canvas ref={axisCanvasRef} className="waveform-axis-canvas" aria-hidden="true" />
      {buffer && hoverSample !== null && (
        <div className="waveform-readout">
          {(hoverSample / buffer.sampleRate).toFixed(3)} s · sample {hoverSample.toLocaleString()}
        </div>
      )}
    </div>
  )
}
