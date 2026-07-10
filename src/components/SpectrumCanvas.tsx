import { useEffect, useMemo, useRef, useState } from 'react'
import type { StftPreviewResult } from '../audio/analysis'
import { useElementSize } from '../hooks/useElementSize'
import {
  formatFrequency,
  frequencyToUnit,
  nearestFrameIndex,
  PLOT_MARGIN,
  unitToFrequency,
} from '../visualization/plotUtils'
import { spectrumCss } from '../visualization/colorMap'
import {
  findSpectrumReference,
  isRenderableSpectrum,
  sampleSpectrumDb,
  sampleSpectrumSeries,
  type SpectrumComparisonSeries,
} from './spectrumSeries'

export type { SpectrumComparisonSeries } from './spectrumSeries'

interface SpectrumCanvasProps {
  result: StftPreviewResult | null
  comparisonSeries?: readonly SpectrumComparisonSeries[]
  comparisonEnabled?: boolean
  currentTime: number
  minDb: number
  maxDb: number
  frequencyScale: 'linear' | 'log'
  frozen?: boolean
}

interface HoverPoint {
  x: number
  y: number
  frequency: number
}

const EMPTY_COMPARISON_SERIES: readonly SpectrumComparisonSeries[] = []

export function SpectrumCanvas({
  result,
  comparisonSeries = EMPTY_COMPARISON_SERIES,
  comparisonEnabled = false,
  currentTime,
  minDb,
  maxDb,
  frequencyScale,
  frozen = false,
}: SpectrumCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const size = useElementSize(hostRef)
  const [hover, setHover] = useState<HoverPoint | null>(null)
  const comparisonReference = useMemo(
    () => comparisonEnabled ? findSpectrumReference(comparisonSeries) : null,
    [comparisonEnabled, comparisonSeries],
  )
  const activeResult = comparisonEnabled ? comparisonReference : result
  const frameIndex = useMemo(() => {
    if (!activeResult) return 0
    return nearestFrameIndex(activeResult, currentTime)
  }, [activeResult, currentTime])

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

    context.strokeStyle = 'rgba(145, 165, 190, 0.12)'
    context.fillStyle = '#8290a3'
    context.font = '10px Inter, system-ui, sans-serif'
    context.lineWidth = 1
    for (let index = 0; index <= 4; index += 1) {
      const y = PLOT_MARGIN.top + (plotHeight * index) / 4
      const db = maxDb - ((maxDb - minDb) * index) / 4
      context.beginPath()
      context.moveTo(PLOT_MARGIN.left, y + 0.5)
      context.lineTo(PLOT_MARGIN.left + plotWidth, y + 0.5)
      context.stroke()
      context.textAlign = 'right'
      context.fillText(`${Math.round(db)}`, PLOT_MARGIN.left - 8, y + 3)
    }

    const maxFrequency = activeResult?.frequenciesHz.at(-1) ??
      result?.frequenciesHz.at(-1) ??
      24_000
    const minFrequency = frequencyScale === 'log' ? Math.min(20, maxFrequency) : 0
    for (let index = 0; index <= 5; index += 1) {
      const unit = index / 5
      const x = PLOT_MARGIN.left + unit * plotWidth
      const frequency = unitToFrequency(unit, minFrequency, maxFrequency, frequencyScale)
      context.beginPath()
      context.moveTo(x + 0.5, PLOT_MARGIN.top)
      context.lineTo(x + 0.5, PLOT_MARGIN.top + plotHeight)
      context.stroke()
      context.textAlign = 'center'
      context.fillText(formatFrequency(frequency), x, size.height - 10)
    }

    const emptyMessage = comparisonEnabled
      ? comparisonSeries.length === 0
        ? '暂无可对比频谱，请显示声道或等待分析完成'
        : comparisonReference === null
          ? '所选声道暂无可用频谱数据'
          : null
      : !isRenderableSpectrum(result)
        ? '导入音频后显示当前播放位置的频谱'
        : null

    if (emptyMessage) {
      context.fillStyle = '#6f7d91'
      context.textAlign = 'center'
      context.font = '12px Inter, system-ui, sans-serif'
      context.fillText(
        emptyMessage,
        PLOT_MARGIN.left + plotWidth / 2,
        PLOT_MARGIN.top + plotHeight / 2,
      )
      return
    }

    const collectPoints = (
      spectrum: StftPreviewResult,
      spectrumFrameIndex: number,
    ): Array<readonly [number, number]> => {
      const offset = spectrumFrameIndex * spectrum.binCount
      const points: Array<readonly [number, number]> = []
      for (let bin = 0; bin < spectrum.binCount; bin += 1) {
        const frequency = spectrum.frequenciesHz[bin] ?? 0
        if (frequency < minFrequency || frequency > maxFrequency) continue
        const db = spectrum.valuesDbfs[offset + bin] ?? minDb
        const x = PLOT_MARGIN.left +
          frequencyToUnit(frequency, minFrequency, maxFrequency, frequencyScale) * plotWidth
        const normalized = Math.max(0, Math.min(1, (db - minDb) / (maxDb - minDb)))
        const y = PLOT_MARGIN.top + (1 - normalized) * plotHeight
        points.push([x, y])
      }
      return points
    }

    const strokePoints = (
      points: readonly (readonly [number, number])[],
      color: string,
      shadowColor: string | null,
    ) => {
      const first = points[0]
      if (!first || points.length < 2) return
      context.beginPath()
      context.moveTo(first[0], first[1])
      for (const point of points.slice(1)) context.lineTo(point[0], point[1])
      context.strokeStyle = color
      context.shadowColor = shadowColor ?? 'transparent'
      context.shadowBlur = shadowColor ? 8 : 0
      context.lineWidth = 1.5
      context.stroke()
      context.shadowBlur = 0
    }

    if (comparisonEnabled) {
      for (const series of comparisonSeries) {
        if (!isRenderableSpectrum(series.result)) continue
        const seriesFrameIndex = nearestFrameIndex(series.result, currentTime)
        strokePoints(
          collectPoints(series.result, seriesFrameIndex),
          series.color,
          null,
        )
      }
    } else if (isRenderableSpectrum(result)) {
      const points = collectPoints(result, frameIndex)
      const first = points[0]
      if (first && points.length > 1) {
        const gradient = context.createLinearGradient(
          0,
          PLOT_MARGIN.top + plotHeight,
          0,
          PLOT_MARGIN.top,
        )
        gradient.addColorStop(0, 'rgba(31, 227, 178, 0.04)')
        gradient.addColorStop(1, 'rgba(31, 227, 178, 0.28)')
        context.beginPath()
        context.moveTo(first[0], PLOT_MARGIN.top + plotHeight)
        context.lineTo(first[0], first[1])
        for (const point of points.slice(1)) context.lineTo(point[0], point[1])
        const last = points.at(-1)
        if (last) context.lineTo(last[0], PLOT_MARGIN.top + plotHeight)
        context.closePath()
        context.fillStyle = gradient
        context.fill()
        strokePoints(points, '#20dfb1', 'rgba(32, 223, 177, 0.5)')
      }
    }

    context.fillStyle = '#8290a3'
    context.textAlign = 'left'
    context.fillText('dBFS', 8, 12)
    context.textAlign = 'right'
    context.fillText(
      `${frozen ? 'FROZEN · ' : ''}${(activeResult?.timesSeconds[frameIndex] ?? 0).toFixed(3)} s`,
      PLOT_MARGIN.left + plotWidth,
      12,
    )
  }, [
    activeResult,
    comparisonEnabled,
    comparisonReference,
    comparisonSeries,
    currentTime,
    frameIndex,
    frequencyScale,
    frozen,
    maxDb,
    minDb,
    result,
    size,
  ])

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isRenderableSpectrum(activeResult)) return setHover(null)
    const rect = event.currentTarget.getBoundingClientRect()
    const plotWidth = rect.width - PLOT_MARGIN.left - PLOT_MARGIN.right
    const plotHeight = rect.height - PLOT_MARGIN.top - PLOT_MARGIN.bottom
    const localX = event.clientX - rect.left - PLOT_MARGIN.left
    const localY = event.clientY - rect.top - PLOT_MARGIN.top
    if (localX < 0 || localY < 0 || localX > plotWidth || localY > plotHeight) {
      return setHover(null)
    }
    const maxFrequency = activeResult.frequenciesHz.at(-1) ?? activeResult.sampleRate / 2
    const minFrequency = frequencyScale === 'log' ? Math.min(20, maxFrequency) : 0
    const frequency = unitToFrequency(localX / plotWidth, minFrequency, maxFrequency, frequencyScale)
    setHover({ x: localX + PLOT_MARGIN.left, y: localY + PLOT_MARGIN.top, frequency })
  }

  const comparisonHoverSamples = hover && comparisonEnabled
    ? sampleSpectrumSeries(comparisonSeries, currentTime, hover.frequency, minDb)
    : []
  const singleHoverDb = hover && !comparisonEnabled && isRenderableSpectrum(result)
    ? sampleSpectrumDb(result, currentTime, hover.frequency, minDb)
    : null

  return (
    <div ref={hostRef} className="plot-host">
      <canvas
        ref={canvasRef}
        aria-label={comparisonEnabled
          ? `实时多声道频谱对比图，${comparisonSeries.length} 个声道`
          : '实时频谱图'}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHover(null)}
      />
      {comparisonEnabled && comparisonSeries.length > 0 && (
        <div className="spectrum-comparison-legend" aria-label="对比声道图例" role="list">
          {comparisonSeries.map((series, index) => (
            <div
              className="spectrum-comparison-legend-item"
              key={`${series.channelIndex}-${index}`}
              role="listitem"
              title={series.label}
            >
              <span
                aria-hidden="true"
                className="spectrum-comparison-swatch"
                style={{ backgroundColor: series.color, color: series.color }}
              />
              <span>{series.label}</span>
            </div>
          ))}
        </div>
      )}
      {hover && (singleHoverDb !== null || comparisonHoverSamples.length > 0) && (
        <div className="plot-tooltip" style={{ left: hover.x + 12, top: hover.y + 10 }}>
          <strong>{formatFrequency(hover.frequency)} Hz</strong>
          {comparisonEnabled
            ? comparisonHoverSamples.map((sample) => (
                <span
                  className="spectrum-comparison-tooltip-row"
                  key={sample.channelIndex}
                >
                  <span
                    aria-hidden="true"
                    className="spectrum-comparison-swatch"
                    style={{ backgroundColor: sample.color, color: sample.color }}
                  />
                  <span className="spectrum-comparison-tooltip-label">{sample.label}</span>
                  <span style={{ color: sample.color }}>{sample.db.toFixed(1)} dBFS</span>
                </span>
              ))
            : singleHoverDb !== null && (
                <span style={{ color: spectrumCss(singleHoverDb, minDb, maxDb) }}>
                  {singleHoverDb.toFixed(1)} dBFS
                </span>
              )}
        </div>
      )}
    </div>
  )
}
