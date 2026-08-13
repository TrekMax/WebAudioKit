import {
  AudioLines,
  Atom,
  BookOpen,
  ChevronDown,
  Download,
  FileAudio,
  ShieldCheck,
  SlidersHorizontal,
  Upload,
  Waves,
} from 'lucide-react'
import { ThemeSwitcher } from './ThemeSwitcher'

export type AppPage = 'analysis' | 'filters' | 'wiki' | 'signal-knowledge'

interface AppHeaderProps {
  hasAudio: boolean
  busy: boolean
  activePage: AppPage
  onImport: () => void
  onPageChange: (page: AppPage) => void
  onExportWav: () => void
  onExportCsv: () => void
  onExportJson: () => void
}

export function AppHeader({
  hasAudio,
  busy,
  activePage,
  onImport,
  onPageChange,
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
        <nav className="workspace-navigation" aria-label="工作页面">
          <button type="button" className={activePage === 'analysis' ? 'active' : ''} aria-current={activePage === 'analysis' ? 'page' : undefined} onClick={() => onPageChange('analysis')}><Waves size={15} /> 分析工作台</button>
          <button type="button" className={activePage === 'filters' ? 'active' : ''} aria-current={activePage === 'filters' ? 'page' : undefined} onClick={() => onPageChange('filters')}><SlidersHorizontal size={15} /> 音效节点编辑器</button>
          <button type="button" className={activePage === 'wiki' ? 'active' : ''} aria-current={activePage === 'wiki' ? 'page' : undefined} onClick={() => onPageChange('wiki')}><BookOpen size={15} /> 音频知识图谱</button>
          <button type="button" className={activePage === 'signal-knowledge' ? 'active' : ''} aria-current={activePage === 'signal-knowledge' ? 'page' : undefined} onClick={() => onPageChange('signal-knowledge')}><Atom size={15} /> 信号处理图解</button>
        </nav>
        <span className="header-runtime-status">
          <span className="local-badge"><ShieldCheck size={13} /> 本地处理</span>
          <span className="header-status"><span className={busy ? 'status-dot busy' : 'status-dot'} /> {busy ? '正在计算' : '系统就绪'}</span>
        </span>
      </div>
      <div className="header-actions">
        <ThemeSwitcher />
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
