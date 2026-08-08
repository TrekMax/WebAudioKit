import type { CSSProperties } from 'react'
import { Gauge, SlidersHorizontal, Waves } from 'lucide-react'

import {
  FILTER_DEFINITIONS,
  type FilterKind,
} from '../audio/filterGraph'
import {
  FILTER_GUIDE_CHART,
  FILTER_GUIDE_WAVEFORM_CHART,
  FILTER_NODE_GUIDES,
  buildFilterGuideSpectrum,
  buildFilterGuideSpectrumPath,
  buildFilterGuideWaveform,
  buildFilterGuideWaveformPath,
  filterGuideDbToY,
  filterGuideFrequencyToX,
  filterGuideWaveformUnitToX,
  filterGuideWaveformValueToY,
} from './filterNodeGuide'

interface FilterNodeGuidePopoverProps {
  readonly type: FilterKind
  readonly style: CSSProperties
}

const FREQUENCY_TICKS = [20, 1_000, 20_000] as const
const DB_TICKS = [-20, -50, -80] as const
const WAVEFORM_TICKS = [-1, 0, 1] as const

function formatGuideFrequency(frequencyHz: number): string {
  if (frequencyHz >= 1_000) return `${frequencyHz / 1_000}k`
  return `${frequencyHz}`
}

function processingLabel(type: FilterKind): string {
  const kind = FILTER_DEFINITIONS[type].processingKind
  if (kind === 'equalizer') return '7 / 10 / 15-BAND EQ'
  if (kind === 'resampler') return 'AUDIO WORKLET'
  return 'BIQUAD FILTER'
}

export function FilterNodeGlyph({ type, size = 14 }: { readonly type: FilterKind; readonly size?: number }) {
  if (type === 'resampler') return <Gauge size={size} />
  if (type === 'equalizer') return <SlidersHorizontal size={size} />
  return <Waves size={size} />
}

export function FilterNodeGuidePopover({ type, style }: FilterNodeGuidePopoverProps) {
  const definition = FILTER_DEFINITIONS[type]
  const guide = FILTER_NODE_GUIDES[type]
  const spectrumPoints = guide.visualKind === 'spectrum'
    ? buildFilterGuideSpectrum(type)
    : []
  const beforePath = buildFilterGuideSpectrumPath(spectrumPoints, 'beforeDb')
  const afterPath = buildFilterGuideSpectrumPath(spectrumPoints, 'afterDb')
  const plotRight = FILTER_GUIDE_CHART.width - FILTER_GUIDE_CHART.right
  const plotBottom = FILTER_GUIDE_CHART.height - FILTER_GUIDE_CHART.bottom
  const waveformPoints = guide.visualKind === 'waveform'
    ? buildFilterGuideWaveform(type as Extract<FilterKind, 'allpass' | 'resampler'>)
    : []
  const waveformBeforePath = buildFilterGuideWaveformPath(waveformPoints, 'before')
  const waveformAfterPath = buildFilterGuideWaveformPath(
    waveformPoints,
    'after',
    type === 'resampler',
  )
  const gradientId = `filter-guide-fill-${type}`

  return (
    <aside
      id={`filter-node-guide-${type}`}
      className="filter-node-guide-popover panel-surface"
      role="tooltip"
      style={style}
    >
      <header>
        <span className="filter-guide-icon"><FilterNodeGlyph type={type} size={16} /></span>
        <span><strong>{definition.label}</strong><small>{processingLabel(type)}</small></span>
        <span className="filter-guide-badge">节点说明</span>
      </header>

      <p className="filter-guide-introduction">{guide.introduction}</p>

      <figure className="filter-guide-spectrum">
        <div className="filter-guide-figure-heading">
          <strong>{guide.visualKind === 'spectrum' ? '前后处理二维频谱' : '前后处理波形'}</strong>
          <span>示意 · 非当前音频</span>
        </div>
        {guide.visualKind === 'spectrum' ? <svg
          viewBox={`0 0 ${FILTER_GUIDE_CHART.width} ${FILTER_GUIDE_CHART.height}`}
          role="img"
          aria-label={`${definition.label}处理前后频率与 dBFS 对比示意图`}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#1fdfb2" stopOpacity="0.18" />
              <stop offset="1" stopColor="#1fdfb2" stopOpacity="0" />
            </linearGradient>
          </defs>
          <rect
            className="filter-guide-plot"
            x={FILTER_GUIDE_CHART.left}
            y={FILTER_GUIDE_CHART.top}
            width={plotRight - FILTER_GUIDE_CHART.left}
            height={plotBottom - FILTER_GUIDE_CHART.top}
          />
          {DB_TICKS.map((valueDb) => {
            const y = filterGuideDbToY(valueDb)
            return (
              <g className="filter-guide-grid" key={valueDb}>
                <line x1={FILTER_GUIDE_CHART.left} x2={plotRight} y1={y} y2={y} />
                <text x={FILTER_GUIDE_CHART.left - 5} y={y}>{valueDb}</text>
              </g>
            )
          })}
          {FREQUENCY_TICKS.map((frequencyHz) => {
            const x = filterGuideFrequencyToX(frequencyHz)
            return (
              <g className="filter-guide-grid" key={frequencyHz}>
                <line x1={x} x2={x} y1={FILTER_GUIDE_CHART.top} y2={plotBottom} />
                <text className="frequency" x={x} y={plotBottom + 14}>{formatGuideFrequency(frequencyHz)}</text>
              </g>
            )
          })}
          <text className="filter-guide-axis-unit" x="4" y="9">dBFS</text>
          <text className="filter-guide-axis-unit frequency" x={plotRight} y={FILTER_GUIDE_CHART.height - 2}>Hz</text>
          <path
            className="filter-guide-after-area"
            d={`${afterPath} L ${plotRight} ${plotBottom} L ${FILTER_GUIDE_CHART.left} ${plotBottom} Z`}
            fill={`url(#${gradientId})`}
          />
          <path className="filter-guide-before-line" d={beforePath} />
          <path className="filter-guide-after-line" d={afterPath} />
        </svg> : <svg
          viewBox={`0 0 ${FILTER_GUIDE_WAVEFORM_CHART.width} ${FILTER_GUIDE_WAVEFORM_CHART.height}`}
          role="img"
          aria-label={`${definition.label}处理前后时间与归一化幅度波形对比示意图`}
        >
          <rect
            className="filter-guide-plot"
            x={FILTER_GUIDE_WAVEFORM_CHART.left}
            y={FILTER_GUIDE_WAVEFORM_CHART.top}
            width={FILTER_GUIDE_WAVEFORM_CHART.width - FILTER_GUIDE_WAVEFORM_CHART.left - FILTER_GUIDE_WAVEFORM_CHART.right}
            height={FILTER_GUIDE_WAVEFORM_CHART.height - FILTER_GUIDE_WAVEFORM_CHART.top - FILTER_GUIDE_WAVEFORM_CHART.bottom}
          />
          {WAVEFORM_TICKS.map((value) => {
            const y = filterGuideWaveformValueToY(value)
            return (
              <g className="filter-guide-grid" key={value}>
                <line x1={FILTER_GUIDE_WAVEFORM_CHART.left} x2={FILTER_GUIDE_WAVEFORM_CHART.width - FILTER_GUIDE_WAVEFORM_CHART.right} y1={y} y2={y} />
                <text x={FILTER_GUIDE_WAVEFORM_CHART.left - 5} y={y}>{value > 0 ? `+${value}` : value}</text>
              </g>
            )
          })}
          {[0, 0.25, 0.5, 0.75, 1].map((unit) => {
            const x = filterGuideWaveformUnitToX(unit)
            return <line className="filter-guide-time-grid" key={unit} x1={x} x2={x} y1={FILTER_GUIDE_WAVEFORM_CHART.top} y2={FILTER_GUIDE_WAVEFORM_CHART.height - FILTER_GUIDE_WAVEFORM_CHART.bottom} />
          })}
          <text className="filter-guide-axis-unit" x="4" y="9">幅度</text>
          <text className="filter-guide-axis-unit frequency" x={FILTER_GUIDE_WAVEFORM_CHART.width - FILTER_GUIDE_WAVEFORM_CHART.right} y={FILTER_GUIDE_WAVEFORM_CHART.height - 2}>时间</text>
          <path className="filter-guide-before-line" d={waveformBeforePath} />
          <path className="filter-guide-after-line" d={waveformAfterPath} />
        </svg>}
        <div className="filter-guide-legend" aria-hidden="true">
          <span><i className="before" />处理前</span>
          <span><i className="after" />处理后</span>
          <span className="overlap">{guide.visualKind === 'spectrum' ? '频率 / dBFS' : '时间 / 幅度'}</span>
        </div>
        <figcaption>{guide.visualSummary}</figcaption>
      </figure>

      <p className="filter-guide-parameters"><strong>参数提示</strong>{guide.parameterSummary}</p>
    </aside>
  )
}
