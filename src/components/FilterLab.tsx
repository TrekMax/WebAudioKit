import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  AudioWaveform,
  Cable,
  CheckCircle2,
  Gauge,
  Power,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
  Volume2,
  Waves,
  X,
} from 'lucide-react'

import {
  FILTER_DEFINITIONS,
  MAX_FILTER_NODES,
  createFilterNodeConfig,
  type FilterAuditionMode,
  type FilterKind,
  type FilterNodeConfig,
} from '../audio/filterGraph'
import type { StftPreviewResult } from '../audio/analysis'
import { FilterTrackPreview } from './FilterTrackPreview'
import {
  calculateFloatingInspectorPosition,
  type FloatingInspectorPosition,
} from './floatingInspector'

interface FilterLabProps {
  readonly filters: readonly FilterNodeConfig[]
  readonly auditionMode: FilterAuditionMode
  readonly hasAudio: boolean
  readonly buffer: AudioBuffer | null
  readonly currentSample: number
  readonly playing: boolean
  readonly sampleRate: number | null
  readonly spectrum: StftPreviewResult | null
  readonly spectrogram: StftPreviewResult | null
  readonly getFilterFrequencyResponseDb: (frequenciesHz: Float32Array) => Float32Array | null
  readonly onFiltersChange: (filters: readonly FilterNodeConfig[]) => void
  readonly onAuditionModeChange: (mode: FilterAuditionMode) => void
}

const FILTER_TYPES = Object.keys(FILTER_DEFINITIONS) as FilterKind[]
const FLOATING_INSPECTOR_GAP = 12
const FLOATING_INSPECTOR_WIDTH = 300

function createFilterId(): string {
  return `filter-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function formatFrequency(value: number): string {
  return value >= 1_000
    ? `${Number((value / 1_000).toFixed(2))} kHz`
    : `${Math.round(value)} Hz`
}

export function FilterLab({
  filters,
  auditionMode,
  hasAudio,
  buffer,
  currentSample,
  playing,
  sampleRate,
  spectrum,
  spectrogram,
  getFilterFrequencyResponseDb,
  onFiltersChange,
  onAuditionModeChange,
}: FilterLabProps) {
  const gridRef = useRef<HTMLElement>(null)
  const graphPanelRef = useRef<HTMLElement>(null)
  const inspectorRef = useRef<HTMLElement>(null)
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>())
  const [selectedId, setSelectedId] = useState<string | null>(filters[0]?.id ?? null)
  const [inspectorPosition, setInspectorPosition] = useState<FloatingInspectorPosition>({
    left: FLOATING_INSPECTOR_GAP,
    top: 70,
  })
  const effectiveSelectedId = selectedId && filters.some((filter) => filter.id === selectedId)
    ? selectedId
    : null
  const selected = useMemo(
    () => filters.find((filter) => filter.id === effectiveSelectedId) ?? null,
    [effectiveSelectedId, filters],
  )
  const nodeLayoutRevision = filters.map((filter) => filter.id).join('|')
  const activeCount = filters.filter((filter) => filter.enabled).length
  const nyquist = sampleRate ? sampleRate / 2 : 24_000
  const maximumFrequency = Math.min(96_000, Math.max(20, nyquist))
  const referenceSampleRate = sampleRate ?? 48_000
  const resamplingMode = selected?.type === 'resampler'
    ? selected.targetSampleRateHz < referenceSampleRate
      ? '下采样'
      : selected.targetSampleRateHz > referenceSampleRate
        ? '上采样'
        : '等采样率'
    : null

  const updateInspectorPosition = useCallback(() => {
    if (!effectiveSelectedId) return
    const grid = gridRef.current
    const graphPanel = graphPanelRef.current
    const node = nodeRefs.current.get(effectiveSelectedId)
    if (!grid || !graphPanel || !node) return
    const gridRect = grid.getBoundingClientRect()
    const panelRect = graphPanel.getBoundingClientRect()
    const nodeRect = node.getBoundingClientRect()
    const inspectorWidth = inspectorRef.current?.offsetWidth ?? FLOATING_INSPECTOR_WIDTH
    const inspectorHeight = inspectorRef.current?.offsetHeight ?? 420
    const localPosition = calculateFloatingInspectorPosition(
      {
        left: nodeRect.left - panelRect.left,
        right: nodeRect.right - panelRect.left,
        top: nodeRect.top - panelRect.top,
      },
      { width: panelRect.width, height: panelRect.height },
      { width: inspectorWidth, height: inspectorHeight },
      FLOATING_INSPECTOR_GAP,
    )
    const left = panelRect.left - gridRect.left + localPosition.left
    const top = panelRect.top - gridRect.top + localPosition.top
    setInspectorPosition((position) => (
      Math.abs(position.left - left) < 0.5 && Math.abs(position.top - top) < 0.5
        ? position
        : { left, top }
    ))
  }, [effectiveSelectedId])

  useLayoutEffect(() => {
    updateInspectorPosition()
    const frame = window.requestAnimationFrame(updateInspectorPosition)
    return () => window.cancelAnimationFrame(frame)
  }, [nodeLayoutRevision, selected?.type, updateInspectorPosition])

  useEffect(() => {
    window.addEventListener('resize', updateInspectorPosition)
    return () => window.removeEventListener('resize', updateInspectorPosition)
  }, [updateInspectorPosition])

  useEffect(() => {
    if (!selected) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedId(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [selected])

  const addFilter = (type: FilterKind) => {
    if (filters.length >= MAX_FILTER_NODES) return
    const id = createFilterId()
    const created = createFilterNodeConfig(type, id)
    onFiltersChange([
      ...filters,
      { ...created, frequencyHz: Math.min(created.frequencyHz, maximumFrequency) },
    ])
    setSelectedId(id)
  }

  const updateSelected = (patch: Partial<Omit<FilterNodeConfig, 'id'>>) => {
    if (!selected) return
    onFiltersChange(filters.map((filter) => filter.id === selected.id
      ? { ...filter, ...patch }
      : filter))
  }

  const changeType = (type: FilterKind) => {
    if (!selected) return
    const defaults = createFilterNodeConfig(type, selected.id)
    updateSelected({
      ...defaults,
      enabled: selected.enabled,
      frequencyHz: Math.min(defaults.frequencyHz, maximumFrequency),
    })
  }

  const removeSelected = () => {
    if (!selected) return
    const index = filters.findIndex((filter) => filter.id === selected.id)
    const next = filters.filter((filter) => filter.id !== selected.id)
    onFiltersChange(next)
    setSelectedId(next[Math.min(index, next.length - 1)]?.id ?? null)
  }

  const moveSelected = (direction: -1 | 1) => {
    if (!selected) return
    const index = filters.findIndex((filter) => filter.id === selected.id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= filters.length) return
    const next = [...filters]
    const [moved] = next.splice(index, 1)
    if (!moved) return
    next.splice(target, 0, moved)
    onFiltersChange(next)
  }

  return (
    <main className="filter-lab-page">
      <header className="filter-lab-header panel-surface">
        <div>
          <span className="eyebrow">NON-DESTRUCTIVE AUDITION</span>
          <h1><SlidersHorizontal size={18} /> 音频选项与节点编译器</h1>
          <p>串行编译 Web Audio 滤波与采样率节点；试听链不会修改源 PCM、分析结果或导出内容。</p>
        </div>
        <div className="filter-compile-status" aria-live="polite">
          <CheckCircle2 size={15} />
          <span><strong>{hasAudio ? '图已编译' : '配置已就绪'}</strong><small>{activeCount} 个活动节点 · {filters.length - activeCount} 个旁路</small></span>
        </div>
      </header>

      <section className="filter-lab-grid" ref={gridRef}>
        <aside className="filter-palette panel-surface" aria-label="音频处理节点库">
          <div className="filter-pane-heading">
            <span className="eyebrow">NODE LIBRARY</span>
            <h2>处理节点</h2>
          </div>
          <div className="filter-palette-list">
            {FILTER_TYPES.map((type) => {
              const definition = FILTER_DEFINITIONS[type]
              return (
                <button
                  key={type}
                  type="button"
                  disabled={filters.length >= MAX_FILTER_NODES}
                  onClick={() => addFilter(type)}
                >
                  <span className="filter-palette-icon">{type === 'resampler' ? <Gauge size={14} /> : <Waves size={14} />}</span>
                  <span><strong>{definition.label}</strong><small>{definition.description}</small></span>
                  <span className="filter-add-mark">+</span>
                </button>
              )
            })}
          </div>
          <p className="filter-pane-note">最多 {MAX_FILTER_NODES} 个节点。信号按画布中的顺序从左到右处理。</p>
        </aside>

        <section className="filter-graph-panel panel-surface" ref={graphPanelRef}>
          <div className="filter-graph-toolbar">
            <div>
              <span className="eyebrow">SERIAL SIGNAL GRAPH</span>
              <h2>节点画布</h2>
            </div>
            <button
              type="button"
              className="secondary-button"
              disabled={filters.length === 0}
              onClick={() => { onFiltersChange([]); setSelectedId(null) }}
            ><RotateCcw size={13} /> 清空链路</button>
          </div>

          <div
            className="filter-graph-canvas"
            aria-label="串行滤波节点图"
            onScroll={updateInspectorPosition}
            onClick={(event) => {
              if (!(event.target as Element).closest('.filter-node')) setSelectedId(null)
            }}
          >
            <div className="signal-terminal input"><AudioWaveform size={18} /><strong>输入</strong><small>原始 PCM</small></div>
            <span className="signal-connector"><Cable size={15} /></span>
            {filters.map((filter, index) => {
              const definition = FILTER_DEFINITIONS[filter.type]
              return (
                <div className="filter-node-wrap" key={filter.id}>
                  <button
                    ref={(node) => {
                      if (node) nodeRefs.current.set(filter.id, node)
                      else nodeRefs.current.delete(filter.id)
                    }}
                    type="button"
                    className={`filter-node ${effectiveSelectedId === filter.id ? 'selected' : ''} ${filter.enabled ? '' : 'bypassed'}`}
                    aria-pressed={effectiveSelectedId === filter.id}
                    aria-expanded={effectiveSelectedId === filter.id}
                    aria-controls={effectiveSelectedId === filter.id ? 'floating-node-inspector' : undefined}
                    onClick={() => setSelectedId(filter.id)}
                  >
                    <span className="filter-node-index">{String(index + 1).padStart(2, '0')}</span>
                    <span className="filter-node-type">{definition.label}</span>
                    <strong>{formatFrequency(filter.type === 'resampler' ? filter.targetSampleRateHz : filter.frequencyHz)}</strong>
                    <small>{filter.enabled ? 'ACTIVE' : 'BYPASS'}</small>
                  </button>
                  <span className="signal-connector"><Cable size={15} /></span>
                </div>
              )
            })}
            <div className="signal-terminal output"><Volume2 size={18} /><strong>输出</strong><small>监听总线</small></div>
            {filters.length === 0 && (
              <div className="filter-graph-empty">
                <SlidersHorizontal size={25} />
                <strong>从左侧添加第一个处理节点</strong>
                <span>节点会自动串联，并可在播放过程中重新编译。</span>
              </div>
            )}
          </div>

          <FilterTrackPreview
            buffer={buffer}
            currentSample={currentSample}
            filters={filters}
            auditionMode={auditionMode}
            playing={playing}
            spectrum={spectrum}
            spectrogram={spectrogram}
            getFilterFrequencyResponseDb={getFilterFrequencyResponseDb}
            onAuditionModeChange={onAuditionModeChange}
          />
        </section>

        <aside
          id="floating-node-inspector"
          ref={inspectorRef}
          role="dialog"
          aria-modal="false"
          aria-label="节点参数悬浮面板"
          className={`filter-inspector floating panel-surface ${selected ? 'open' : ''}`}
          style={{ left: inspectorPosition.left, top: inspectorPosition.top }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setSelectedId(null)
          }}
        >
          <div className="filter-pane-heading">
            <div>
              <span className="eyebrow">NODE OPTIONS</span>
              <h2>节点参数</h2>
            </div>
            <button type="button" className="floating-inspector-close" aria-label="关闭节点参数" onClick={() => setSelectedId(null)}><X size={14} /></button>
          </div>
          {selected ? (
            <div className="filter-inspector-form">
              <div className="filter-selected-summary">
                <span className="filter-palette-icon"><SlidersHorizontal size={15} /></span>
                <span><strong>{FILTER_DEFINITIONS[selected.type].label}</strong><small>{FILTER_DEFINITIONS[selected.type].description}</small></span>
              </div>

              <label className="filter-field">
                <span>节点类型</span>
                <select value={selected.type} onChange={(event) => changeType(event.target.value as FilterKind)}>
                  {FILTER_TYPES.map((type) => <option key={type} value={type}>{FILTER_DEFINITIONS[type].label}</option>)}
                </select>
              </label>

              {selected.type === 'resampler' ? (
                <>
                  <div className="resampler-mode-card">
                    <Gauge size={16} />
                    <span><strong>{resamplingMode}</strong><small>源 {formatFrequency(referenceSampleRate)} → 目标 {formatFrequency(selected.targetSampleRateHz)}</small></span>
                  </div>
                  <label className="filter-field filter-slider-field">
                    <span>目标采样率 <output>{formatFrequency(selected.targetSampleRateHz)}</output></span>
                    <input type="range" min={3_000} max={192_000} step={1_000} value={selected.targetSampleRateHz} onChange={(event) => updateSelected({ targetSampleRateHz: Number(event.target.value) })} />
                    <span className="filter-number-input"><input type="number" min={3_000} max={192_000} step={100} value={selected.targetSampleRateHz} onChange={(event) => updateSelected({ targetSampleRateHz: clamp(Number(event.target.value), 3_000, 192_000) })} /><small>Hz</small></span>
                  </label>
                  <div className="resampler-presets" aria-label="常用目标采样率">
                    {[8_000, 16_000, 24_000, 44_100, 48_000, 96_000].map((rate) => (
                      <button key={rate} type="button" className={selected.targetSampleRateHz === rate ? 'active' : ''} onClick={() => updateSelected({ targetSampleRateHz: rate })}>{rate >= 1_000 ? `${rate / 1_000}k` : rate}</button>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <label className="filter-field filter-slider-field">
                    <span>频率 <output>{formatFrequency(selected.frequencyHz)}</output></span>
                    <input type="range" min={20} max={maximumFrequency} step={1} value={clamp(selected.frequencyHz, 20, maximumFrequency)} onChange={(event) => updateSelected({ frequencyHz: Number(event.target.value) })} />
                    <span className="filter-number-input"><input type="number" min={1} max={maximumFrequency} step={1} value={selected.frequencyHz} onChange={(event) => updateSelected({ frequencyHz: clamp(Number(event.target.value), 1, maximumFrequency) })} /><small>Hz</small></span>
                  </label>

                  <label className={`filter-field filter-slider-field ${FILTER_DEFINITIONS[selected.type].usesQ ? '' : 'inactive'}`}>
                    <span>Q 值 <output>{selected.q.toFixed(2)}</output></span>
                    <input type="range" min={0.1} max={20} step={0.1} disabled={!FILTER_DEFINITIONS[selected.type].usesQ} value={clamp(selected.q, 0.1, 20)} onChange={(event) => updateSelected({ q: Number(event.target.value) })} />
                    <span className="filter-number-input"><input type="number" min={0.01} max={1000} step={0.1} disabled={!FILTER_DEFINITIONS[selected.type].usesQ} value={selected.q} onChange={(event) => updateSelected({ q: clamp(Number(event.target.value), 0.01, 1_000) })} /><small>Q</small></span>
                  </label>

                  <label className={`filter-field filter-slider-field ${FILTER_DEFINITIONS[selected.type].usesGain ? '' : 'inactive'}`}>
                    <span>增益 <output>{selected.gainDb > 0 ? '+' : ''}{selected.gainDb.toFixed(1)} dB</output></span>
                    <input type="range" min={-24} max={24} step={0.5} disabled={!FILTER_DEFINITIONS[selected.type].usesGain} value={clamp(selected.gainDb, -24, 24)} onChange={(event) => updateSelected({ gainDb: Number(event.target.value) })} />
                    <span className="filter-number-input"><input type="number" min={-40} max={40} step={0.5} disabled={!FILTER_DEFINITIONS[selected.type].usesGain} value={selected.gainDb} onChange={(event) => updateSelected({ gainDb: clamp(Number(event.target.value), -40, 40) })} /><small>dB</small></span>
                  </label>
                </>
              )}

              <button type="button" className={`filter-bypass-button ${selected.enabled ? '' : 'active'}`} onClick={() => updateSelected({ enabled: !selected.enabled })}>
                <Power size={14} />
                <span><strong>{selected.enabled ? '节点已启用' : '节点已旁路'}</strong><small>旁路后重新编译，其余节点保持连接</small></span>
              </button>

              <div className="filter-node-actions">
                <button type="button" className="secondary-button" disabled={filters[0]?.id === selected.id} onClick={() => moveSelected(-1)}><ArrowLeft size={13} /> 前移</button>
                <button type="button" className="secondary-button" disabled={filters.at(-1)?.id === selected.id} onClick={() => moveSelected(1)}>后移 <ArrowRight size={13} /></button>
                <button type="button" className="secondary-button danger" onClick={removeSelected}><Trash2 size={13} /> 删除</button>
              </div>

              <p className="filter-runtime-note">{selected.type === 'resampler' ? '下采样使用实时抗混叠与抽取；上采样由 Web Audio 上下文完成插值，超过输出上下文的采样率不会生成新的频率信息。不支持 AudioWorklet 时节点透明旁路。' : `当前 Nyquist：${formatFrequency(nyquist)}。超出当前设备范围的频率会由 Web Audio 安全钳位。`}</p>
            </div>
          ) : (
            <div className="filter-inspector-empty"><SlidersHorizontal size={24} /><strong>未选择节点</strong><span>添加或点击画布中的节点以编辑参数。</span></div>
          )}
        </aside>
      </section>
    </main>
  )
}
