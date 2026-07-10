import { AudioLines, ChevronDown, Download, FileAudio, ShieldCheck, Upload } from 'lucide-react'

interface AppHeaderProps {
  hasAudio: boolean
  busy: boolean
  onImport: () => void
  onExportWav: () => void
  onExportCsv: () => void
  onExportJson: () => void
}

export function AppHeader({
  hasAudio,
  busy,
  onImport,
  onExportWav,
  onExportCsv,
  onExportJson,
}: AppHeaderProps) {
  return (
    <header className="app-header panel-surface">
      <div className="brand">
        <div className="brand-mark"><AudioLines size={22} /></div>
        <div><strong>WebAudioKit</strong><span>ANALYSIS WORKSTATION</span></div>
      </div>
      <div className="header-center">
        <span className="local-badge"><ShieldCheck size={13} /> 本地处理</span>
        <span className="header-status"><span className={busy ? 'status-dot busy' : 'status-dot'} /> {busy ? '正在计算' : '系统就绪'}</span>
      </div>
      <div className="header-actions">
        <button className="secondary-button" onClick={onImport}><Upload size={15} /> 导入音频</button>
        <div className="export-menu">
          <button className="primary-button" disabled={!hasAudio || busy}><Download size={15} /> 导出 <ChevronDown size={13} /></button>
          <div className="export-popover">
            <button onClick={onExportWav}><FileAudio size={15} /><span><strong>WAV 音频</strong><small>全文件或当前选区</small></span></button>
            <button onClick={onExportCsv}><Download size={15} /><span><strong>频谱 CSV</strong><small>时间、频率与 dBFS</small></span></button>
            <button onClick={onExportJson}><Download size={15} /><span><strong>分析 JSON</strong><small>包含参数与数据矩阵</small></span></button>
          </div>
        </div>
      </div>
    </header>
  )
}
