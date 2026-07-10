import { useState } from 'react'
import { Download, FileAudio2, X } from 'lucide-react'
import type { SampleSelection } from '../workspaceTypes'
import { formatTime } from '../visualization/format'
import type { WavSampleFormat } from '../audio/wav'

export interface WavExportRequest {
  scope: 'full' | 'selection'
  format: WavSampleFormat
  normalize: boolean
  targetPeakDbfs: number
}

interface ExportDialogProps {
  open: boolean
  assetName: string
  durationSeconds: number
  sampleRate: number
  channels: number
  selection: SampleSelection | null
  busy: boolean
  progress: number
  onClose: () => void
  onCancel: () => void
  onExport: (request: WavExportRequest) => void
}

function estimatedBytes(
  seconds: number,
  sampleRate: number,
  channels: number,
  format: WavSampleFormat,
): string {
  const bytesPerSample = format === 'pcm16' ? 2 : format === 'pcm24' ? 3 : 4
  const bytes = 44 + seconds * sampleRate * channels * bytesPerSample
  return bytes >= 1024 ** 2
    ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
    : `${Math.max(1, bytes / 1024).toFixed(1)} KB`
}

export function ExportDialog({
  open,
  assetName,
  durationSeconds,
  sampleRate,
  channels,
  selection,
  busy,
  progress,
  onClose,
  onCancel,
  onExport,
}: ExportDialogProps) {
  const [scope, setScope] = useState<'full' | 'selection'>('selection')
  const [format, setFormat] = useState<WavSampleFormat>('pcm16')
  const [normalize, setNormalize] = useState(false)
  const [targetPeakDbfs, setTargetPeakDbfs] = useState(-1)

  if (!open) return null
  const effectiveScope = selection ? scope : 'full'
  const selectionDuration = selection
    ? (selection.end - selection.start) / sampleRate
    : durationSeconds
  const exportDuration = effectiveScope === 'selection' ? selectionDuration : durationSeconds

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
      <section className="export-dialog" role="dialog" aria-modal="true" aria-labelledby="export-title">
        <header>
          <div><span className="eyebrow">LOCAL EXPORT</span><h2 id="export-title">导出 WAV 音频</h2></div>
          <button className="icon-button small" disabled={busy} aria-label="关闭导出窗口" onClick={onClose}><X size={15} /></button>
        </header>
        <div className="export-source"><FileAudio2 size={17} /><span><strong>{assetName}</strong><small>{formatTime(durationSeconds, true)} · {(sampleRate / 1000).toFixed(1)} kHz · {channels} ch</small></span></div>

        <div className="export-form">
          <fieldset>
            <legend>导出范围</legend>
            <label><input type="radio" name="scope" checked={effectiveScope === 'full'} onChange={() => setScope('full')} /> 完整音频</label>
            <label className={!selection ? 'disabled-option' : ''}><input type="radio" name="scope" disabled={!selection} checked={effectiveScope === 'selection'} onChange={() => setScope('selection')} /> 当前选区 {selection && <small>{formatTime(selectionDuration, true)}</small>}</label>
          </fieldset>
          <label className="dialog-field"><span>采样格式</span><select value={format} disabled={busy} onChange={(event) => setFormat(event.target.value as WavSampleFormat)}><option value="pcm16">PCM 16-bit</option><option value="pcm24">PCM 24-bit</option><option value="float32">IEEE Float 32-bit</option></select></label>
          <label className="check-field"><input type="checkbox" checked={normalize} disabled={busy} onChange={(event) => setNormalize(event.target.checked)} /><span><strong>峰值归一化</strong><small>扫描选区后应用统一增益</small></span></label>
          {normalize && <label className="dialog-field"><span>目标峰值</span><span className="unit-input"><input type="number" min={-12} max={0} step={0.1} value={targetPeakDbfs} onChange={(event) => setTargetPeakDbfs(Number(event.target.value))} /> dBFS</span></label>}
        </div>

        <div className="export-summary"><div><span>预计时长</span><strong>{formatTime(exportDuration, true)}</strong></div><div><span>预计大小</span><strong>{estimatedBytes(exportDuration, sampleRate, channels, format)}</strong></div><div><span>处理位置</span><strong>本机 Worker</strong></div></div>
        {busy && <div className="export-progress"><div className="progress-track"><span style={{ width: `${Math.max(2, progress * 100)}%` }} /></div><span>正在编码 {Math.round(progress * 100)}%</span></div>}
        <footer><button className="secondary-button" onClick={busy ? onCancel : onClose}>{busy ? '取消导出' : '取消'}</button><button className="primary-button" disabled={busy} onClick={() => onExport({ scope: effectiveScope, format, normalize, targetPeakDbfs })}><Download size={15} /> 开始导出</button></footer>
      </section>
    </div>
  )
}
