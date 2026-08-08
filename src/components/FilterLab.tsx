import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  AudioWaveform,
  Cable,
  CheckCircle2,
  Gauge,
  GripVertical,
  Power,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
  Volume2,
  X,
} from 'lucide-react'

import {
  FILTER_DEFINITIONS,
  MAX_FILTER_NODES,
  createFilterNodeConfig,
  remapEqGainsDb,
  type FilterAuditionMode,
  type EqBandCount,
  type FilterKind,
  type FilterNodeConfig,
} from '../audio/filterGraph'
import type { StftPreviewResult } from '../audio/analysis'
import { formatTime } from '../visualization/format'
import { FilterTrackPreview } from './FilterTrackPreview'
import {
  FilterNodeGlyph,
  FilterNodeGuidePopover,
} from './FilterNodeGuidePopover'
import { EqCurveEditor } from './EqCurveEditor'
import {
  calculateFloatingInspectorPosition,
  type FloatingInspectorPosition,
} from './floatingInspector'
import {
  calculateConstrainedDragGhostPosition,
  nodeOrdersEqual,
  reorderNodeIds,
} from './filterNodeDrag'

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
  readonly volume: number
  readonly numberOfChannels: number
  readonly outputChannelEnabled: readonly [boolean, boolean]
  readonly outputBalance: number
  readonly inputAudioInfo: {
    readonly name: string
    readonly extension: string | null
    readonly mimeType: string
    readonly sizeBytes: number
    readonly durationSeconds: number
    readonly sampleRate: number
    readonly numberOfChannels: number
    readonly lengthSamples: number
    readonly pcmBytes: number
  } | null
  readonly getFilterFrequencyResponseDb: (frequenciesHz: Float32Array) => Float32Array | null
  readonly onFiltersChange: (filters: readonly FilterNodeConfig[]) => void
  readonly onAuditionModeChange: (mode: FilterAuditionMode) => void
  readonly onSeekSample: (sample: number) => void
  readonly onVolumeChange: (volume: number) => void
  readonly onOutputChannelEnabledChange: (channelIndex: 0 | 1, enabled: boolean) => void
  readonly onOutputBalanceChange: (balance: number) => void
}

const FILTER_TYPES = Object.keys(FILTER_DEFINITIONS) as FilterKind[]
const FLOATING_INSPECTOR_GAP = 12
const FLOATING_INSPECTOR_WIDTH = 300
const PALETTE_GUIDE_WIDTH = 340
const PALETTE_GUIDE_HEIGHT = 430
const DRAG_AUTO_SCROLL_EDGE_PX = 56
const DRAG_AUTO_SCROLL_MAX_STEP_PX = 14

interface FilterNodeDragRuntime {
  readonly draggedId: string
  readonly pointerId: number
  readonly originalOrder: readonly string[]
  readonly captureTarget: HTMLDivElement
  previewOrder: string[]
  pointerX: number
  pointerY: number
}

interface PaletteGuideState extends FloatingInspectorPosition {
  readonly type: FilterKind
}

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

function formatBalance(value: number): string {
  if (Math.abs(value) < 0.005) return '居中'
  return `${value < 0 ? '左' : '右'} ${Math.round(Math.abs(value) * 100)}%`
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1_024 ** 2) return `${(bytes / 1_024).toFixed(1)} KB`
  if (bytes < 1_024 ** 3) return `${(bytes / 1_024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1_024 ** 3).toFixed(2)} GB`
}

function formatChannelCount(numberOfChannels: number): string {
  if (numberOfChannels === 1) return 'Mono · 1 ch'
  if (numberOfChannels === 2) return 'Stereo · 2 ch'
  return `${numberOfChannels} ch`
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
  volume,
  numberOfChannels,
  outputChannelEnabled,
  outputBalance,
  inputAudioInfo,
  getFilterFrequencyResponseDb,
  onFiltersChange,
  onAuditionModeChange,
  onSeekSample,
  onVolumeChange,
  onOutputChannelEnabledChange,
  onOutputBalanceChange,
}: FilterLabProps) {
  const gridRef = useRef<HTMLElement>(null)
  const graphPanelRef = useRef<HTMLElement>(null)
  const graphCanvasRef = useRef<HTMLDivElement>(null)
  const inspectorRef = useRef<HTMLElement>(null)
  const inputTerminalRef = useRef<HTMLButtonElement>(null)
  const inputInfoRef = useRef<HTMLElement>(null)
  const outputTerminalRef = useRef<HTMLDivElement>(null)
  const outputControlsRef = useRef<HTMLElement>(null)
  const paletteButtonRefs = useRef(new Map<FilterKind, HTMLButtonElement>())
  const nodeRefs = useRef(new Map<string, HTMLButtonElement>())
  const nodeDragGhostRef = useRef<HTMLDivElement>(null)
  const nodeDragRuntimeRef = useRef<FilterNodeDragRuntime | null>(null)
  const nodeDragAutoScrollFrameRef = useRef<number | null>(null)
  const suppressedNodeClickRef = useRef<string | null>(null)
  const suppressedNodeClickTimerRef = useRef<number | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(filters[0]?.id ?? null)
  const [inputInfoOpen, setInputInfoOpen] = useState(false)
  const [outputControlsOpen, setOutputControlsOpen] = useState(false)
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null)
  const [dragPreviewOrder, setDragPreviewOrder] = useState<readonly string[] | null>(null)
  const [dragAnnouncement, setDragAnnouncement] = useState('')
  const [paletteGuide, setPaletteGuide] = useState<PaletteGuideState | null>(null)
  const [inspectorPosition, setInspectorPosition] = useState<FloatingInspectorPosition>({
    left: FLOATING_INSPECTOR_GAP,
    top: 70,
  })
  const [outputControlsPosition, setOutputControlsPosition] = useState<FloatingInspectorPosition>({
    left: FLOATING_INSPECTOR_GAP,
    top: 70,
  })
  const [inputInfoPosition, setInputInfoPosition] = useState<FloatingInspectorPosition>({
    left: FLOATING_INSPECTOR_GAP,
    top: 70,
  })
  const displayedFilters = useMemo(() => {
    if (!dragPreviewOrder) return filters
    const filtersById = new Map(filters.map((filter) => [filter.id, filter]))
    const preview = dragPreviewOrder.flatMap((id) => {
      const filter = filtersById.get(id)
      return filter ? [filter] : []
    })
    return preview.length === filters.length ? preview : filters
  }, [dragPreviewOrder, filters])
  const draggedFilter = draggingNodeId
    ? filters.find((filter) => filter.id === draggingNodeId) ?? null
    : null
  const effectiveSelectedId = selectedId && filters.some((filter) => filter.id === selectedId)
    ? selectedId
    : null
  const selected = useMemo(
    () => filters.find((filter) => filter.id === effectiveSelectedId) ?? null,
    [effectiveSelectedId, filters],
  )
  const nodeLayoutRevision = displayedFilters.map((filter) => filter.id).join('|')
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

  const showPaletteGuide = useCallback((type: FilterKind, target: HTMLButtonElement) => {
    const grid = gridRef.current
    if (!grid) return
    const gridRect = grid.getBoundingClientRect()
    const targetRect = target.getBoundingClientRect()
    const position = calculateFloatingInspectorPosition(
      {
        left: targetRect.left - gridRect.left,
        right: targetRect.right - gridRect.left,
        top: targetRect.top - gridRect.top,
      },
      { width: gridRect.width, height: gridRect.height },
      { width: PALETTE_GUIDE_WIDTH, height: PALETTE_GUIDE_HEIGHT },
      FLOATING_INSPECTOR_GAP,
      FLOATING_INSPECTOR_GAP,
    )
    setPaletteGuide({ type, ...position })
  }, [])

  const repositionPaletteGuide = useCallback(() => {
    if (!paletteGuide) return
    const target = paletteButtonRefs.current.get(paletteGuide.type)
    if (target) showPaletteGuide(paletteGuide.type, target)
  }, [paletteGuide, showPaletteGuide])

  const updateInspectorPosition = useCallback(() => {
    if (!effectiveSelectedId || draggingNodeId) return
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
  }, [draggingNodeId, effectiveSelectedId])

  const updateOutputControlsPosition = useCallback(() => {
    if (!outputControlsOpen) return
    const grid = gridRef.current
    const graphPanel = graphPanelRef.current
    const terminal = outputTerminalRef.current
    if (!grid || !graphPanel || !terminal) return
    const gridRect = grid.getBoundingClientRect()
    const panelRect = graphPanel.getBoundingClientRect()
    const terminalRect = terminal.getBoundingClientRect()
    const controlsWidth = outputControlsRef.current?.offsetWidth ?? FLOATING_INSPECTOR_WIDTH
    const controlsHeight = outputControlsRef.current?.offsetHeight ?? 360
    const localPosition = calculateFloatingInspectorPosition(
      {
        left: terminalRect.left - panelRect.left,
        right: terminalRect.right - panelRect.left,
        top: terminalRect.top - panelRect.top,
      },
      { width: panelRect.width, height: panelRect.height },
      { width: controlsWidth, height: controlsHeight },
      FLOATING_INSPECTOR_GAP,
    )
    const left = panelRect.left - gridRect.left + localPosition.left
    const top = panelRect.top - gridRect.top + localPosition.top
    setOutputControlsPosition((position) => (
      Math.abs(position.left - left) < 0.5 && Math.abs(position.top - top) < 0.5
        ? position
        : { left, top }
    ))
  }, [outputControlsOpen])

  const updateInputInfoPosition = useCallback(() => {
    if (!inputInfoOpen) return
    const grid = gridRef.current
    const graphPanel = graphPanelRef.current
    const terminal = inputTerminalRef.current
    if (!grid || !graphPanel || !terminal) return
    const gridRect = grid.getBoundingClientRect()
    const panelRect = graphPanel.getBoundingClientRect()
    const terminalRect = terminal.getBoundingClientRect()
    const infoWidth = inputInfoRef.current?.offsetWidth ?? FLOATING_INSPECTOR_WIDTH
    const infoHeight = inputInfoRef.current?.offsetHeight ?? 360
    const localPosition = calculateFloatingInspectorPosition(
      {
        left: terminalRect.left - panelRect.left,
        right: terminalRect.right - panelRect.left,
        top: terminalRect.top - panelRect.top,
      },
      { width: panelRect.width, height: panelRect.height },
      { width: infoWidth, height: infoHeight },
      FLOATING_INSPECTOR_GAP,
    )
    const left = panelRect.left - gridRect.left + localPosition.left
    const top = panelRect.top - gridRect.top + localPosition.top
    setInputInfoPosition((position) => (
      Math.abs(position.left - left) < 0.5 && Math.abs(position.top - top) < 0.5
        ? position
        : { left, top }
    ))
  }, [inputInfoOpen])

  const applyNodeDragPreview = useCallback((clientX: number) => {
    const runtime = nodeDragRuntimeRef.current
    if (!runtime) return

    const candidateIds = runtime.originalOrder.filter((id) => id !== runtime.draggedId)
    let insertionIndex = candidateIds.length
    for (let index = 0; index < candidateIds.length; index += 1) {
      const candidateId = candidateIds[index]
      const candidate = candidateId ? nodeRefs.current.get(candidateId) : null
      if (!candidate) continue
      const rect = candidate.getBoundingClientRect()
      if (clientX < rect.left + rect.width / 2) {
        insertionIndex = index
        break
      }
    }

    const nextOrder = reorderNodeIds(
      runtime.originalOrder,
      runtime.draggedId,
      insertionIndex,
    )
    if (nodeOrdersEqual(runtime.previewOrder, nextOrder)) return
    runtime.previewOrder = nextOrder
    setDragPreviewOrder(nextOrder)
  }, [])

  const updateNodeDragGhostPosition = useCallback((
    clientX: number,
    clientY: number,
    horizontalDelta = 0,
  ) => {
    const canvas = graphCanvasRef.current
    const ghost = nodeDragGhostRef.current
    if (!canvas || !ghost) return
    const rect = canvas.getBoundingClientRect()
    const ghostWidth = ghost.offsetWidth || 94
    const ghostHeight = ghost.offsetHeight || 96
    const position = calculateConstrainedDragGhostPosition(
      { x: clientX - rect.left, y: clientY - rect.top },
      {
        width: rect.width,
        height: rect.height,
        scrollLeft: canvas.scrollLeft,
        scrollTop: canvas.scrollTop,
      },
      { width: ghostWidth, height: ghostHeight },
    )
    ghost.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`
    ghost.style.setProperty('--drag-tilt', `${clamp(horizontalDelta * 0.24, -4, 4)}deg`)
  }, [])

  const stopNodeDragAutoScroll = useCallback(() => {
    if (nodeDragAutoScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(nodeDragAutoScrollFrameRef.current)
      nodeDragAutoScrollFrameRef.current = null
    }
  }, [])

  const startNodeDragAutoScroll = useCallback(() => {
    stopNodeDragAutoScroll()
    const tick = () => {
      const runtime = nodeDragRuntimeRef.current
      const canvas = graphCanvasRef.current
      if (!runtime || !canvas) {
        nodeDragAutoScrollFrameRef.current = null
        return
      }

      const rect = canvas.getBoundingClientRect()
      let scrollStep = 0
      if (runtime.pointerX < rect.left + DRAG_AUTO_SCROLL_EDGE_PX) {
        const intensity = clamp(
          (rect.left + DRAG_AUTO_SCROLL_EDGE_PX - runtime.pointerX) / DRAG_AUTO_SCROLL_EDGE_PX,
          0,
          1,
        )
        scrollStep = -Math.max(2, intensity * DRAG_AUTO_SCROLL_MAX_STEP_PX)
      } else if (runtime.pointerX > rect.right - DRAG_AUTO_SCROLL_EDGE_PX) {
        const intensity = clamp(
          (runtime.pointerX - (rect.right - DRAG_AUTO_SCROLL_EDGE_PX)) / DRAG_AUTO_SCROLL_EDGE_PX,
          0,
          1,
        )
        scrollStep = Math.max(2, intensity * DRAG_AUTO_SCROLL_MAX_STEP_PX)
      }

      if (scrollStep !== 0) {
        const previousScrollLeft = canvas.scrollLeft
        canvas.scrollLeft += scrollStep
        if (canvas.scrollLeft !== previousScrollLeft) {
          applyNodeDragPreview(runtime.pointerX)
          updateNodeDragGhostPosition(runtime.pointerX, runtime.pointerY)
        }
      }
      nodeDragAutoScrollFrameRef.current = window.requestAnimationFrame(tick)
    }
    nodeDragAutoScrollFrameRef.current = window.requestAnimationFrame(tick)
  }, [applyNodeDragPreview, stopNodeDragAutoScroll, updateNodeDragGhostPosition])

  const finishNodeDrag = useCallback((commit: boolean) => {
    const runtime = nodeDragRuntimeRef.current
    if (!runtime) return

    stopNodeDragAutoScroll()
    nodeDragRuntimeRef.current = null
    try {
      if (runtime.captureTarget.hasPointerCapture(runtime.pointerId)) {
        runtime.captureTarget.releasePointerCapture(runtime.pointerId)
      }
    } catch {
      // The capture target may already have been released by pointercancel.
    }

    setDraggingNodeId(null)
    setDragPreviewOrder(null)
    if (commit && !nodeOrdersEqual(runtime.originalOrder, runtime.previewOrder)) {
      const filtersById = new Map(filters.map((filter) => [filter.id, filter]))
      const nextFilters = runtime.previewOrder.flatMap((id) => {
        const filter = filtersById.get(id)
        return filter ? [filter] : []
      })
      if (nextFilters.length === filters.length) {
        onFiltersChange(nextFilters)
        const finalIndex = runtime.previewOrder.indexOf(runtime.draggedId)
        const moved = filtersById.get(runtime.draggedId)
        const label = moved ? FILTER_DEFINITIONS[moved.type].label : '节点'
        setDragAnnouncement(`已将${label}移动到第 ${finalIndex + 1} 位，共 ${filters.length} 个节点`)
      }
    }

    if (suppressedNodeClickTimerRef.current !== null) {
      window.clearTimeout(suppressedNodeClickTimerRef.current)
    }
    suppressedNodeClickTimerRef.current = window.setTimeout(() => {
      if (suppressedNodeClickRef.current === runtime.draggedId) {
        suppressedNodeClickRef.current = null
      }
      suppressedNodeClickTimerRef.current = null
    }, 0)
  }, [filters, onFiltersChange, stopNodeDragAutoScroll])

  const startNodeDrag = useCallback((
    event: ReactPointerEvent<HTMLSpanElement>,
    draggedId: string,
  ) => {
    const canvas = graphCanvasRef.current
    if (!canvas || event.button !== 0 || filters.length < 2 || nodeDragRuntimeRef.current) return
    event.preventDefault()
    event.stopPropagation()

    const originalOrder = filters.map((filter) => filter.id)
    canvas.setPointerCapture(event.pointerId)
    nodeDragRuntimeRef.current = {
      draggedId,
      pointerId: event.pointerId,
      originalOrder,
      previewOrder: [...originalOrder],
      pointerX: event.clientX,
      pointerY: event.clientY,
      captureTarget: canvas,
    }
    suppressedNodeClickRef.current = draggedId
    setSelectedId(null)
    setInputInfoOpen(false)
    setOutputControlsOpen(false)
    setDraggingNodeId(draggedId)
    setDragPreviewOrder(originalOrder)
    setDragAnnouncement('')
    startNodeDragAutoScroll()
  }, [filters, startNodeDragAutoScroll])

  const moveNodeDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const runtime = nodeDragRuntimeRef.current
    if (!runtime || runtime.pointerId !== event.pointerId) return
    event.preventDefault()
    const horizontalDelta = event.clientX - runtime.pointerX
    runtime.pointerX = event.clientX
    runtime.pointerY = event.clientY
    updateNodeDragGhostPosition(event.clientX, event.clientY, horizontalDelta)
    applyNodeDragPreview(event.clientX)
  }, [applyNodeDragPreview, updateNodeDragGhostPosition])

  const dropNodeDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const runtime = nodeDragRuntimeRef.current
    if (!runtime || runtime.pointerId !== event.pointerId) return
    event.preventDefault()
    runtime.pointerX = event.clientX
    runtime.pointerY = event.clientY
    updateNodeDragGhostPosition(event.clientX, event.clientY)
    applyNodeDragPreview(event.clientX)
    finishNodeDrag(true)
  }, [applyNodeDragPreview, finishNodeDrag, updateNodeDragGhostPosition])

  const cancelNodeDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const runtime = nodeDragRuntimeRef.current
    if (!runtime || runtime.pointerId !== event.pointerId) return
    finishNodeDrag(false)
  }, [finishNodeDrag])

  useLayoutEffect(() => {
    const runtime = nodeDragRuntimeRef.current
    if (draggingNodeId && runtime) {
      updateNodeDragGhostPosition(runtime.pointerX, runtime.pointerY)
    }
  }, [draggingNodeId, updateNodeDragGhostPosition])

  useLayoutEffect(() => {
    updateInspectorPosition()
    const frame = window.requestAnimationFrame(updateInspectorPosition)
    return () => window.cancelAnimationFrame(frame)
  }, [nodeLayoutRevision, selected?.type, updateInspectorPosition])

  useLayoutEffect(() => {
    updateOutputControlsPosition()
    const frame = window.requestAnimationFrame(updateOutputControlsPosition)
    return () => window.cancelAnimationFrame(frame)
  }, [nodeLayoutRevision, updateOutputControlsPosition])

  useLayoutEffect(() => {
    updateInputInfoPosition()
    const frame = window.requestAnimationFrame(updateInputInfoPosition)
    return () => window.cancelAnimationFrame(frame)
  }, [inputAudioInfo, nodeLayoutRevision, updateInputInfoPosition])

  useEffect(() => {
    window.addEventListener('resize', updateInspectorPosition)
    return () => window.removeEventListener('resize', updateInspectorPosition)
  }, [updateInspectorPosition])

  useEffect(() => {
    window.addEventListener('resize', updateOutputControlsPosition)
    return () => window.removeEventListener('resize', updateOutputControlsPosition)
  }, [updateOutputControlsPosition])

  useEffect(() => {
    window.addEventListener('resize', updateInputInfoPosition)
    return () => window.removeEventListener('resize', updateInputInfoPosition)
  }, [updateInputInfoPosition])

  useEffect(() => {
    window.addEventListener('resize', repositionPaletteGuide)
    return () => window.removeEventListener('resize', repositionPaletteGuide)
  }, [repositionPaletteGuide])

  useEffect(() => {
    if (!selected && !inputInfoOpen && !outputControlsOpen && !draggingNodeId) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (nodeDragRuntimeRef.current) {
          event.preventDefault()
          finishNodeDrag(false)
        }
        setSelectedId(null)
        setInputInfoOpen(false)
        setOutputControlsOpen(false)
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [draggingNodeId, finishNodeDrag, inputInfoOpen, outputControlsOpen, selected])

  useEffect(() => {
    const runtime = nodeDragRuntimeRef.current
    if (runtime && !nodeOrdersEqual(runtime.originalOrder, filters.map((filter) => filter.id))) {
      finishNodeDrag(false)
    }
  }, [filters, finishNodeDrag])

  useEffect(() => () => {
    stopNodeDragAutoScroll()
    nodeDragRuntimeRef.current = null
    if (suppressedNodeClickTimerRef.current !== null) {
      window.clearTimeout(suppressedNodeClickTimerRef.current)
    }
  }, [stopNodeDragAutoScroll])

  const addFilter = (type: FilterKind) => {
    if (filters.length >= MAX_FILTER_NODES) return
    const id = createFilterId()
    const created = createFilterNodeConfig(type, id)
    onFiltersChange([
      ...filters,
      { ...created, frequencyHz: Math.min(created.frequencyHz, maximumFrequency) },
    ])
    setInputInfoOpen(false)
    setOutputControlsOpen(false)
    setSelectedId(id)
  }

  const updateSelected = (patch: Partial<Omit<FilterNodeConfig, 'id'>>) => {
    if (!selected) return
    onFiltersChange(filters.map((filter) => filter.id === selected.id
      ? { ...filter, ...patch }
      : filter))
  }

  const changeEqBandCount = (eqBandCount: EqBandCount) => {
    if (!selected || selected.type !== 'equalizer' || selected.eqBandCount === eqBandCount) return
    updateSelected({
      eqBandCount,
      eqGainsDb: remapEqGainsDb(selected.eqGainsDb, selected.eqBandCount, eqBandCount),
    })
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
          <p>串行编译 Web Audio 滤波、EQ 与采样率节点；试听链不会修改源 PCM、分析结果或导出内容。</p>
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
          <div className="filter-palette-list" onScroll={repositionPaletteGuide}>
            {FILTER_TYPES.map((type) => {
              const definition = FILTER_DEFINITIONS[type]
              const atNodeLimit = filters.length >= MAX_FILTER_NODES
              const guideOpen = paletteGuide?.type === type
              return (
                <button
                  key={type}
                  ref={(node) => {
                    if (node) paletteButtonRefs.current.set(type, node)
                    else paletteButtonRefs.current.delete(type)
                  }}
                  type="button"
                  aria-disabled={atNodeLimit}
                  aria-describedby={guideOpen ? `filter-node-guide-${type}` : undefined}
                  aria-label={atNodeLimit
                    ? `${definition.label}，已达到 ${MAX_FILTER_NODES} 个节点上限`
                    : `添加${definition.label}节点`}
                  data-guide-open={guideOpen ? 'true' : undefined}
                  onPointerEnter={(event) => showPaletteGuide(type, event.currentTarget)}
                  onPointerLeave={(event) => {
                    if (document.activeElement === event.currentTarget) return
                    setPaletteGuide((current) => current?.type === type ? null : current)
                  }}
                  onFocus={(event) => showPaletteGuide(type, event.currentTarget)}
                  onBlur={(event) => {
                    if (event.currentTarget.matches(':hover')) return
                    setPaletteGuide((current) => current?.type === type ? null : current)
                  }}
                  onClick={() => {
                    if (atNodeLimit) return
                    setPaletteGuide(null)
                    addFilter(type)
                  }}
                >
                  <span className="filter-palette-icon"><FilterNodeGlyph type={type} /></span>
                  <span><strong>{definition.label}</strong><small>{definition.description}</small></span>
                  <span className="filter-add-mark">+</span>
                </button>
              )
            })}
          </div>
          <p className="filter-pane-note">悬停或聚焦节点可查看说明与前后图例。最多 {MAX_FILTER_NODES} 个节点，信号按画布顺序处理。</p>
        </aside>

        {paletteGuide && (
          <FilterNodeGuidePopover
            type={paletteGuide.type}
            style={{ left: paletteGuide.left, top: paletteGuide.top }}
          />
        )}

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
            ref={graphCanvasRef}
            className={`filter-graph-canvas ${draggingNodeId ? 'dragging' : ''}`}
            aria-label="串行滤波节点图"
            onPointerMove={moveNodeDrag}
            onPointerUp={dropNodeDrag}
            onPointerCancel={cancelNodeDrag}
            onLostPointerCapture={(event) => {
              const runtime = nodeDragRuntimeRef.current
              if (runtime?.pointerId === event.pointerId) finishNodeDrag(false)
            }}
            onScroll={() => {
              updateInspectorPosition()
              updateInputInfoPosition()
              updateOutputControlsPosition()
            }}
            onClick={(event) => {
              if (!(event.target as Element).closest('.filter-node, .input-node-trigger, .output-node-control-trigger')) {
                setSelectedId(null)
                setInputInfoOpen(false)
                setOutputControlsOpen(false)
              }
            }}
          >
            <button
              ref={inputTerminalRef}
              type="button"
              className={`signal-terminal input input-node-trigger ${inputInfoOpen ? 'active' : ''}`}
              aria-expanded={inputInfoOpen}
              aria-controls="input-audio-info"
              onClick={(event) => {
                event.stopPropagation()
                setSelectedId(null)
                setOutputControlsOpen(false)
                setInputInfoOpen((open) => !open)
              }}
            >
              <AudioWaveform size={18} />
              <strong>输入</strong>
              <small>原始 PCM</small>
            </button>
            <span className="signal-connector"><Cable size={15} /></span>
            {displayedFilters.map((filter, index) => {
              const definition = FILTER_DEFINITIONS[filter.type]
              return (
                <div className={`filter-node-wrap ${draggingNodeId === filter.id ? 'dragging' : ''}`} key={filter.id}>
                  <button
                    ref={(node) => {
                      if (node) nodeRefs.current.set(filter.id, node)
                      else nodeRefs.current.delete(filter.id)
                    }}
                    type="button"
                    className={`filter-node ${effectiveSelectedId === filter.id ? 'selected' : ''} ${filter.enabled ? '' : 'bypassed'} ${draggingNodeId === filter.id ? 'dragging' : ''}`}
                    aria-pressed={effectiveSelectedId === filter.id}
                    aria-expanded={effectiveSelectedId === filter.id && !draggingNodeId}
                    aria-controls={effectiveSelectedId === filter.id && !draggingNodeId ? 'floating-node-inspector' : undefined}
                    onClick={() => {
                      if (suppressedNodeClickRef.current === filter.id) {
                        suppressedNodeClickRef.current = null
                        return
                      }
                      setInputInfoOpen(false)
                      setOutputControlsOpen(false)
                      setSelectedId(filter.id)
                    }}
                  >
                    <span className="filter-node-index">{String(index + 1).padStart(2, '0')}</span>
                    <span className="filter-node-type">{definition.label}</span>
                    <strong>{filter.type === 'equalizer'
                      ? `${filter.eqBandCount} BAND`
                      : formatFrequency(filter.type === 'resampler' ? filter.targetSampleRateHz : filter.frequencyHz)}</strong>
                    <small>{filter.enabled ? 'ACTIVE' : 'BYPASS'}</small>
                    {displayedFilters.length > 1 && (
                      <span
                        className="filter-node-drag-handle"
                        aria-hidden="true"
                        title="拖动调整节点顺序"
                        onPointerDown={(event) => startNodeDrag(event, filter.id)}
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                        }}
                      >
                        <GripVertical size={13} />
                      </span>
                    )}
                  </button>
                  <span className="signal-connector"><Cable size={15} /></span>
                </div>
              )
            })}
            <div ref={outputTerminalRef} className="signal-terminal output">
              <Volume2 size={18} />
              <strong>输出</strong>
              <small>监听总线</small>
              <button
                type="button"
                className={`output-node-control-trigger ${outputControlsOpen ? 'active' : ''}`}
                aria-label="调节输出节点"
                aria-expanded={outputControlsOpen}
                aria-controls="output-node-controls"
                title="调节输出"
                onClick={(event) => {
                  event.stopPropagation()
                  setSelectedId(null)
                  setInputInfoOpen(false)
                  setOutputControlsOpen((open) => !open)
                }}
              >
                <SlidersHorizontal size={13} />
              </button>
            </div>
            {filters.length === 0 && (
              <div className="filter-graph-empty">
                <SlidersHorizontal size={25} />
                <strong>从左侧添加第一个处理节点</strong>
                <span>节点会自动串联，并可在播放过程中重新编译。</span>
              </div>
            )}
            {draggedFilter && (
              <div ref={nodeDragGhostRef} className="filter-node-drag-ghost" aria-hidden="true">
                <div className={`filter-node filter-node-drag-ghost-card ${draggedFilter.enabled ? '' : 'bypassed'}`}>
                  <span className="filter-node-index">{String(displayedFilters.findIndex((filter) => filter.id === draggedFilter.id) + 1).padStart(2, '0')}</span>
                  <span className="filter-node-type">{FILTER_DEFINITIONS[draggedFilter.type].label}</span>
                  <strong>{formatFrequency(draggedFilter.type === 'resampler' ? draggedFilter.targetSampleRateHz : draggedFilter.frequencyHz)}</strong>
                  <small>{draggedFilter.enabled ? 'ACTIVE' : 'BYPASS'}</small>
                </div>
              </div>
            )}
            <span className="visually-hidden" aria-live="polite">{dragAnnouncement}</span>
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
            onSeekSample={onSeekSample}
          />
        </section>

        <aside
          id="floating-node-inspector"
          ref={inspectorRef}
          role="dialog"
          aria-modal="false"
          aria-label="节点参数悬浮面板"
          className={`filter-inspector floating panel-surface ${selected?.type === 'equalizer' ? 'eq-expanded' : ''} ${selected && !draggingNodeId ? 'open' : ''}`}
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
              ) : selected.type === 'equalizer' ? (
                <EqCurveEditor
                  bandCount={selected.eqBandCount}
                  gainsDb={selected.eqGainsDb}
                  onBandCountChange={changeEqBandCount}
                  onChange={(eqGainsDb) => updateSelected({ eqGainsDb })}
                />
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

              <p className="filter-runtime-note">{selected.type === 'resampler'
                ? '下采样使用实时抗混叠与抽取；上采样由 Web Audio 上下文完成插值，超过输出上下文的采样率不会生成新的频率信息。不支持 AudioWorklet 时节点透明旁路。'
                : selected.type === 'equalizer'
                  ? `${selected.eqBandCount} 段 EQ 编译为串联的原生 Peaking Biquad；切换段数会重建当前 EQ 分组，但不会重启播放。`
                  : `当前 Nyquist：${formatFrequency(nyquist)}。超出当前设备范围的频率会由 Web Audio 安全钳位。`}</p>
            </div>
          ) : (
            <div className="filter-inspector-empty"><SlidersHorizontal size={24} /><strong>未选择节点</strong><span>添加或点击画布中的节点以编辑参数。</span></div>
          )}
        </aside>

        <aside
          id="input-audio-info"
          ref={inputInfoRef}
          role="dialog"
          aria-modal="false"
          aria-label="输入音频信息"
          className={`filter-inspector floating panel-surface ${inputInfoOpen ? 'open' : ''}`}
          style={{ left: inputInfoPosition.left, top: inputInfoPosition.top }}
        >
          <div className="filter-pane-heading">
            <div>
              <span className="eyebrow">NODE INFO</span>
              <h2>输入信息</h2>
            </div>
            <button type="button" className="floating-inspector-close" aria-label="关闭输入音频信息" onClick={() => setInputInfoOpen(false)}><X size={14} /></button>
          </div>
          {inputAudioInfo ? (
            <div className="filter-inspector-form">
              <div className="filter-selected-summary">
                <span className="filter-palette-icon"><AudioWaveform size={15} /></span>
                <span><strong title={inputAudioInfo.name}>{inputAudioInfo.name}</strong><small>{inputAudioInfo.extension?.toUpperCase() || inputAudioInfo.mimeType || '未知格式'}</small></span>
              </div>
              <dl className="input-info-metadata">
                <div><dt>时长</dt><dd>{formatTime(inputAudioInfo.durationSeconds, true)}</dd></div>
                <div><dt>采样率</dt><dd>{formatFrequency(inputAudioInfo.sampleRate)}</dd></div>
                <div><dt>声道</dt><dd>{formatChannelCount(inputAudioInfo.numberOfChannels)}</dd></div>
                <div><dt>采样帧</dt><dd>{inputAudioInfo.lengthSamples.toLocaleString('zh-CN')}</dd></div>
                <div><dt>文件大小</dt><dd>{formatBytes(inputAudioInfo.sizeBytes)}</dd></div>
                <div><dt>解码 PCM</dt><dd>{formatBytes(inputAudioInfo.pcmBytes)}</dd></div>
                <div><dt>MIME</dt><dd title={inputAudioInfo.mimeType}>{inputAudioInfo.mimeType || '未知'}</dd></div>
              </dl>
              <p className="filter-runtime-note">当前节点读取会话内解码后的原始 PCM；滤波试听不会修改该输入或源文件。</p>
            </div>
          ) : (
            <div className="filter-inspector-empty"><AudioWaveform size={24} /><strong>尚未导入音频</strong><span>导入文件后可在这里查看输入源信息。</span></div>
          )}
        </aside>

        <aside
          id="output-node-controls"
          ref={outputControlsRef}
          role="dialog"
          aria-modal="false"
          aria-label="输出节点控制"
          className={`output-controls-popover panel-surface ${outputControlsOpen ? 'open' : ''}`}
          style={{ left: outputControlsPosition.left, top: outputControlsPosition.top }}
          onClick={(event) => event.stopPropagation()}
        >
          <div className="filter-pane-heading">
            <div>
              <span className="eyebrow">OUTPUT CONTROLS</span>
              <h2>输出控制</h2>
            </div>
            <button type="button" className="floating-inspector-close" aria-label="关闭输出控制" onClick={() => setOutputControlsOpen(false)}><X size={14} /></button>
          </div>
          <div className="output-controls-form">
            <div className="output-control-summary">
              <span className="filter-palette-icon"><Volume2 size={15} /></span>
              <span><strong>监听总线</strong><small>{numberOfChannels > 0 ? `${numberOfChannels} 声道输入` : '等待音频输入'}</small></span>
            </div>

            <label className="filter-field output-volume-field">
              <span>总音量 <output>{Math.round(volume * 100)}%</output></span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={volume}
                disabled={!hasAudio}
                onChange={(event) => onVolumeChange(Number(event.target.value))}
              />
            </label>

            <fieldset className="output-channel-controls" disabled={!hasAudio}>
              <legend>左右声道启用</legend>
              <div>
                <button
                  type="button"
                  className={outputChannelEnabled[0] ? 'active' : ''}
                  aria-pressed={outputChannelEnabled[0]}
                  onClick={() => onOutputChannelEnabledChange(0, !outputChannelEnabled[0])}
                >
                  <Power size={13} /> <span><strong>L</strong><small>左声道</small></span>
                </button>
                <button
                  type="button"
                  className={outputChannelEnabled[1] ? 'active' : ''}
                  aria-pressed={outputChannelEnabled[1]}
                  disabled={!hasAudio || numberOfChannels < 2}
                  title={numberOfChannels < 2 ? '当前音频没有右声道' : undefined}
                  onClick={() => onOutputChannelEnabledChange(1, !outputChannelEnabled[1])}
                >
                  <Power size={13} /> <span><strong>R</strong><small>右声道</small></span>
                </button>
              </div>
            </fieldset>

            <div className={`filter-field output-balance-field ${numberOfChannels < 2 ? 'inactive' : ''}`}>
              <span>立体声平衡 <output>{numberOfChannels < 2 ? '单声道' : formatBalance(outputBalance)}</output></span>
              <input
                type="range"
                min={-1}
                max={1}
                step={0.01}
                value={outputBalance}
                disabled={!hasAudio || numberOfChannels < 2}
                aria-label="立体声平衡"
                onChange={(event) => onOutputBalanceChange(Number(event.target.value))}
              />
              <div className="output-balance-presets" aria-label="立体声平衡快捷设置">
                {([
                  { label: 'L', value: -1, name: '全左' },
                  { label: 'C', value: 0, name: '居中复位' },
                  { label: 'R', value: 1, name: '全右' },
                ] as const).map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    className={Math.abs(outputBalance - preset.value) < 0.005 ? 'active' : ''}
                    disabled={!hasAudio || numberOfChannels < 2}
                    aria-label={preset.name}
                    aria-pressed={Math.abs(outputBalance - preset.value) < 0.005}
                    title={preset.name}
                    onClick={() => onOutputBalanceChange(preset.value)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            <p className="filter-runtime-note">左右控制只作用于前两个监听输出声道；多声道的其余声道保持原增益。它不会改写声道 Mute/Solo、源 PCM、分析结果或导出内容。</p>
          </div>
        </aside>
      </section>
    </main>
  )
}
