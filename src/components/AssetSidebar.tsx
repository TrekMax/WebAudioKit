import { FileAudio2, HardDrive, Info, Music2, Plus, Radio, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { formatTime } from '../visualization/format'

export interface AssetSummary {
  id: string
  name: string
  sizeBytes: number
  duration: number
  sampleRate: number
  channels: number
  mimeType: string
  active: boolean
}

interface AssetSidebarProps {
  assets: AssetSummary[]
  onImport: () => void
  onActivate: (id: string) => void
  onRemove: (id: string) => void
  channelPanel?: ReactNode
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

export function AssetSidebar({
  assets,
  onImport,
  onActivate,
  onRemove,
  channelPanel,
}: AssetSidebarProps) {
  const active = assets.find((asset) => asset.active)
  return (
    <aside className="asset-sidebar panel-surface">
      <div className="panel-heading sidebar-heading">
        <div><span className="eyebrow">PROJECT</span><h2>音频资源</h2></div>
        <button className="icon-button small" title="导入音频" onClick={onImport}><Plus size={15} /></button>
      </div>
      <div className="asset-list">
        {assets.length === 0 ? (
          <button className="asset-empty" onClick={onImport}>
            <Music2 size={22} />
            <strong>尚无音频</strong>
            <span>拖入文件或点击导入</span>
          </button>
        ) : assets.map((asset) => (
          <div
            key={asset.id}
            className={`asset-item ${asset.active ? 'active' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => onActivate(asset.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onActivate(asset.id)
              }
            }}
          >
            <span className="asset-icon"><FileAudio2 size={16} /></span>
            <span className="asset-copy"><strong title={asset.name}>{asset.name}</strong><small>{formatTime(asset.duration)} · {asset.channels} ch</small></span>
            <button className="asset-remove" title="关闭资源" onClick={(event) => { event.stopPropagation(); onRemove(asset.id) }}><X size={13} /></button>
          </div>
        ))}
      </div>
      {channelPanel}
      <div className="sidebar-spacer" />
      {active && (
        <section className="asset-metadata">
          <div className="section-title"><Info size={14} /> 资源信息</div>
          <dl>
            <div><dt>时长</dt><dd>{formatTime(active.duration, true)}</dd></div>
            <div><dt>采样率</dt><dd>{(active.sampleRate / 1000).toFixed(1)} kHz</dd></div>
            <div><dt>声道</dt><dd>{active.channels === 1 ? 'Mono' : active.channels === 2 ? 'Stereo' : `${active.channels} ch`}</dd></div>
            <div><dt>文件大小</dt><dd>{formatBytes(active.sizeBytes)}</dd></div>
            <div><dt>解码 PCM</dt><dd>{formatBytes(active.duration * active.sampleRate * active.channels * 4)}</dd></div>
          </dl>
          <div className="metadata-note"><HardDrive size={13} /> 会话内存缓冲</div>
        </section>
      )}
      <div className="sidebar-footer"><Radio size={13} /><span>LOCAL SESSION</span></div>
    </aside>
  )
}
