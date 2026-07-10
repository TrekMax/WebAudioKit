import {
  Pause,
  Play,
  Repeat2,
  RotateCcw,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { formatTime } from '../visualization/format'

interface TransportProps {
  hasAudio: boolean
  playing: boolean
  currentTime: number
  duration: number
  volume: number
  muted: boolean
  loop: boolean
  playbackRate: number
  onPlayPause: () => void
  onStop: () => void
  onSeek: (time: number) => void
  onVolumeChange: (volume: number) => void
  onToggleMute: () => void
  onToggleLoop: () => void
  onRateChange: (rate: number) => void
}

export function Transport({
  hasAudio,
  playing,
  currentTime,
  duration,
  volume,
  muted,
  loop,
  playbackRate,
  onPlayPause,
  onStop,
  onSeek,
  onVolumeChange,
  onToggleMute,
  onToggleLoop,
  onRateChange,
}: TransportProps) {
  return (
    <footer className="transport panel-surface">
      <div className="transport-buttons">
        <button className={`icon-button ${loop ? 'active' : ''}`} disabled={!hasAudio} title="循环选区 (L)" onClick={onToggleLoop}>
          <Repeat2 size={17} />
        </button>
        <button className="icon-button" disabled={!hasAudio} title="停止 (Shift+Space)" onClick={onStop}>
          <RotateCcw size={17} />
        </button>
        <button className="play-button" disabled={!hasAudio} title="播放/暂停 (Space)" onClick={onPlayPause}>
          {playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
        </button>
      </div>

      <div className="transport-timeline">
        <span className="time-code current">{formatTime(currentTime, true)}</span>
        <input
          className="timeline-slider"
          type="range"
          min={0}
          max={Math.max(0.001, duration)}
          step={duration ? 1 / 1000 : 0.001}
          value={Math.min(currentTime, duration || 0)}
          disabled={!hasAudio}
          aria-label="播放位置"
          onChange={(event) => onSeek(Number(event.target.value))}
          style={{ '--progress': `${duration ? (currentTime / duration) * 100 : 0}%` } as React.CSSProperties}
        />
        <span className="time-code">{formatTime(duration, true)}</span>
      </div>

      <div className="transport-options">
        <select value={playbackRate} disabled={!hasAudio} aria-label="播放速度" onChange={(event) => onRateChange(Number(event.target.value))}>
          <option value={0.5}>0.5×</option>
          <option value={0.75}>0.75×</option>
          <option value={1}>1.0×</option>
          <option value={1.25}>1.25×</option>
          <option value={1.5}>1.5×</option>
          <option value={2}>2.0×</option>
        </select>
        <button className="icon-button" disabled={!hasAudio} title={muted ? '取消静音' : '静音'} onClick={onToggleMute}>
          {muted ? <VolumeX size={17} /> : <Volume2 size={17} />}
        </button>
        <input
          className="volume-slider"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={muted ? 0 : volume}
          disabled={!hasAudio}
          aria-label="音量"
          onChange={(event) => onVolumeChange(Number(event.target.value))}
        />
      </div>
    </footer>
  )
}
