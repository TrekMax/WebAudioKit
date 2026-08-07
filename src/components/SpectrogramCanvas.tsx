import { useEffect, useMemo, useRef, useState } from 'react'
import type { StftPreviewResult } from '../audio/analysis'
import { useElementSize } from '../hooks/useElementSize'
import { normalizeDb, spectrumColor } from '../visualization/colorMap'
import {
  formatFrequency,
  PLOT_MARGIN,
  unitToFrequency,
} from '../visualization/plotUtils'

interface SpectrogramCanvasProps {
  result: StftPreviewResult | null
  currentTime: number
  minDb: number
  maxDb: number
  frequencyScale: 'linear' | 'log'
}

interface HoverValue {
  x: number
  y: number
  time: number
  frequency: number
  db: number
}

export function SpectrogramCanvas({
  result,
  currentTime,
  minDb,
  maxDb,
  frequencyScale,
}: SpectrogramCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const size = useElementSize(hostRef)
  const [hover, setHover] = useState<HoverValue | null>(null)

  const bitmap = useMemo(() => {
    if (!result || result.frameCount === 0 || result.binCount === 0) return null
    const offscreen = document.createElement('canvas')
    offscreen.width = result.frameCount
    offscreen.height = result.binCount
    const context = offscreen.getContext('2d')
    if (!context) return null
    const image = context.createImageData(result.frameCount, result.binCount)
    for (let frame = 0; frame < result.frameCount; frame += 1) {
      for (let bin = 0; bin < result.binCount; bin += 1) {
        const sourceIndex = frame * result.binCount + bin
        const targetY = result.binCount - bin - 1
        const targetIndex = (targetY * result.frameCount + frame) * 4
        const [red, green, blue] = spectrumColor(
          normalizeDb(result.valuesDbfs[sourceIndex] ?? minDb, minDb, maxDb),
        )
        image.data[targetIndex] = red
        image.data[targetIndex + 1] = green
        image.data[targetIndex + 2] = blue
        image.data[targetIndex + 3] = 255
      }
    }
    context.putImageData(image, 0, 0)
    return offscreen
  }, [maxDb, minDb, result])

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
    const plotWidth = Math.max(1, size.width - PLOT_MARGIN.left - PLOT_MARGIN.right)
    const plotHeight = Math.max(1, size.height - PLOT_MARGIN.top - PLOT_MARGIN.bottom)
    context.fillStyle = '#090e16'
    context.fillRect(PLOT_MARGIN.left, PLOT_MARGIN.top, plotWidth, plotHeight)

    if (bitmap && result) {
      context.imageSmoothingEnabled = true
      const maxFrequency = result.frequenciesHz.at(-1) ?? result.sampleRate / 2
      const minimumFrequency = frequencyScale === 'log' && maxFrequency > 20 ? 20 : 0
      if (frequencyScale === 'linear' || minimumFrequency === 0) {
        context.drawImage(bitmap, PLOT_MARGIN.left, PLOT_MARGIN.top, plotWidth, plotHeight)
      } else {
        const rows = Math.max(1, Math.ceil(plotHeight))
        for (let row = 0; row < rows; row += 1) {
          const unit = 1 - row / Math.max(1, rows - 1)
          const frequency = unitToFrequency(unit, minimumFrequency, maxFrequency, 'log')
          const bin = Math.max(0, Math.min(result.binCount - 1, Math.round(frequency * result.fftSize / result.sampleRate)))
          const sourceY = result.binCount - bin - 1
          context.drawImage(
            bitmap,
            0,
            sourceY,
            result.frameCount,
            1,
            PLOT_MARGIN.left,
            PLOT_MARGIN.top + row,
            plotWidth,
            1,
          )
        }
      }
      const firstTime = result?.timesSeconds[0] ?? 0
      const lastTime = result?.timesSeconds.at(-1) ?? 1
      const progress = Math.max(0, Math.min(1, (currentTime - firstTime) / Math.max(0.001, lastTime - firstTime)))
      const cursorX = PLOT_MARGIN.left + progress * plotWidth
      context.strokeStyle = '#ffb35c'
      context.lineWidth = 1.5
      context.beginPath()
      context.moveTo(cursorX, PLOT_MARGIN.top)
      context.lineTo(cursorX, PLOT_MARGIN.top + plotHeight)
      context.stroke()
    } else {
      context.fillStyle = '#6f7d91'
      context.font = '15px Inter, system-ui, sans-serif'
      context.textAlign = 'center'
      context.fillText(
        '完成 FFT 分析后显示时间—频率能量分布',
        PLOT_MARGIN.left + plotWidth / 2,
        PLOT_MARGIN.top + plotHeight / 2,
      )
    }

    context.strokeStyle = 'rgba(145, 165, 190, 0.22)'
    context.fillStyle = '#8290a3'
    context.font = '13px Inter, system-ui, sans-serif'
    context.lineWidth = 1
    const maxFrequency = result?.frequenciesHz.at(-1) ?? 24_000
    const minimumFrequency = frequencyScale === 'log' && maxFrequency > 20 ? 20 : 0
    for (let index = 0; index <= 4; index += 1) {
      const unit = index / 4
      const y = PLOT_MARGIN.top + (1 - unit) * plotHeight
      context.beginPath()
      context.moveTo(PLOT_MARGIN.left, y + 0.5)
      context.lineTo(PLOT_MARGIN.left + plotWidth, y + 0.5)
      context.stroke()
      context.textAlign = 'right'
      context.fillText(
        formatFrequency(unitToFrequency(unit, minimumFrequency, maxFrequency, frequencyScale)),
        PLOT_MARGIN.left - 8,
        y + 3,
      )
    }
    const firstTime = result?.timesSeconds[0] ?? 0
    const lastTime = result?.timesSeconds.at(-1) ?? 0
    for (let index = 0; index <= 4; index += 1) {
      const unit = index / 4
      const x = PLOT_MARGIN.left + unit * plotWidth
      const time = firstTime + unit * (lastTime - firstTime)
      context.textAlign = 'center'
      context.fillText(`${time.toFixed(1)}s`, x, size.height - 10)
    }
  }, [bitmap, currentTime, frequencyScale, result, size])

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!result) return setHover(null)
    const rect = event.currentTarget.getBoundingClientRect()
    const plotWidth = rect.width - PLOT_MARGIN.left - PLOT_MARGIN.right
    const plotHeight = rect.height - PLOT_MARGIN.top - PLOT_MARGIN.bottom
    const localX = event.clientX - rect.left - PLOT_MARGIN.left
    const localY = event.clientY - rect.top - PLOT_MARGIN.top
    if (localX < 0 || localY < 0 || localX > plotWidth || localY > plotHeight) {
      return setHover(null)
    }
    const frame = Math.max(0, Math.min(result.frameCount - 1, Math.round((localX / plotWidth) * (result.frameCount - 1))))
    const maxFrequency = result.frequenciesHz.at(-1) ?? result.sampleRate / 2
    const minimumFrequency = frequencyScale === 'log' && maxFrequency > 20 ? 20 : 0
    const frequency = unitToFrequency(
      1 - localY / plotHeight,
      minimumFrequency,
      maxFrequency,
      frequencyScale,
    )
    const bin = Math.max(0, Math.min(result.binCount - 1, Math.round(frequency * result.fftSize / result.sampleRate)))
    setHover({
      x: localX + PLOT_MARGIN.left,
      y: localY + PLOT_MARGIN.top,
      time: result.timesSeconds[frame] ?? 0,
      frequency: result.frequenciesHz[bin] ?? frequency,
      db: result.valuesDbfs[frame * result.binCount + bin] ?? minDb,
    })
  }

  return (
    <div ref={hostRef} className="plot-host">
      <canvas
        ref={canvasRef}
        aria-label="二维声谱图"
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHover(null)}
      />
      {hover && (
        <div className="plot-tooltip" style={{ left: hover.x + 12, top: hover.y + 10 }}>
          <strong>{hover.time.toFixed(3)} s · {formatFrequency(hover.frequency)} Hz</strong>
          <span>{hover.db.toFixed(1)} dBFS</span>
        </div>
      )}
    </div>
  )
}
