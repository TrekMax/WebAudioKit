import { useMemo, useRef, useState } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react'

import {
  EQ_BAND_COUNTS,
  EQ_GAIN_MAX_DB,
  EQ_GAIN_MIN_DB,
  getEqBandPreset,
  type EqBandCount,
} from '../audio/filterGraph'
import {
  EQ_CURVE_VIEWBOX,
  buildEqCurvePath,
  buildEqCurvePoints,
  eqGainToY,
  eqYToGain,
} from './eqCurve'

interface EqCurveEditorProps {
  readonly bandCount: EqBandCount
  readonly gainsDb: readonly number[]
  readonly onBandCountChange: (bandCount: EqBandCount) => void
  readonly onChange: (gainsDb: readonly number[]) => void
}

interface EqDragSession {
  readonly pointerId: number
  readonly bandIndex: number
}

const GAIN_GRID_DB = [24, 12, 0, -12, -24] as const

function formatBandFrequency(frequencyHz: number): string {
  return frequencyHz >= 1_000
    ? `${Number((frequencyHz / 1_000).toFixed(1))}k`
    : `${frequencyHz}`
}

function formatGain(gainDb: number): string {
  return `${gainDb > 0 ? '+' : ''}${gainDb.toFixed(1)} dB`
}

function findClosestBandIndex(frequenciesHz: readonly number[], targetFrequencyHz: number): number {
  let closestIndex = 0
  let closestDistance = Number.POSITIVE_INFINITY
  frequenciesHz.forEach((frequencyHz, index) => {
    const distance = Math.abs(Math.log(frequencyHz) - Math.log(targetFrequencyHz))
    if (distance < closestDistance) {
      closestIndex = index
      closestDistance = distance
    }
  })
  return closestIndex
}

export function EqCurveEditor({
  bandCount,
  gainsDb,
  onBandCountChange,
  onChange,
}: EqCurveEditorProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const dragSessionRef = useRef<EqDragSession | null>(null)
  const [selectedFrequencyHz, setSelectedFrequencyHz] = useState(1_000)
  const frequenciesHz = getEqBandPreset(bandCount).frequenciesHz
  const selectedBandIndex = findClosestBandIndex(frequenciesHz, selectedFrequencyHz)
  const points = useMemo(
    () => buildEqCurvePoints(gainsDb, bandCount),
    [bandCount, gainsDb],
  )
  const curvePath = useMemo(() => buildEqCurvePath(points), [points])
  const selectedFrequency = frequenciesHz[selectedBandIndex] ?? 1_000
  const selectedGain = gainsDb[selectedBandIndex] ?? 0
  const plotRight = EQ_CURVE_VIEWBOX.width - EQ_CURVE_VIEWBOX.right
  const plotBottom = EQ_CURVE_VIEWBOX.height - EQ_CURVE_VIEWBOX.bottom

  const updateBand = (bandIndex: number, gainDb: number) => {
    const next = frequenciesHz.map((_, index) => (
      index === bandIndex
        ? Math.min(EQ_GAIN_MAX_DB, Math.max(EQ_GAIN_MIN_DB, gainDb))
        : gainsDb[index] ?? 0
    ))
    onChange(next)
  }

  const updateBandFromPointer = (bandIndex: number, clientY: number) => {
    const svg = svgRef.current
    if (!svg) return
    const rect = svg.getBoundingClientRect()
    if (rect.height <= 0) return
    const viewBoxY = ((clientY - rect.top) / rect.height) * EQ_CURVE_VIEWBOX.height
    updateBand(bandIndex, eqYToGain(viewBoxY))
  }

  const startDrag = (event: ReactPointerEvent<SVGCircleElement>, bandIndex: number) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    setSelectedFrequencyHz(frequenciesHz[bandIndex] ?? 1_000)
    dragSessionRef.current = { pointerId: event.pointerId, bandIndex }
    svgRef.current?.setPointerCapture(event.pointerId)
    updateBandFromPointer(bandIndex, event.clientY)
  }

  const moveDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    const session = dragSessionRef.current
    if (!session || session.pointerId !== event.pointerId) return
    event.preventDefault()
    updateBandFromPointer(session.bandIndex, event.clientY)
  }

  const finishDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    const session = dragSessionRef.current
    if (!session || session.pointerId !== event.pointerId) return
    dragSessionRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const handlePointKeyDown = (
    event: ReactKeyboardEvent<SVGCircleElement>,
    bandIndex: number,
  ) => {
    const increments: Partial<Record<string, number>> = {
      ArrowUp: 0.5,
      ArrowDown: -0.5,
      PageUp: 3,
      PageDown: -3,
    }
    const increment = increments[event.key]
    if (increment !== undefined) {
      event.preventDefault()
      setSelectedFrequencyHz(frequenciesHz[bandIndex] ?? 1_000)
      updateBand(bandIndex, (gainsDb[bandIndex] ?? 0) + increment)
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      setSelectedFrequencyHz(frequenciesHz[bandIndex] ?? 1_000)
      updateBand(bandIndex, 0)
    }
  }

  return (
    <div className="eq-curve-editor">
      <div className="eq-band-count-selector" role="group" aria-label="选择 EQ 分段数量">
        {EQ_BAND_COUNTS.map((count) => (
          <button
            key={count}
            type="button"
            className={bandCount === count ? 'active' : ''}
            aria-pressed={bandCount === count}
            onClick={() => onBandCountChange(count)}
          >{count} 段</button>
        ))}
      </div>

      <svg
        ref={svgRef}
        className="eq-curve-canvas"
        viewBox={`0 0 ${EQ_CURVE_VIEWBOX.width} ${EQ_CURVE_VIEWBOX.height}`}
        role="group"
        aria-label={`${bandCount} 段 EQ 曲线，拖动控制点调节增益`}
        onPointerMove={moveDrag}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onLostPointerCapture={finishDrag}
      >
        <defs>
          <linearGradient id="eq-curve-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#1fdfb2" stopOpacity="0.22" />
            <stop offset="1" stopColor="#1fdfb2" stopOpacity="0.01" />
          </linearGradient>
        </defs>
        <rect
          className="eq-curve-plot"
          x={EQ_CURVE_VIEWBOX.left}
          y={EQ_CURVE_VIEWBOX.top}
          width={plotRight - EQ_CURVE_VIEWBOX.left}
          height={plotBottom - EQ_CURVE_VIEWBOX.top}
        />
        {GAIN_GRID_DB.map((gainDb) => {
          const y = eqGainToY(gainDb)
          return (
            <g key={gainDb} className={gainDb === 0 ? 'eq-curve-grid zero' : 'eq-curve-grid'}>
              <line x1={EQ_CURVE_VIEWBOX.left} x2={plotRight} y1={y} y2={y} />
              <text x={EQ_CURVE_VIEWBOX.left - 5} y={y}>{gainDb > 0 ? `+${gainDb}` : gainDb}</text>
            </g>
          )
        })}
        {points.map((point) => (
          <line
            key={point.frequencyHz}
            className="eq-curve-band-grid"
            x1={point.x}
            x2={point.x}
            y1={EQ_CURVE_VIEWBOX.top}
            y2={plotBottom}
          />
        ))}
        <path
          className="eq-curve-area"
          d={`${curvePath} L ${points.at(-1)?.x ?? plotRight} ${eqGainToY(0)} L ${points[0]?.x ?? EQ_CURVE_VIEWBOX.left} ${eqGainToY(0)} Z`}
        />
        <path className="eq-curve-line" d={curvePath} />
        {points.map((point, index) => (
          <circle
            key={point.frequencyHz}
            className={`eq-curve-point ${selectedBandIndex === index ? 'selected' : ''}`}
            cx={point.x}
            cy={point.y}
            r={selectedBandIndex === index ? 5.5 : 4.5}
            role="slider"
            tabIndex={0}
            aria-label={`${formatBandFrequency(point.frequencyHz)}Hz 增益`}
            aria-valuemin={EQ_GAIN_MIN_DB}
            aria-valuemax={EQ_GAIN_MAX_DB}
            aria-valuenow={point.gainDb}
            aria-valuetext={formatGain(point.gainDb)}
            onPointerDown={(event) => startDrag(event, index)}
            onFocus={() => setSelectedFrequencyHz(point.frequencyHz)}
            onKeyDown={(event) => handlePointKeyDown(event, index)}
          />
        ))}
      </svg>

      <div className={`eq-band-selector bands-${bandCount}`} role="group" aria-label="选择 EQ 频段">
        {frequenciesHz.map((frequencyHz, index) => (
          <button
            key={frequencyHz}
            type="button"
            className={selectedBandIndex === index ? 'active' : ''}
            aria-pressed={selectedBandIndex === index}
            onClick={() => setSelectedFrequencyHz(frequencyHz)}
          >{formatBandFrequency(frequencyHz)}</button>
        ))}
      </div>

      <label className="filter-field filter-slider-field eq-selected-band">
        <span>{formatBandFrequency(selectedFrequency)} Hz <output>{formatGain(selectedGain)}</output></span>
        <input
          type="range"
          min={EQ_GAIN_MIN_DB}
          max={EQ_GAIN_MAX_DB}
          step={0.5}
          value={selectedGain}
          onChange={(event) => updateBand(selectedBandIndex, Number(event.target.value))}
        />
        <span className="filter-number-input">
          <input
            type="number"
            min={EQ_GAIN_MIN_DB}
            max={EQ_GAIN_MAX_DB}
            step={0.5}
            value={selectedGain}
            onChange={(event) => updateBand(selectedBandIndex, Number(event.target.value))}
          />
          <small>dB</small>
        </span>
      </label>

      <button
        type="button"
        className="secondary-button eq-reset-button"
        disabled={gainsDb.every((gainDb) => gainDb === 0)}
        onClick={() => onChange(frequenciesHz.map(() => 0))}
      >复位为平直曲线</button>
    </div>
  )
}
