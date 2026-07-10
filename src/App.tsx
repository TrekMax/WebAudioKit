import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  AudioWaveform,
  Box,
  FolderOpen,
  Layers3,
  Maximize2,
  ScanLine,
  ShieldCheck,
  Snowflake,
  Waves,
} from 'lucide-react'
import { AudioEngine } from './audio/AudioEngine'
import {
  defaultChannelLayout,
  describeChannelLayout,
  normalizeChannelLayout,
  type ChannelLayoutPreset,
} from './audio/channelLayout'
import {
  DEFAULT_MAX_DECODED_PCM_BYTES,
  DEFAULT_MAX_ENCODED_AUDIO_BYTES,
  DEFAULT_MAX_ESTIMATED_WORKING_SET_BYTES,
  importAudio,
  type ImportedAudioMetadata,
} from './audio/importAudio'
import type { PlaybackSnapshot, SampleRange } from './audio/types'
import type { ChannelStftPreview, StftPreviewResult } from './audio/analysis'
import { mergeWaveformPyramids, type WaveformPyramid } from './audio/peaks'
import { AnalysisWorkerClient } from './workers/AnalysisWorkerClient'
import { ExportWorkerClient } from './workers/ExportWorkerClient'
import {
  createProjectStore,
  type StoredRecentWorkspace,
} from './state/projectStore'
import { AppHeader } from './components/AppHeader'
import { AssetSidebar, type AssetSummary } from './components/AssetSidebar'
import { AnalysisControls } from './components/AnalysisControls'
import { ChannelPanel } from './components/ChannelPanel'
import { DropOverlay } from './components/DropOverlay'
import {
  ExportDialog,
  type WavExportRequest,
} from './components/ExportDialog'
import type { Fft3DMode, Fft3DQuality } from './components/Fft3DView'
import { SpectrogramCanvas } from './components/SpectrogramCanvas'
import { SpectrumCanvas } from './components/SpectrumCanvas'
import { Transport } from './components/Transport'
import { WaveformCanvas } from './components/WaveformCanvas'
import {
  DEFAULT_ANALYSIS_CONFIG,
  type SampleSelection,
  type WorkspaceAnalysisConfig,
} from './workspaceTypes'

type AnalysisTab = 'spectrum' | 'spectrogram' | '3d'

const LazyFft3DView = lazy(async () => {
  const module = await import('./components/Fft3DView')
  return { default: module.Fft3DView }
})

interface RuntimeAsset {
  readonly id: string
  readonly metadata: ImportedAudioMetadata
  readonly buffer: AudioBuffer
  peaks: WaveformPyramid | null
  analysis: StftPreviewResult | null
  analysisKey: string | null
  selection: SampleSelection | null
  positionSample: number
  visibleChannels: number[]
  mutedChannels: number[]
  soloChannels: number[]
  channelLayout: ChannelLayoutPreset
}

interface AnalysisClients {
  peaks: AnalysisWorkerClient
  offline: AnalysisWorkerClient
  realtime: AnalysisWorkerClient
}

const EMPTY_PLAYBACK: PlaybackSnapshot = {
  kind: 'empty',
  assetId: null,
  positionSample: 0,
  durationSamples: 0,
  positionSeconds: 0,
  durationSeconds: 0,
  sampleRate: null,
  numberOfChannels: 0,
  selection: null,
  loop: false,
  volume: 1,
  muted: false,
  channelMuted: [],
  channelSolo: [],
  playbackRate: 1,
  contextState: 'suspended',
  sessionId: null,
  errorMessage: null,
}

const CHANNEL_SPECTRUM_COLORS = [
  '#20dfb1',
  '#64a9ff',
  '#ffb35c',
  '#ff6f76',
  '#b08cff',
  '#52d6e8',
  '#d7df63',
  '#f08bd8',
] as const

function createId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
}

function analysisKey(config: WorkspaceAnalysisConfig, selection: SampleSelection | null): string {
  return JSON.stringify({
    fftSize: config.fftSize,
    window: config.window,
    overlap: config.overlap,
    channel: config.channel,
    minDb: config.minDb,
    maxDb: config.maxDb,
    selection,
  })
}

function copyChannels(
  buffer: AudioBuffer,
  range?: SampleRange,
): Float32Array[] {
  const start = range?.start ?? 0
  const end = range?.end ?? buffer.length
  return Array.from(
    { length: buffer.numberOfChannels },
    (_, channel) => buffer.getChannelData(channel).slice(start, end),
  )
}

function channelMode(
  config: WorkspaceAnalysisConfig,
  numberOfChannels: number,
): { kind: 'mix' } | { kind: 'channel'; index: number } {
  if (config.channel === 'mix') return { kind: 'mix' }
  return {
    kind: 'channel',
    index: Math.max(0, Math.min(config.channel, numberOfChannels - 1)),
  }
}

function defaultVisibleChannels(numberOfChannels: number): number[] {
  return Array.from(
    { length: Math.min(2, Math.max(0, numberOfChannels)) },
    (_, index) => index,
  )
}

function normalizeVisibleChannels(
  channels: readonly number[] | undefined,
  numberOfChannels: number,
): number[] {
  if (channels === undefined) return defaultVisibleChannels(numberOfChannels)
  const normalized = [...new Set(channels ?? [])]
    .filter((index) => Number.isSafeInteger(index) && index >= 0 && index < numberOfChannels)
    .sort((left, right) => left - right)
  if (channels.length > 0 && normalized.length === 0) {
    return defaultVisibleChannels(numberOfChannels)
  }
  return normalized
}

function normalizeConfigChannel(
  config: WorkspaceAnalysisConfig,
  numberOfChannels: number,
): WorkspaceAnalysisConfig {
  if (
    config.channel === 'mix' ||
    (config.channel >= 0 && config.channel < numberOfChannels)
  ) return config
  return { ...config, channel: 'mix' }
}

function normalizeChannelSet(
  channels: readonly number[] | undefined,
  numberOfChannels: number,
): number[] {
  return [...new Set(channels ?? [])]
    .filter((channel) => Number.isSafeInteger(channel) && channel >= 0 && channel < numberOfChannels)
    .sort((left, right) => left - right)
}

function applyPlaybackChannelState(engine: AudioEngine, asset: RuntimeAsset): void {
  for (const channelIndex of asset.mutedChannels) {
    engine.setChannelMuted(channelIndex, true)
  }
  for (const channelIndex of asset.soloChannels) {
    engine.setChannelSolo(channelIndex, true)
  }
}

function matchesStoredAsset(
  stored: ImportedAudioMetadata | null | undefined,
  imported: ImportedAudioMetadata,
): boolean {
  return stored?.fingerprint === imported.fingerprint
    && stored.sizeBytes === imported.sizeBytes
    && stored.lastModified === imported.lastModified
    && stored.sampleRate === imported.sampleRate
    && stored.numberOfChannels === imported.numberOfChannels
    && stored.lengthSamples === imported.lengthSamples
}

function safeBaseName(name: string): string {
  const withoutExtension = name.replace(/\.[^.]+$/, '')
  return (withoutExtension || 'audio')
    .replace(/[<>:"/\\|?*]/g, '_')
    .slice(0, 120)
}

function downloadBytes(bytes: ArrayBuffer, mimeType: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

function downloadText(text: string, mimeType: string, fileName: string): void {
  const encoded = new TextEncoder().encode(text)
  downloadBytes(encoded.buffer as ArrayBuffer, mimeType, fileName)
}

export function App() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const engineRef = useRef<AudioEngine | null>(null)
  const unsubscribeEngineRef = useRef<(() => void) | null>(null)
  const clientsRef = useRef<AnalysisClients | null>(null)
  const exportClientRef = useRef<ExportWorkerClient | null>(null)
  const offlineJobIdRef = useRef<string | null>(null)
  const cancelExportRef = useRef<(() => void) | null>(null)
  const importAbortRef = useRef<AbortController | null>(null)
  const cancelPeakBuildRef = useRef<(() => void) | null>(null)
  const realtimeAnchorRef = useRef({ assetId: '', sample: -1, key: '' })
  const restoredWorkspaceRef = useRef<StoredRecentWorkspace | null>(null)
  const workspaceLoadPromiseRef = useRef<Promise<StoredRecentWorkspace | null> | null>(null)
  const workspaceRestoreAppliedRef = useRef(false)
  const projectStoreCloseTimerRef = useRef<number | null>(null)
  const waveformControlsRef = useRef<{ fit: () => void; zoomToSelection: () => void } | null>(null)
  const reset3dRef = useRef<(() => void) | null>(null)
  const dragDepthRef = useRef(0)
  const [projectStore] = useState(() => createProjectStore())
  const [workspaceRestored, setWorkspaceRestored] = useState(false)

  const [assets, setAssets] = useState<RuntimeAsset[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [playback, setPlayback] = useState<PlaybackSnapshot>(EMPTY_PLAYBACK)
  const [config, setConfig] = useState<WorkspaceAnalysisConfig>(DEFAULT_ANALYSIS_CONFIG)
  const [analysisTab, setAnalysisTab] = useState<AnalysisTab>('spectrum')
  const [mode3d, setMode3d] = useState<Fft3DMode>('surface')
  const [quality3d, setQuality3d] = useState<Fft3DQuality>('medium')
  const [realtimeResult, setRealtimeResult] = useState<StftPreviewResult | null>(null)
  const [realtimeChannelResults, setRealtimeChannelResults] = useState<readonly ChannelStftPreview[]>([])
  const [spectrumFrozen, setSpectrumFrozen] = useState(false)
  const [spectrumComparison, setSpectrumComparison] = useState(false)
  const [frozenTime, setFrozenTime] = useState(0)
  const [analysisStale, setAnalysisStale] = useState(false)
  const [analyzing, setAnalyzing] = useState(false)
  const [analysisProgress, setAnalysisProgress] = useState(0)
  const [importing, setImporting] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState(0)
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  const [dropActive, setDropActive] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const activeAsset = useMemo(
    () => assets.find((asset) => asset.id === activeId) ?? null,
    [activeId, assets],
  )

  const ensureEngine = useCallback((): AudioEngine => {
    if (!engineRef.current) {
      const engine = new AudioEngine()
      engineRef.current = engine
      unsubscribeEngineRef.current = engine.subscribe(setPlayback)
      setPlayback(engine.snapshot())
    }
    return engineRef.current
  }, [])

  const ensureClients = useCallback((): AnalysisClients => {
    clientsRef.current ??= {
      peaks: new AnalysisWorkerClient(),
      offline: new AnalysisWorkerClient(),
      realtime: new AnalysisWorkerClient(),
    }
    return clientsRef.current
  }, [])

  const ensureExportClient = useCallback((): ExportWorkerClient => {
    exportClientRef.current ??= new ExportWorkerClient()
    return exportClientRef.current
  }, [])

  const loadRecentWorkspace = useCallback((): Promise<StoredRecentWorkspace | null> => {
    workspaceLoadPromiseRef.current ??= projectStore.load().catch(() => null)
    return workspaceLoadPromiseRef.current
  }, [projectStore])

  const applyRestoredWorkspace = useCallback((stored: StoredRecentWorkspace | null) => {
    if (workspaceRestoreAppliedRef.current) return
    workspaceRestoreAppliedRef.current = true
    restoredWorkspaceRef.current = stored
    if (stored) {
      setConfig(stored.analysisConfig)
      setSpectrumComparison(stored.spectrumComparison ?? false)
    }
    setWorkspaceRestored(true)
  }, [])

  useEffect(() => {
    let cancelled = false
    void loadRecentWorkspace().then((stored) => {
      if (cancelled) return
      applyRestoredWorkspace(stored)
    })
    return () => { cancelled = true }
  }, [applyRestoredWorkspace, loadRecentWorkspace])

  useEffect(() => {
    if (!workspaceRestored) return
    const timeout = window.setTimeout(() => {
      const pendingRestore = restoredWorkspaceRef.current
      void projectStore.save({
        analysisConfig: config,
        activeAsset: activeAsset?.metadata ?? pendingRestore?.activeAsset ?? null,
        selection: activeAsset
          ? activeAsset.selection
          : (pendingRestore?.selection ?? null),
        playheadSample: activeAsset
          ? playback.positionSample
          : (pendingRestore?.playheadSample ?? 0),
        visibleChannels: activeAsset?.visibleChannels ?? pendingRestore?.visibleChannels,
        mutedChannels: activeAsset?.mutedChannels ?? pendingRestore?.mutedChannels,
        soloChannels: activeAsset?.soloChannels ?? pendingRestore?.soloChannels,
        channelLayout: activeAsset?.channelLayout ?? pendingRestore?.channelLayout,
        spectrumComparison,
      }).catch(() => undefined)
    }, 350)
    return () => window.clearTimeout(timeout)
  }, [
    activeAsset,
    config,
    playback.positionSample,
    projectStore,
    spectrumComparison,
    workspaceRestored,
  ])

  useEffect(() => {
    if (playback.kind !== 'playing') return
    let frame = 0
    let previous = 0
    const update = (timestamp: number) => {
      if (timestamp - previous >= 33) {
        previous = timestamp
        if (engineRef.current) setPlayback(engineRef.current.snapshot())
      }
      frame = requestAnimationFrame(update)
    }
    frame = requestAnimationFrame(update)
    return () => cancelAnimationFrame(frame)
  }, [playback.kind])

  useEffect(() => {
    if (projectStoreCloseTimerRef.current !== null) {
      window.clearTimeout(projectStoreCloseTimerRef.current)
      projectStoreCloseTimerRef.current = null
    }
    return () => {
      unsubscribeEngineRef.current?.()
      clientsRef.current?.peaks.terminate()
      clientsRef.current?.offline.terminate()
      clientsRef.current?.realtime.terminate()
      exportClientRef.current?.terminate()
      // React development StrictMode immediately replays effects. Defer the
      // final IDB close so the replayed setup can retain the same live store.
      projectStoreCloseTimerRef.current = window.setTimeout(() => {
        projectStore.close()
        projectStoreCloseTimerRef.current = null
      }, 0)
      if (engineRef.current) void engineRef.current.dispose()
    }
  }, [projectStore])

  useEffect(() => {
    if (!errorMessage) return
    const timeout = window.setTimeout(() => setErrorMessage(null), 7_000)
    return () => window.clearTimeout(timeout)
  }, [errorMessage])

  const runOfflineAnalysis = useCallback(async (
    asset: RuntimeAsset,
    nextConfig: WorkspaceAnalysisConfig,
    selection: SampleSelection | null,
  ) => {
    const clients = ensureClients()
    const range = selection ?? { start: 0, end: asset.buffer.length }
    const resultKey = analysisKey(nextConfig, selection)
    const requestedChannelMode = channelMode(
      nextConfig,
      asset.buffer.numberOfChannels,
    )
    const analysisChannels = requestedChannelMode.kind === 'mix'
      ? copyChannels(asset.buffer)
      : [asset.buffer.getChannelData(requestedChannelMode.index).slice()]
    const workerChannelMode = requestedChannelMode.kind === 'mix'
      ? requestedChannelMode
      : { kind: 'channel' as const, index: 0 }
    setAnalyzing(true)
    setAnalysisProgress(0)
    setAnalysisStale(Boolean(
      asset.analysis && asset.analysisKey !== resultKey,
    ))
    const job = clients.offline.startAnalyze(
      {
        channels: analysisChannels,
        options: {
          sampleRate: asset.buffer.sampleRate,
          fftSize: nextConfig.fftSize,
          hopSize: Math.round(nextConfig.fftSize * (1 - nextConfig.overlap)),
          window: nextConfig.window,
          channelMode: workerChannelMode,
          minDb: nextConfig.minDb,
          maxDb: nextConfig.maxDb,
          range,
        },
      },
      { onProgress: ({ ratio }) => setAnalysisProgress(ratio) },
    )
    offlineJobIdRef.current = job.jobId
    try {
      const workerResult = await job.result
      const result: StftPreviewResult = requestedChannelMode.kind === 'mix'
        ? workerResult
        : { ...workerResult, channelMode: requestedChannelMode }
      setAssets((current) => current.map((item) => item.id === asset.id
        ? { ...item, analysis: result, analysisKey: resultKey }
        : item))
      setAnalysisStale(false)
      setStatusMessage(`已完成 ${result.frameCount} 帧 FFT 预览`)
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      if (!name.includes('Cancelled') && !name.includes('Stale')) {
        setErrorMessage(error instanceof Error ? error.message : 'FFT 分析失败')
      }
    } finally {
      if (offlineJobIdRef.current === job.jobId) {
        setAnalyzing(false)
        setAnalysisProgress(0)
      }
    }
  }, [ensureClients])

  const handleFiles = useCallback(async (fileList: FileList | File[]) => {
    const files = Array.from(fileList)
    if (files.length === 0 || importing || importAbortRef.current) return
    setImporting(true)
    setErrorMessage(null)
    const abortController = new AbortController()
    importAbortRef.current = abortController
    const wasWorkspaceRestored = workspaceRestored
    const storedWorkspace = await loadRecentWorkspace()
    applyRestoredWorkspace(storedWorkspace)
    const importConfig = wasWorkspaceRestored
      ? config
      : (storedWorkspace?.analysisConfig ?? config)
    let lastAsset: RuntimeAsset | null = null
    let lastAssetExceedsSoftLimit = false
    let nextAnalysisConfig = importConfig
    let residentPcmBytes = assets.reduce(
      (total, asset) => total + asset.metadata.pcmBytes,
      0,
    )
    try {
      const engine = ensureEngine()
      const clients = ensureClients()
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index]
        if (!file) continue
        setStatusMessage(`正在导入 ${index + 1}/${files.length}：${file.name}`)
        const remainingResidentBytes = DEFAULT_MAX_DECODED_PCM_BYTES
          - residentPcmBytes
        const remainingWorkingSetBytes = DEFAULT_MAX_ESTIMATED_WORKING_SET_BYTES
          - residentPcmBytes
        if (remainingResidentBytes <= 0 || remainingWorkingSetBytes <= 0) {
          throw new Error('当前工作区 PCM 已达到内存安全上限，请先关闭不需要的音频资源')
        }
        const imported = await importAudio(file, engine.audioContext, {
          signal: abortController.signal,
          maxEncodedBytes: Math.min(
            DEFAULT_MAX_ENCODED_AUDIO_BYTES,
            remainingWorkingSetBytes,
          ),
          maxDecodedPcmBytes: Math.min(
            DEFAULT_MAX_DECODED_PCM_BYTES,
            remainingResidentBytes,
          ),
          maxEstimatedWorkingSetBytes: remainingWorkingSetBytes,
        })
        residentPcmBytes += imported.metadata.pcmBytes
        nextAnalysisConfig = normalizeConfigChannel(
          importConfig,
          imported.audioBuffer.numberOfChannels,
        )
        const restored = restoredWorkspaceRef.current
        const matchingRestore = restored && matchesStoredAsset(
          restored.activeAsset,
          imported.metadata,
        ) ? restored : null
        const restoredSelection = matchingRestore
          ? (matchingRestore.selection ?? null)
          : null
        const restoredPosition = matchingRestore
          ? Math.min(matchingRestore.playheadSample ?? 0, imported.audioBuffer.length)
          : 0
        const asset: RuntimeAsset = {
          id: createId(imported.metadata.fingerprint.slice(0, 12)),
          metadata: imported.metadata,
          buffer: imported.audioBuffer,
          peaks: null,
          analysis: null,
          analysisKey: null,
          selection: restoredSelection,
          positionSample: restoredPosition,
          visibleChannels: matchingRestore
            ? normalizeVisibleChannels(
                matchingRestore.visibleChannels,
                imported.audioBuffer.numberOfChannels,
              )
            : defaultVisibleChannels(imported.audioBuffer.numberOfChannels),
          mutedChannels: normalizeChannelSet(
            matchingRestore?.mutedChannels,
            imported.audioBuffer.numberOfChannels,
          ),
          soloChannels: normalizeChannelSet(
            matchingRestore?.soloChannels,
            imported.audioBuffer.numberOfChannels,
          ),
          channelLayout: matchingRestore
            ? normalizeChannelLayout(
                matchingRestore.channelLayout,
                imported.audioBuffer.numberOfChannels,
              )
            : defaultChannelLayout(imported.audioBuffer.numberOfChannels),
        }
        engine.load(asset.id, asset.buffer, {
          positionSample: asset.positionSample,
          selection: asset.selection,
        })
        applyPlaybackChannelState(engine, asset)
        clients.realtime.invalidateAnalysis()
        setConfig(nextAnalysisConfig)
        lastAsset = asset
        lastAssetExceedsSoftLimit = imported.memory.exceedsSoftLimit
        setAssets((current) => [...current, asset])
        setActiveId(asset.id)
        setRealtimeResult(null)
        setRealtimeChannelResults([])
        if (imported.memory.exceedsSoftLimit) {
          setStatusMessage(`已导入 ${file.name}；解码 PCM 占用较高，建议缩小分析选区`)
        } else {
          setStatusMessage(`正在生成 ${file.name} 的波形峰值…`)
        }
        const channelPyramids: WaveformPyramid[] = []
        for (
          let channelIndex = 0;
          channelIndex < asset.buffer.numberOfChannels;
          channelIndex += 1
        ) {
          if (abortController.signal.aborted) {
            throw new DOMException('Import cancelled', 'AbortError')
          }
          setStatusMessage(
            `正在生成 ${file.name} 的波形 · Channel ${channelIndex + 1}/${asset.buffer.numberOfChannels}`,
          )
          const peakJob = clients.peaks.startBuildPeaks({
            assetId: asset.id,
            channels: [asset.buffer.getChannelData(channelIndex).slice()],
          })
          cancelPeakBuildRef.current = peakJob.cancel
          channelPyramids.push(await peakJob.result)
        }
        cancelPeakBuildRef.current = null
        const pyramid = mergeWaveformPyramids(channelPyramids)
        asset.peaks = pyramid
        setAssets((current) => current.map((item) => item.id === asset.id
          ? { ...item, peaks: pyramid }
          : item))
      }
      if (lastAsset) {
        if (lastAssetExceedsSoftLimit) {
          setStatusMessage('波形已就绪；内存占用较高，请缩小选区后手动分析')
        } else {
          void runOfflineAnalysis(
            lastAsset,
            nextAnalysisConfig,
            lastAsset.selection,
          )
        }
      }
    } catch (error) {
      const cancelled = abortController.signal.aborted ||
        (error instanceof Error && error.name.includes('Cancelled'))
      if (!cancelled) {
        setErrorMessage(error instanceof Error ? error.message : '音频导入失败')
      }
    } finally {
      if (lastAsset) {
        restoredWorkspaceRef.current = null
      }
      if (importAbortRef.current === abortController) importAbortRef.current = null
      cancelPeakBuildRef.current = null
      setImporting(false)
      window.setTimeout(() => setStatusMessage(null), 2_500)
    }
  }, [
    applyRestoredWorkspace,
    assets,
    config,
    ensureClients,
    ensureEngine,
    importing,
    loadRecentWorkspace,
    runOfflineAnalysis,
    workspaceRestored,
  ])

  const cancelImport = useCallback(() => {
    importAbortRef.current?.abort()
    cancelPeakBuildRef.current?.()
    cancelPeakBuildRef.current = null
    setStatusMessage('正在取消导入任务…')
  }, [])

  const activateAsset = useCallback((id: string) => {
    if (id === activeId) return
    const next = assets.find((asset) => asset.id === id)
    if (!next) return
    const nextConfig = normalizeConfigChannel(config, next.buffer.numberOfChannels)
    if (activeId) {
      setAssets((current) => current.map((asset) => asset.id === activeId
        ? { ...asset, positionSample: playback.positionSample, selection: playback.selection }
        : asset))
    }
    const engine = ensureEngine()
    try {
      engine.load(id, next.buffer, {
        positionSample: next.positionSample,
        selection: next.selection,
      })
      applyPlaybackChannelState(engine, next)
    } catch (error) {
      setErrorMessage(error instanceof Error
        ? `无法切换音频资源：${error.message}`
        : '无法切换音频资源')
      return
    }
    if (offlineJobIdRef.current) {
      clientsRef.current?.offline.cancel(offlineJobIdRef.current)
      offlineJobIdRef.current = null
      setAnalyzing(false)
      setAnalysisProgress(0)
    }
    clientsRef.current?.realtime.invalidateAnalysis()
    if (nextConfig !== config) setConfig(nextConfig)
    setActiveId(id)
    setRealtimeResult(null)
    setRealtimeChannelResults([])
    setAnalysisStale(next.analysisKey !== analysisKey(nextConfig, next.selection))
  }, [activeId, assets, config, ensureEngine, playback.positionSample, playback.selection])

  const removeAsset = useCallback((id: string) => {
    const remaining = assets.filter((asset) => asset.id !== id)
    if (id !== activeId) {
      setAssets(remaining)
      return
    }
    const engine = ensureEngine()
    const next = remaining[0]
    const nextConfig = next
      ? normalizeConfigChannel(config, next.buffer.numberOfChannels)
      : null
    if (next) {
      try {
        engine.load(next.id, next.buffer, {
          positionSample: next.positionSample,
          selection: next.selection,
        })
        applyPlaybackChannelState(engine, next)
      } catch (error) {
        setErrorMessage(error instanceof Error
          ? `无法切换到下一资源：${error.message}`
          : '无法切换到下一资源')
        return
      }
    } else {
      engine.unload()
    }

    if (offlineJobIdRef.current) {
      clientsRef.current?.offline.cancel(offlineJobIdRef.current)
      offlineJobIdRef.current = null
      setAnalyzing(false)
      setAnalysisProgress(0)
    }
    clientsRef.current?.realtime.invalidateAnalysis()

    if (next && nextConfig) {
      setAssets(remaining)
      if (nextConfig !== config) setConfig(nextConfig)
      setActiveId(next.id)
      setAnalysisStale(next.analysisKey !== analysisKey(nextConfig, next.selection))
    } else {
      setAssets(remaining)
      setActiveId(null)
      setAnalysisStale(false)
    }
    setRealtimeResult(null)
    setRealtimeChannelResults([])
  }, [activeId, assets, config, ensureEngine])

  const toggleChannelVisibility = useCallback((channelIndex: number) => {
    if (!activeId) return
    setAssets((current) => current.map((asset) => {
      if (asset.id !== activeId) return asset
      const visible = normalizeVisibleChannels(
        asset.visibleChannels,
        asset.buffer.numberOfChannels,
      )
      if (visible.includes(channelIndex)) {
        return {
          ...asset,
          visibleChannels: visible.filter((index) => index !== channelIndex),
        }
      }
      return {
        ...asset,
        visibleChannels: [...visible, channelIndex].sort((left, right) => left - right),
      }
    }))
  }, [activeId])

  const isolateChannel = useCallback((channelIndex: number) => {
    if (!activeId) return
    setAssets((current) => current.map((asset) => asset.id === activeId
      ? { ...asset, visibleChannels: [channelIndex] }
      : asset))
  }, [activeId])

  const showAllChannels = useCallback(() => {
    if (!activeId) return
    setAssets((current) => current.map((asset) => asset.id === activeId
      ? {
          ...asset,
          visibleChannels: Array.from(
            { length: asset.buffer.numberOfChannels },
            (_, index) => index,
          ),
        }
      : asset))
  }, [activeId])

  const resetVisibleChannels = useCallback(() => {
    if (!activeId) return
    setAssets((current) => current.map((asset) => asset.id === activeId
      ? {
          ...asset,
          visibleChannels: defaultVisibleChannels(asset.buffer.numberOfChannels),
        }
      : asset))
  }, [activeId])

  const toggleChannelMute = useCallback((channelIndex: number) => {
    if (!activeAsset) return
    const muted = !activeAsset.mutedChannels.includes(channelIndex)
    ensureEngine().setChannelMuted(channelIndex, muted)
    setAssets((current) => current.map((asset) => asset.id === activeAsset.id
      ? {
          ...asset,
          mutedChannels: muted
            ? [...asset.mutedChannels, channelIndex].sort((left, right) => left - right)
            : asset.mutedChannels.filter((index) => index !== channelIndex),
        }
      : asset))
  }, [activeAsset, ensureEngine])

  const toggleChannelSolo = useCallback((channelIndex: number) => {
    if (!activeAsset) return
    const solo = !activeAsset.soloChannels.includes(channelIndex)
    ensureEngine().setChannelSolo(channelIndex, solo)
    setAssets((current) => current.map((asset) => asset.id === activeAsset.id
      ? {
          ...asset,
          soloChannels: solo
            ? [...asset.soloChannels, channelIndex].sort((left, right) => left - right)
            : asset.soloChannels.filter((index) => index !== channelIndex),
        }
      : asset))
  }, [activeAsset, ensureEngine])

  const changeChannelLayout = useCallback((layout: ChannelLayoutPreset) => {
    if (!activeAsset) return
    const normalized = normalizeChannelLayout(layout, activeAsset.buffer.numberOfChannels)
    setAssets((current) => current.map((asset) => asset.id === activeAsset.id
      ? { ...asset, channelLayout: normalized }
      : asset))
  }, [activeAsset])

  const updateSelection = useCallback((selection: SampleSelection | null) => {
    if (!activeAsset) return
    if (offlineJobIdRef.current) {
      clientsRef.current?.offline.cancel(offlineJobIdRef.current)
      offlineJobIdRef.current = null
      setAnalyzing(false)
      setAnalysisProgress(0)
    }
    const engine = ensureEngine()
    if (selection && selection.end > selection.start) engine.setSelection(selection)
    else engine.clearSelection()
    setAssets((current) => current.map((asset) => asset.id === activeAsset.id
      ? { ...asset, selection }
      : asset))
    setAnalysisStale(activeAsset.analysis !== null)
  }, [activeAsset, ensureEngine])

  const seekSample = useCallback((sample: number) => {
    if (!activeAsset) return
    ensureEngine().seek(Math.max(0, Math.min(activeAsset.buffer.length, Math.round(sample))))
  }, [activeAsset, ensureEngine])

  useEffect(() => {
    if (!activeAsset || spectrumFrozen) return
    const comparisonChannels = normalizeChannelSet(
      activeAsset.visibleChannels,
      activeAsset.buffer.numberOfChannels,
    )
    const key = JSON.stringify({
      fftSize: config.fftSize,
      window: config.window,
      minDb: config.minDb,
      maxDb: config.maxDb,
      channel: config.channel,
      spectrumComparison,
      comparisonChannels,
    })
    const minimumDelta = activeAsset.buffer.sampleRate / 15
    const anchor = realtimeAnchorRef.current
    if (
      anchor.assetId === activeAsset.id &&
      anchor.key === key &&
      playback.kind === 'playing' &&
      Math.abs(playback.positionSample - anchor.sample) < minimumDelta
    ) return
    realtimeAnchorRef.current = {
      assetId: activeAsset.id,
      sample: playback.positionSample,
      key,
    }

    const realtimeClient = ensureClients().realtime
    if (spectrumComparison && comparisonChannels.length === 0) {
      realtimeClient.invalidateAnalysis()
      return
    }

    const fftSize = config.fftSize
    const windowStart = playback.positionSample - Math.floor(fftSize / 2)
    const channels = Array.from({ length: activeAsset.buffer.numberOfChannels }, (_, channel) => {
      const output = new Float32Array(fftSize)
      const source = activeAsset.buffer.getChannelData(channel)
      const sourceStart = Math.max(0, windowStart)
      const sourceEnd = Math.min(source.length, windowStart + fftSize)
      if (sourceEnd > sourceStart) {
        output.set(source.subarray(sourceStart, sourceEnd), sourceStart - windowStart)
      }
      return output
    })

    const options = {
      sampleRate: activeAsset.buffer.sampleRate,
      fftSize,
      hopSize: fftSize,
      window: config.window,
      minDb: config.minDb,
      maxDb: config.maxDb,
      range: { start: 0, end: fftSize },
      frameCount: 1,
    } as const

    if (spectrumComparison) {
      const job = realtimeClient.startAnalyzeChannels({
        channels,
        channelIndices: comparisonChannels,
        options,
      })
      void job.result.then(({ results }) => {
        for (const { preview } of results) {
          preview.timesSeconds[0] = playback.positionSeconds
        }
        setRealtimeChannelResults(results)
      }).catch(() => undefined)
      return
    }

    const job = realtimeClient.startAnalyze({
      channels,
      options: {
        ...options,
        channelMode: channelMode(config, activeAsset.buffer.numberOfChannels),
      },
    })
    void job.result.then((result) => {
      result.timesSeconds[0] = playback.positionSeconds
      setRealtimeResult(result)
    }).catch(() => undefined)
  }, [
    activeAsset,
    config,
    ensureClients,
    playback.kind,
    playback.positionSample,
    playback.positionSeconds,
    spectrumComparison,
    spectrumFrozen,
  ])

  const playPause = useCallback(() => {
    if (!activeAsset) return
    const engine = ensureEngine()
    if (playback.kind === 'playing') engine.pause()
    else void engine.play().catch((error: unknown) => setErrorMessage(error instanceof Error ? error.message : '无法开始播放'))
  }, [activeAsset, ensureEngine, playback.kind])

  const toggleSpectrumComparison = useCallback(() => {
    clientsRef.current?.realtime.invalidateAnalysis()
    if (spectrumComparison) setRealtimeResult(null)
    else setRealtimeChannelResults([])
    setSpectrumFrozen(false)
    setSpectrumComparison((value) => !value)
  }, [spectrumComparison])

  const toggleSpectrumFreeze = useCallback(() => {
    if (!spectrumFrozen) {
      clientsRef.current?.realtime.invalidateAnalysis()
      setFrozenTime(playback.positionSeconds)
    }
    setSpectrumFrozen((frozen) => !frozen)
  }, [playback.positionSeconds, spectrumFrozen])

  const handleConfigChange = useCallback((next: WorkspaceAnalysisConfig) => {
    if (
      !Number.isFinite(next.minDb) ||
      !Number.isFinite(next.maxDb) ||
      next.minDb >= next.maxDb ||
      next.maxDb > 0
    ) {
      setErrorMessage('dBFS 范围必须满足：最低值 < 最高值 ≤ 0')
      return
    }
    const nextKey = analysisKey(next, activeAsset?.selection ?? null)
    const currentKey = analysisKey(config, activeAsset?.selection ?? null)
    if (nextKey !== currentKey && offlineJobIdRef.current) {
      clientsRef.current?.offline.cancel(offlineJobIdRef.current)
      offlineJobIdRef.current = null
      setAnalyzing(false)
      setAnalysisProgress(0)
    }
    setConfig(next)
    setAnalysisStale(Boolean(
      activeAsset?.analysis && activeAsset.analysisKey !== nextKey,
    ))
  }, [activeAsset, config])

  const handleWaveformControlsReady = useCallback((controls: {
    fit: () => void
    zoomToSelection: () => void
  }) => {
    waveformControlsRef.current = controls
  }, [])

  const handle3dResetReady = useCallback((reset: () => void) => {
    reset3dRef.current = reset
  }, [])

  const requestAnalysis = useCallback(() => {
    if (activeAsset) void runOfflineAnalysis(activeAsset, config, activeAsset.selection)
  }, [activeAsset, config, runOfflineAnalysis])

  const cancelAnalysis = useCallback(() => {
    const jobId = offlineJobIdRef.current
    if (jobId) clientsRef.current?.offline.cancel(jobId)
    offlineJobIdRef.current = null
    setAnalyzing(false)
    setAnalysisProgress(0)
    setAnalysisStale(Boolean(activeAsset?.analysis))
  }, [activeAsset])

  const handleWavExport = useCallback(async (request: WavExportRequest) => {
    if (!activeAsset) return
    if (
      request.normalize &&
      (!Number.isFinite(request.targetPeakDbfs) || request.targetPeakDbfs > 0)
    ) {
      setErrorMessage('归一化目标必须是小于或等于 0 的有限 dBFS 数值')
      return
    }
    const range: SampleRange | undefined = request.scope === 'selection' && activeAsset.selection
      ? activeAsset.selection
      : undefined
    const frameCount = range
      ? range.end - range.start
      : activeAsset.buffer.length
    const bytesPerSample = request.format === 'pcm16'
      ? 2
      : request.format === 'pcm24'
        ? 3
        : 4
    const copiedPcmBytes = frameCount
      * activeAsset.buffer.numberOfChannels
      * Float32Array.BYTES_PER_ELEMENT
    const residentPcmBytes = assets.reduce(
      (total, asset) => total + asset.metadata.pcmBytes,
      0,
    )
    const estimatedWorkingSetBytes = residentPcmBytes
      + copiedPcmBytes
      + frameCount * activeAsset.buffer.numberOfChannels * bytesPerSample
    if (estimatedWorkingSetBytes > DEFAULT_MAX_ESTIMATED_WORKING_SET_BYTES) {
      setErrorMessage('本次导出预计超过 1 GiB 工作内存，请缩小选区或降低采样格式')
      return
    }
    setExporting(true)
    setExportProgress(0)
    try {
      const job = ensureExportClient().startEncodeWav({
        sampleRate: activeAsset.buffer.sampleRate,
        channels: copyChannels(activeAsset.buffer, range),
        format: request.format,
        normalize: request.normalize,
        targetPeakDbfs: request.targetPeakDbfs,
      }, { onProgress: ({ ratio }) => setExportProgress(ratio) })
      cancelExportRef.current = job.cancel
      const result = await job.result
      const suffix = range ? '-selection' : '-full'
      downloadBytes(result.bytes, result.mimeType, `${safeBaseName(activeAsset.metadata.name)}${suffix}.${result.fileExtension}`)
      setExportDialogOpen(false)
      setStatusMessage(`WAV 导出完成 · ${result.info.frameCount.toLocaleString()} samples`)
    } catch (error) {
      if (!(error instanceof Error) || !error.name.includes('Cancelled')) {
        setErrorMessage(error instanceof Error ? error.message : 'WAV 导出失败')
      }
    } finally {
      cancelExportRef.current = null
      setExporting(false)
      setExportProgress(0)
    }
  }, [activeAsset, assets, ensureExportClient])

  const cancelExport = useCallback(() => {
    cancelExportRef.current?.()
    cancelExportRef.current = null
    setExporting(false)
    setExportProgress(0)
  }, [])

  const handleCsvExport = useCallback(async () => {
    if (!activeAsset?.analysis) {
      setErrorMessage('请先完成离线 FFT 分析再导出 CSV')
      return
    }
    setExporting(true)
    try {
      const result = await ensureExportClient().encodeSpectrumCsv(
        { result: activeAsset.analysis, includeHeader: true },
        { onProgress: ({ ratio }) => setExportProgress(ratio) },
      )
      downloadBytes(result.bytes, result.mimeType, `${safeBaseName(activeAsset.metadata.name)}-spectrum.${result.fileExtension}`)
      setStatusMessage(`CSV 导出完成 · ${result.rowCount.toLocaleString()} 行`)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'CSV 导出失败')
    } finally {
      setExporting(false)
      setExportProgress(0)
    }
  }, [activeAsset, ensureExportClient])

  const handleJsonExport = useCallback(() => {
    if (!activeAsset?.analysis) {
      setErrorMessage('请先完成离线 FFT 分析再导出 JSON')
      return
    }
    const result = activeAsset.analysis
    const json = JSON.stringify({
      schemaVersion: 1,
      source: activeAsset.metadata,
      analysis: {
        sampleRate: result.sampleRate,
        fftSize: result.fftSize,
        hopSize: result.hopSize,
        window: result.window,
        channelMode: result.channelMode,
        range: result.range,
        minDb: result.minDb,
        maxDb: result.maxDb,
        frameCount: result.frameCount,
        binCount: result.binCount,
        timesSeconds: Array.from(result.timesSeconds),
        frequenciesHz: Array.from(result.frequenciesHz),
        valuesDbfs: Array.from(result.valuesDbfs),
      },
    })
    downloadText(json, 'application/json;charset=utf-8', `${safeBaseName(activeAsset.metadata.name)}-analysis.json`)
  }, [activeAsset])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target
      if (
        target instanceof HTMLElement
        && (
          target.isContentEditable
          || target.matches('input, select, textarea, button, a[href], [role="button"]')
        )
      ) return
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault()
        fileInputRef.current?.click()
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'e') {
        event.preventDefault()
        if (activeAsset) setExportDialogOpen(true)
        return
      }
      if (event.code === 'Space') {
        event.preventDefault()
        if (event.shiftKey) ensureEngine().stop()
        else playPause()
      } else if (event.key.toLowerCase() === 'l' && activeAsset) {
        ensureEngine().setLoop(!playback.loop)
      } else if (event.key.toLowerCase() === 'm' && activeAsset) {
        ensureEngine().toggleMuted()
      } else if (event.key === 'Escape' && activeAsset) {
        updateSelection(null)
      } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && activeAsset) {
        event.preventDefault()
        const direction = event.key === 'ArrowLeft' ? -1 : 1
        const seconds = event.shiftKey ? 10 : 1
        ensureEngine().seekSeconds(playback.positionSeconds + direction * seconds)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [activeAsset, ensureEngine, playback.loop, playback.positionSeconds, playPause, updateSelection])

  const assetSummaries = useMemo<AssetSummary[]>(() => assets.map((asset) => ({
    id: asset.id,
    name: asset.metadata.name,
    sizeBytes: asset.metadata.sizeBytes,
    duration: asset.metadata.durationSeconds,
    sampleRate: asset.metadata.sampleRate,
    channels: asset.metadata.numberOfChannels,
    mimeType: asset.metadata.mimeType,
    active: asset.id === activeId,
  })), [activeId, assets])

  const currentTimeForSpectrum = spectrumFrozen ? frozenTime : playback.positionSeconds
  const spectrumComparisonSeries = useMemo(() => {
    if (!activeAsset) return []
    const descriptors = describeChannelLayout(
      activeAsset.channelLayout,
      activeAsset.buffer.numberOfChannels,
    )
    const visibleChannels = new Set(activeAsset.visibleChannels)
    return realtimeChannelResults
      .filter(({ channelIndex }) => visibleChannels.has(channelIndex))
      .map(({ channelIndex, preview }) => ({
        channelIndex,
        label: descriptors[channelIndex]?.shortLabel ?? `CH ${channelIndex + 1}`,
        color: CHANNEL_SPECTRUM_COLORS[channelIndex % CHANNEL_SPECTRUM_COLORS.length]
          ?? CHANNEL_SPECTRUM_COLORS[0],
        result: preview,
      }))
  }, [activeAsset, realtimeChannelResults])
  const busy = importing || analyzing || exporting

  return (
    <div
      className="app-shell"
      onDragEnter={(event) => { event.preventDefault(); dragDepthRef.current += 1; setDropActive(true) }}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }}
      onDragLeave={(event) => { event.preventDefault(); dragDepthRef.current = Math.max(0, dragDepthRef.current - 1); if (dragDepthRef.current === 0) setDropActive(false) }}
      onDrop={(event) => { event.preventDefault(); dragDepthRef.current = 0; setDropActive(false); void handleFiles(event.dataTransfer.files) }}
    >
      <input
        ref={fileInputRef}
        type="file"
        hidden
        multiple
        accept="audio/*,.wav,.mp3,.ogg,.opus,.m4a,.aac,.flac"
        onChange={(event) => {
          if (event.target.files) void handleFiles(event.target.files)
          event.target.value = ''
        }}
      />
      <AppHeader
        hasAudio={Boolean(activeAsset)}
        busy={busy}
        onImport={() => fileInputRef.current?.click()}
        onExportWav={() => setExportDialogOpen(true)}
        onExportCsv={() => void handleCsvExport()}
        onExportJson={handleJsonExport}
      />

      <main className="app-main">
        <AssetSidebar
          assets={assetSummaries}
          onImport={() => fileInputRef.current?.click()}
          onActivate={activateAsset}
          onRemove={removeAsset}
          channelPanel={activeAsset ? (
            <ChannelPanel
              channelCount={activeAsset.buffer.numberOfChannels}
              visibleChannels={activeAsset.visibleChannels}
              mutedChannels={activeAsset.mutedChannels}
              soloChannels={activeAsset.soloChannels}
              layout={activeAsset.channelLayout}
              analysisChannel={config.channel}
              onToggleVisibility={toggleChannelVisibility}
              onIsolate={isolateChannel}
              onShowAll={showAllChannels}
              onResetVisible={resetVisibleChannels}
              onToggleMute={toggleChannelMute}
              onToggleSolo={toggleChannelSolo}
              onLayoutChange={changeChannelLayout}
            />
          ) : null}
        />

        <section className="workspace">
          <article className="workspace-panel">
            <header className="workspace-panel-header">
              <div className="workspace-panel-title"><AudioWaveform size={14} /> 波形 <span>{activeAsset ? `${activeAsset.metadata.numberOfChannels} CH · ${activeAsset.metadata.sampleRate} Hz` : 'NO SOURCE'}</span></div>
              <div className="workspace-panel-actions">
                {activeAsset?.selection && <span className="selection-chip">选区 {((activeAsset.selection.end - activeAsset.selection.start) / activeAsset.buffer.sampleRate).toFixed(3)}s</span>}
                <button className="mini-button" disabled={!activeAsset?.selection} onClick={() => waveformControlsRef.current?.zoomToSelection()}><ScanLine size={11} /> 选区</button>
                <button className="mini-button" disabled={!activeAsset} onClick={() => waveformControlsRef.current?.fit()}><Maximize2 size={11} /> 全长</button>
              </div>
            </header>
            <div className="workspace-panel-body">
              <WaveformCanvas
                key={activeAsset?.id ?? 'empty'}
                buffer={activeAsset?.buffer ?? null}
                peaks={activeAsset?.peaks ?? null}
                visibleChannels={activeAsset?.visibleChannels ?? []}
                currentSample={playback.positionSample}
                selection={activeAsset?.selection ?? null}
                onSeek={seekSample}
                onSelectionChange={updateSelection}
                onControlsReady={handleWaveformControlsReady}
              />
            </div>
          </article>

          <article className="workspace-panel">
            <nav className="analysis-tabs" aria-label="分析视图">
              <button className={analysisTab === 'spectrum' ? 'active' : ''} onClick={() => setAnalysisTab('spectrum')}><Waves size={13} /> 实时频谱</button>
              <button className={analysisTab === 'spectrogram' ? 'active' : ''} onClick={() => setAnalysisTab('spectrogram')}><ScanLine size={13} /> 二维声谱</button>
              <button className={analysisTab === '3d' ? 'active' : ''} onClick={() => setAnalysisTab('3d')}><Box size={13} /> FFT 3D</button>
              <div className="analysis-tab-meta">
                {analysisStale && <span className="stale-badge">参数已变更</span>}
                <span>{config.fftSize} FFT · {config.window.toUpperCase()}</span>
                {analysisTab === 'spectrum' && <button type="button" className={`freeze-button ${spectrumComparison ? 'active' : ''}`} aria-pressed={spectrumComparison} onClick={toggleSpectrumComparison}><Layers3 size={11} /> {spectrumComparison ? '多声道对比' : '单频谱'}</button>}
                {analysisTab === 'spectrum' && <button type="button" className={`freeze-button ${spectrumFrozen ? 'active' : ''}`} aria-pressed={spectrumFrozen} onClick={toggleSpectrumFreeze}><Snowflake size={11} /> {spectrumFrozen ? '已冻结' : '冻结'}</button>}
              </div>
            </nav>
            <div className="workspace-panel-body">
              {analysisTab === 'spectrum' && (
                <SpectrumCanvas
                  result={realtimeResult}
                  currentTime={currentTimeForSpectrum}
                  minDb={config.minDb}
                  maxDb={config.maxDb}
                  frequencyScale={config.frequencyScale}
                  frozen={spectrumFrozen}
                  comparisonEnabled={spectrumComparison}
                  comparisonSeries={spectrumComparisonSeries}
                />
              )}
              {analysisTab === 'spectrogram' && (
                <SpectrogramCanvas
                  result={activeAsset?.analysis ?? null}
                  currentTime={playback.positionSeconds}
                  minDb={config.minDb}
                  maxDb={config.maxDb}
                  frequencyScale={config.frequencyScale}
                />
              )}
              {analysisTab === '3d' && (
                <Suspense fallback={<div className="fft-3d-empty"><span className="spinner" /><strong>正在加载 3D 引擎…</strong></div>}>
                  <LazyFft3DView
                    result={activeAsset?.analysis ?? null}
                    currentTime={playback.positionSeconds}
                    minDb={config.minDb}
                    maxDb={config.maxDb}
                    frequencyScale={config.frequencyScale}
                    mode={mode3d}
                    quality={quality3d}
                    onResetReady={handle3dResetReady}
                  />
                </Suspense>
              )}
            </div>
          </article>

          {!activeAsset && (
            <div className="empty-workspace">
              <div className="empty-content">
                <div className="empty-visual"><AudioWaveform size={34} /></div>
                <span className="eyebrow">LOCAL AUDIO LAB</span>
                <h1>从一段声音开始分析</h1>
                <p>导入本地音频，同步观察时域波形、实时频谱、二维声谱和 FFT 三维结构。所有音频默认只在当前浏览器中处理。</p>
                <div className="empty-actions"><button className="primary-button" onClick={() => fileInputRef.current?.click()}><FolderOpen size={15} /> 选择音频文件</button></div>
                <span className="privacy-line"><ShieldCheck size={13} /> 不上传、不修改源文件、可随时清除</span>
              </div>
            </div>
          )}
        </section>

        <AnalysisControls
          config={config}
          sampleRate={activeAsset?.buffer.sampleRate ?? null}
          numberOfChannels={activeAsset?.buffer.numberOfChannels ?? 0}
          disabled={!activeAsset || importing}
          analyzing={analyzing}
          progress={analysisProgress}
          mode3d={mode3d}
          quality3d={quality3d}
          onConfigChange={handleConfigChange}
          onAnalyze={requestAnalysis}
          onCancelAnalyze={cancelAnalysis}
          onMode3dChange={setMode3d}
          onQuality3dChange={setQuality3d}
          onReset3d={() => reset3dRef.current?.()}
        />
      </main>

      <Transport
        hasAudio={Boolean(activeAsset)}
        playing={playback.kind === 'playing'}
        currentTime={playback.positionSeconds}
        duration={playback.durationSeconds}
        volume={playback.volume}
        muted={playback.muted}
        loop={playback.loop}
        playbackRate={playback.playbackRate}
        onPlayPause={playPause}
        onStop={() => ensureEngine().stop()}
        onSeek={(time) => ensureEngine().seekSeconds(time)}
        onVolumeChange={(volume) => ensureEngine().setVolume(volume)}
        onToggleMute={() => ensureEngine().toggleMuted()}
        onToggleLoop={() => ensureEngine().setLoop(!playback.loop)}
        onRateChange={(rate) => ensureEngine().setPlaybackRate(rate)}
      />

      <DropOverlay active={dropActive} />
      <ExportDialog
        open={exportDialogOpen && Boolean(activeAsset)}
        assetName={activeAsset?.metadata.name ?? ''}
        durationSeconds={activeAsset?.metadata.durationSeconds ?? 0}
        sampleRate={activeAsset?.buffer.sampleRate ?? 1}
        channels={activeAsset?.buffer.numberOfChannels ?? 1}
        selection={activeAsset?.selection ?? null}
        busy={exporting}
        progress={exportProgress}
        onClose={() => setExportDialogOpen(false)}
        onCancel={cancelExport}
        onExport={(request) => void handleWavExport(request)}
      />

      {statusMessage && <div className="loading-toast">{busy && <span className="spinner" />}<span>{statusMessage}</span>{importing && <button className="toast-action" onClick={cancelImport}>取消</button>}</div>}
      {errorMessage && <button className="error-toast" onClick={() => setErrorMessage(null)}><span>{errorMessage}</span></button>}
    </div>
  )
}
