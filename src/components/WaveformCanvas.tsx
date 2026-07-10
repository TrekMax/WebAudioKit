import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PeakLevel, WaveformPyramid } from '../audio/peaks'
import { useElementSize } from '../hooks/useElementSize'
import type { SampleSelection } from '../workspaceTypes'

interface WaveformCanvasProps {
  buffer: AudioBuffer | null
  peaks: WaveformPyramid | null
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

const AXIS_HEIGHT = 24
const LEFT_GUTTER = 46
const RIGHT_GUTTER = 10

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

export function WaveformCanvas({
  buffer,
  peaks,
  currentSample,
  selection,
  onSeek,
  onSelectionChange,
  onControlsReady,
}: WaveformCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const size = useElementSize(hostRef)
  const sourceLength = Math.max(1, buffer?.length ?? 1)
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
    canvas.height = Math.round(size.height * dpr)
    canvas.style.width = `${size.width}px`
    canvas.style.height = `${size.height}px`
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(dpr, 0, 0, dpr, 0, 0)
    context.clearRect(0, 0, size.width, size.height)
    context.fillStyle = '#080d14'
    context.fillRect(0, 0, size.width, size.height)

    const channels = Math.max(1, Math.min(2, buffer?.numberOfChannels ?? 1))
    const plotHeight = Math.max(1, size.height - AXIS_HEIGHT)
    const channelHeight = plotHeight / channels
    for (let channel = 0; channel < channels; channel += 1) {
      const top = channel * channelHeight
      const center = top + channelHeight / 2
      context.fillStyle = channel % 2 ? '#090f16' : '#0a1018'
      context.fillRect(LEFT_GUTTER, top, plotWidth, channelHeight)
      context.strokeStyle = 'rgba(113, 137, 159, 0.18)'
      context.beginPath()
      context.moveTo(LEFT_GUTTER, center + 0.5)
      context.lineTo(LEFT_GUTTER + plotWidth, center + 0.5)
      context.stroke()
      context.fillStyle = '#566576'
      context.font = '8px DM Mono, monospace'
      context.textAlign = 'center'
      context.fillText(channels === 1 ? 'MONO' : channel === 0 ? 'L' : 'R', LEFT_GUTTER / 2, center + 3)
    }

    if (buffer && peaks && peaks.levels.length > 0) {
      const samplesPerPixel = (view.end - view.start) / plotWidth
      const level = choosePeakLevel(peaks, samplesPerPixel)
      if (!level) return
      const scaleY = channelHeight * 0.43
      context.strokeStyle = '#25d7ac'
      context.lineWidth = 1
      context.globalAlpha = 0.9
      for (let channel = 0; channel < channels; channel += 1) {
        const peakChannel = level.channels[Math.min(channel, level.channels.length - 1)]
        if (!peakChannel) continue
        const center = channel * channelHeight + channelHeight / 2
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
    } else if (buffer) {
      context.fillStyle = '#657386'
      context.font = '10px Inter, sans-serif'
      context.textAlign = 'center'
      context.fillText('正在构建多分辨率波形…', LEFT_GUTTER + plotWidth / 2, (size.height - AXIS_HEIGHT) / 2)
    } else {
      context.fillStyle = '#657386'
      context.font = '10px Inter, sans-serif'
      context.textAlign = 'center'
      context.fillText('导入音频后显示波形', LEFT_GUTTER + plotWidth / 2, (size.height - AXIS_HEIGHT) / 2)
    }

    if (buffer && displaySelection && displaySelection.end > displaySelection.start) {
      const startX = LEFT_GUTTER + ((displaySelection.start - view.start) / (view.end - view.start)) * plotWidth
      const endX = LEFT_GUTTER + ((displaySelection.end - view.start) / (view.end - view.start)) * plotWidth
      const visibleStart = clamp(startX, LEFT_GUTTER, LEFT_GUTTER + plotWidth)
      const visibleEnd = clamp(endX, LEFT_GUTTER, LEFT_GUTTER + plotWidth)
      context.fillStyle = 'rgba(255, 179, 92, 0.11)'
      context.fillRect(visibleStart, 0, Math.max(0, visibleEnd - visibleStart), plotHeight)
      context.strokeStyle = '#ffb35c'
      context.lineWidth = 1
      for (const x of [startX, endX]) {
        if (x < LEFT_GUTTER || x > LEFT_GUTTER + plotWidth) continue
        context.beginPath()
        context.moveTo(x + 0.5, 0)
        context.lineTo(x + 0.5, plotHeight)
        context.stroke()
        context.fillStyle = '#ffb35c'
        context.fillRect(x - 2, 3, 5, 13)
      }
    }

    if (buffer && currentSample >= view.start && currentSample <= view.end) {
      const x = LEFT_GUTTER + ((currentSample - view.start) / (view.end - view.start)) * plotWidth
      context.strokeStyle = '#eef6fa'
      context.lineWidth = 1
      context.beginPath()
      context.moveTo(x + 0.5, 0)
      context.lineTo(x + 0.5, plotHeight)
      context.stroke()
      context.fillStyle = '#eef6fa'
      context.beginPath()
      context.moveTo(x - 4, 0)
      context.lineTo(x + 5, 0)
      context.lineTo(x + 0.5, 6)
      context.closePath()
      context.fill()
    }

    context.fillStyle = '#090e15'
    context.fillRect(0, plotHeight, size.width, AXIS_HEIGHT)
    context.strokeStyle = '#1d2937'
    context.beginPath()
    context.moveTo(0, plotHeight + 0.5)
    context.lineTo(size.width, plotHeight + 0.5)
    context.stroke()
    if (buffer) {
      const secondsPerPixel = (view.end - view.start) / buffer.sampleRate / plotWidth
      const step = niceTimeStep(secondsPerPixel)
      const startSeconds = view.start / buffer.sampleRate
      const endSeconds = view.end / buffer.sampleRate
      const firstTick = Math.ceil(startSeconds / step) * step
      context.fillStyle = '#5f6e80'
      context.strokeStyle = '#273544'
      context.font = '8px DM Mono, monospace'
      context.textAlign = 'center'
      for (let time = firstTick; time <= endSeconds + step * 0.01; time += step) {
        const x = LEFT_GUTTER + ((time - startSeconds) / (endSeconds - startSeconds)) * plotWidth
        context.beginPath()
        context.moveTo(x + 0.5, plotHeight)
        context.lineTo(x + 0.5, plotHeight + 5)
        context.stroke()
        context.fillText(`${time.toFixed(step < 1 ? 2 : 1)}s`, x, plotHeight + 16)
      }
    }
  }, [buffer, currentSample, displaySelection, peaks, plotWidth, size, view])

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
    <div ref={hostRef} className="plot-host waveform-host">
      <canvas
        ref={canvasRef}
        aria-label="音频波形；拖动创建选区，Shift 拖动平移，滚轮缩放"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={() => setDrag(null)}
        onPointerLeave={() => setHoverSample(null)}
        onWheel={handleWheel}
      />
      {buffer && hoverSample !== null && (
        <div className="waveform-readout">
          {(hoverSample / buffer.sampleRate).toFixed(3)} s · sample {hoverSample.toLocaleString()}
        </div>
      )}
    </div>
  )
}
