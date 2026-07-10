import { Activity, Eye, EyeOff, Focus, Layers3 } from 'lucide-react'
import type { AnalysisChannel } from '../workspaceTypes'

interface ChannelPanelProps {
  channelCount: number
  visibleChannels: readonly number[]
  analysisChannel: AnalysisChannel
  onToggleVisibility: (channelIndex: number) => void
  onIsolate: (channelIndex: number) => void
  onShowAll: () => void
  onResetVisible: () => void
}

export function ChannelPanel({
  channelCount,
  visibleChannels,
  analysisChannel,
  onToggleVisibility,
  onIsolate,
  onShowAll,
  onResetVisible,
}: ChannelPanelProps) {
  const normalizedChannelCount = Math.max(0, Math.trunc(channelCount))
  const channels = Array.from({ length: normalizedChannelCount }, (_, index) => index)
  const visibleChannelSet = new Set(visibleChannels)
  const analysisLabel = analysisChannel === 'mix'
    ? '混合（平均）'
    : `Channel ${analysisChannel + 1}`

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
        <span>当前 FFT：{analysisLabel}</span>
      </p>

      <div className="channel-panel-actions">
        <button
          type="button"
          className="secondary-button"
          disabled={normalizedChannelCount === 0}
          onClick={onShowAll}
          aria-label={`显示全部 ${normalizedChannelCount} 个声道的波形`}
        >
          全部显示
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={normalizedChannelCount === 0}
          onClick={onResetVisible}
          aria-label="恢复默认波形显示，仅显示前两个声道"
        >
          默认前二
        </button>
      </div>

      {normalizedChannelCount === 0 ? (
        <p className="channel-panel-empty">导入音频后可选择声道。</p>
      ) : (
        <ul className="channel-list" aria-label={`音频声道，共 ${normalizedChannelCount} 个`}>
          {channels.map((channelIndex) => {
            const isVisible = visibleChannelSet.has(channelIndex)
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
                  aria-label={`${isVisible ? '隐藏' : '显示'} ${channelLabel} 波形`}
                  aria-pressed={isVisible}
                  onClick={() => onToggleVisibility(channelIndex)}
                >
                  {isVisible
                    ? <Eye size={14} aria-hidden="true" />
                    : <EyeOff size={14} aria-hidden="true" />}
                </button>

                <span className="channel-name">{channelLabel}</span>

                {isAnalysisChannel && (
                  <span className="channel-analysis-badge" aria-label={`${channelLabel} 是当前 FFT 分析声道`}>
                    <Activity size={12} aria-hidden="true" /> FFT
                  </span>
                )}

                <button
                  type="button"
                  className="channel-isolate-button"
                  aria-label={`仅显示 ${channelLabel} 波形`}
                  title={`仅显示 ${channelLabel}`}
                  onClick={() => onIsolate(channelIndex)}
                >
                  <Focus size={13} aria-hidden="true" />
                  独显
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
