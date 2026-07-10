import { Activity, BarChart3, Box, Gauge, RotateCcw, Square, Waves } from 'lucide-react'
import type {
  OverlapRatio,
  SupportedFftSize,
  WindowName,
  WorkspaceAnalysisConfig,
} from '../workspaceTypes'
import type { Fft3DMode, Fft3DQuality } from './Fft3DView'

interface AnalysisControlsProps {
  config: WorkspaceAnalysisConfig
  sampleRate: number | null
  numberOfChannels: number
  disabled: boolean
  analyzing: boolean
  progress: number
  mode3d: Fft3DMode
  quality3d: Fft3DQuality
  onConfigChange: (config: WorkspaceAnalysisConfig) => void
  onAnalyze: () => void
  onCancelAnalyze: () => void
  onMode3dChange: (mode: Fft3DMode) => void
  onQuality3dChange: (quality: Fft3DQuality) => void
  onReset3d: () => void
}

const FFT_SIZES: SupportedFftSize[] = [512, 1024, 2048, 4096, 8192, 16384, 32768]

export function AnalysisControls({
  config,
  sampleRate,
  numberOfChannels,
  disabled,
  analyzing,
  progress,
  mode3d,
  quality3d,
  onConfigChange,
  onAnalyze,
  onCancelAnalyze,
  onMode3dChange,
  onQuality3dChange,
  onReset3d,
}: AnalysisControlsProps) {
  const update = <Key extends keyof WorkspaceAnalysisConfig>(
    key: Key,
    value: WorkspaceAnalysisConfig[Key],
  ) => onConfigChange({ ...config, [key]: value })
  const hopSize = Math.round(config.fftSize * (1 - config.overlap))
  const binWidth = sampleRate ? sampleRate / config.fftSize : 0
  const windowDuration = sampleRate ? (config.fftSize / sampleRate) * 1000 : 0
  const channelCount = Math.max(0, Math.trunc(numberOfChannels))
  const selectedChannel = typeof config.channel === 'number'
    && config.channel >= 0
    && config.channel < channelCount
    ? String(config.channel)
    : 'mix'

  return (
    <aside className="inspector panel-surface">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">ANALYSIS</span>
          <h2>分析参数</h2>
        </div>
        <Gauge size={17} aria-hidden="true" />
      </div>

      <section className="inspector-section">
        <div className="section-title"><Activity size={14} /> FFT / STFT</div>
        <label className="field-label">
          <span>FFT Size</span>
          <select
            value={config.fftSize}
            disabled={disabled}
            onChange={(event) => update('fftSize', Number(event.target.value) as SupportedFftSize)}
          >
            {FFT_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </label>
        <label className="field-label">
          <span>窗函数</span>
          <select
            value={config.window}
            disabled={disabled}
            onChange={(event) => update('window', event.target.value as WindowName)}
          >
            <option value="hann">Hann</option>
            <option value="hamming">Hamming</option>
            <option value="blackman">Blackman</option>
          </select>
        </label>
        <label className="field-label">
          <span>重叠率</span>
          <select
            value={config.overlap}
            disabled={disabled}
            onChange={(event) => update('overlap', Number(event.target.value) as OverlapRatio)}
          >
            <option value={0}>0%</option>
            <option value={0.5}>50%</option>
            <option value={0.75}>75%</option>
            <option value={0.875}>87.5%</option>
          </select>
        </label>
        <label className="field-label">
          <span>分析声道</span>
          <select
            value={selectedChannel}
            disabled={disabled}
            onChange={(event) => update(
              'channel',
              event.target.value === 'mix' ? 'mix' : Number(event.target.value),
            )}
          >
            <option value="mix">混合（平均）</option>
            {Array.from({ length: channelCount }, (_, channelIndex) => (
              <option key={channelIndex} value={channelIndex}>
                Channel {channelIndex + 1}
              </option>
            ))}
          </select>
        </label>
        <div className="metric-grid">
          <div><span>Bin 宽度</span><strong>{binWidth ? `${binWidth.toFixed(2)} Hz` : '—'}</strong></div>
          <div><span>时间窗</span><strong>{windowDuration ? `${windowDuration.toFixed(1)} ms` : '—'}</strong></div>
          <div><span>Hop Size</span><strong>{hopSize}</strong></div>
          <div><span>更新率</span><strong>{sampleRate ? `${(sampleRate / hopSize).toFixed(1)} fps` : '—'}</strong></div>
        </div>
      </section>

      <section className="inspector-section">
        <div className="section-title"><Waves size={14} /> 显示范围</div>
        <div className="segmented compact">
          <button
            className={config.frequencyScale === 'log' ? 'active' : ''}
            onClick={() => update('frequencyScale', 'log')}
          >对数频率</button>
          <button
            className={config.frequencyScale === 'linear' ? 'active' : ''}
            onClick={() => update('frequencyScale', 'linear')}
          >线性频率</button>
        </div>
        <div className="range-fields">
          <label><span>最低 dBFS</span><input type="number" min={-180} max={-10} value={config.minDb} disabled={disabled} onChange={(event) => update('minDb', Number(event.target.value))} /></label>
          <label><span>最高 dBFS</span><input type="number" min={-20} max={0} value={config.maxDb} disabled={disabled} onChange={(event) => update('maxDb', Number(event.target.value))} /></label>
        </div>
      </section>

      <section className="inspector-section">
        <div className="section-title"><Box size={14} /> FFT 3D</div>
        <div className="segmented triple">
          {(['surface', 'wireframe', 'waterfall'] as const).map((mode) => (
            <button key={mode} className={mode3d === mode ? 'active' : ''} onClick={() => onMode3dChange(mode)}>
              {{ surface: '曲面', wireframe: '线框', waterfall: '瀑布' }[mode]}
            </button>
          ))}
        </div>
        <label className="field-label">
          <span>渲染质量</span>
          <select value={quality3d} onChange={(event) => onQuality3dChange(event.target.value as Fft3DQuality)}>
            <option value="low">低 · 72²</option>
            <option value="medium">中 · 112²</option>
            <option value="high">高 · 160²</option>
          </select>
        </label>
        <button className="secondary-button full-width" onClick={onReset3d}>
          <RotateCcw size={14} /> 重置相机
        </button>
      </section>

      <div className="analysis-action-wrap">
        <button
          className={`primary-button full-width ${analyzing ? 'cancel-action' : ''}`}
          disabled={disabled}
          onClick={analyzing ? onCancelAnalyze : onAnalyze}
        >
          {analyzing ? <Square size={14} fill="currentColor" /> : <BarChart3 size={16} />}
          {analyzing ? `取消分析 · ${Math.round(progress * 100)}%` : '重新分析'}
        </button>
        {analyzing && <div className="progress-track"><span style={{ width: `${Math.max(2, progress * 100)}%` }} /></div>}
        <small>分析在本地 Worker 中完成，不上传音频。</small>
      </div>
    </aside>
  )
}
