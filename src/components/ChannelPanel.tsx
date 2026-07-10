import { Activity, Eye, EyeOff, Focus, Layers3 } from 'lucide-react'
import {
  channelLayoutOptions,
  describeChannelLayout,
  type ChannelLayoutPreset,
} from '../audio/channelLayout'
import type { AnalysisChannel } from '../workspaceTypes'

interface ChannelPanelProps {
  channelCount: number
  visibleChannels: readonly number[]
  mutedChannels: readonly number[]
  soloChannels: readonly number[]
  layout: ChannelLayoutPreset
  analysisChannel: AnalysisChannel
  onToggleVisibility: (channelIndex: number) => void
  onIsolate: (channelIndex: number) => void
  onShowAll: () => void
  onResetVisible: () => void
  onToggleMute: (channelIndex: number) => void
  onToggleSolo: (channelIndex: number) => void
  onLayoutChange: (layout: ChannelLayoutPreset) => void
}

export function ChannelPanel({
  channelCount,
  visibleChannels,
  mutedChannels,
  soloChannels,
  layout,
  analysisChannel,
  onToggleVisibility,
  onIsolate,
  onShowAll,
  onResetVisible,
  onToggleMute,
  onToggleSolo,
  onLayoutChange,
}: ChannelPanelProps) {
  const normalizedChannelCount = Math.max(0, Math.trunc(channelCount))
  const channels = describeChannelLayout(layout, normalizedChannelCount)
  const visibleChannelSet = new Set(visibleChannels)
  const mutedChannelSet = new Set(mutedChannels)
  const soloChannelSet = new Set(soloChannels)
  const layoutOptions = channelLayoutOptions(normalizedChannelCount)
  const analysisLabel = analysisChannel === 'mix'
    ? '混合（平均）'
    : (channels[analysisChannel]?.shortLabel ?? `Channel ${analysisChannel + 1}`)

  return (
    <section className="channel-panel" aria-labelledby="channel-panel-title">
      <div className="channel-panel-heading">
        <div>
          <span className="eyebrow">CHANNELS</span>
          <h3 id="channel-panel-title">声道</h3>
        </div>
        <Layers3 size={16} aria-hidden="true" />
      </div>

      <p className="channel-analysis-summary">
        <Activity size={13} aria-hidden="true" />
        <span>当前离线 FFT：{analysisLabel}</span>
      </p>

      <label className="channel-layout-field">
        <span>声道布局</span>
        <select
          value={layout}
          onChange={(event) => onLayoutChange(event.target.value as ChannelLayoutPreset)}
        >
          {layoutOptions.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>

      <div className="channel-panel-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={normalizedChannelCount === 0}
          onClick={onShowAll}
          aria-label={`显示全部 ${normalizedChannelCount} 个声道的波形与实时频谱对比`}
        >
          全部显示
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={normalizedChannelCount === 0}
          onClick={onResetVisible}
          aria-label="恢复默认显示，仅显示前两个声道的波形与实时频谱对比"
        >
          默认前二
        </button>
      </div>

      {normalizedChannelCount === 0 ? (
        <p className="channel-panel-empty">导入音频后可选择声道。</p>
      ) : (
        <ul className="channel-list" aria-label={`音频声道，共 ${normalizedChannelCount} 个`}>
          {channels.map((channel) => {
            const channelIndex = channel.sourceIndex
            const isVisible = visibleChannelSet.has(channelIndex)
            const isMuted = mutedChannelSet.has(channelIndex)
            const isSolo = soloChannelSet.has(channelIndex)
            const isAnalysisChannel = analysisChannel === channelIndex
            const channelLabel = `Channel ${channelIndex + 1}`

            return (
              <li
                key={channelIndex}
                className={`channel-row${isAnalysisChannel ? ' analysis-active' : ''}`}
              >
                <button
                  type="button"
                  className={`icon-button small${isVisible ? ' active' : ''}`}
                  aria-label={`${isVisible ? '隐藏' : '显示'} ${channelLabel} 波形与实时频谱对比`}
                  aria-pressed={isVisible}
                  onClick={() => onToggleVisibility(channelIndex)}
                >
                  {isVisible
                    ? <Eye size={14} aria-hidden="true" />
                    : <EyeOff size={14} aria-hidden="true" />}
                </button>

                <span className="channel-name" title={`${channelLabel} · ${channel.label}`}>
                  <strong>{channel.shortLabel}</strong>
                  <small>{channel.label}</small>
                </span>

                {isAnalysisChannel && (
                  <span className="channel-analysis-badge" aria-label={`${channelLabel} 是当前 FFT 分析声道`}>
                    <Activity size={12} aria-hidden="true" /> FFT
                  </span>
                )}

                <span className="channel-row-actions">
                  <button
                    type="button"
                    className={`channel-state-button mute${isMuted ? ' active' : ''}`}
                    aria-label={`${isMuted ? '取消静音' : '静音'} ${channelLabel}`}
                    aria-pressed={isMuted}
                    onClick={() => onToggleMute(channelIndex)}
                  >M</button>
                  <button
                    type="button"
                    className={`channel-state-button solo${isSolo ? ' active' : ''}`}
                    aria-label={`${isSolo ? '取消独奏' : '独奏'} ${channelLabel}`}
                    aria-pressed={isSolo}
                    onClick={() => onToggleSolo(channelIndex)}
                  >S</button>
                  <button
                    type="button"
                    className="channel-isolate-button"
                    aria-label={`仅显示 ${channelLabel} 波形与实时频谱对比`}
                    title={`仅显示 ${channelLabel}`}
                    onClick={() => onIsolate(channelIndex)}
                  >
                    <Focus size={13} aria-hidden="true" />
                    独显
                  </button>
                </span>
              </li>
            )
          })}
        </ul>
      )}
      <p className="channel-routing-note">显示仅控制波形与对比频谱；M/S 仅控制监听，不改变分析数据或 WAV 导出。</p>
    </section>
  )
}
