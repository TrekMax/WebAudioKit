import { FileAudio2, UploadCloud } from 'lucide-react'

interface DropOverlayProps {
  active: boolean
}

export function DropOverlay({ active }: DropOverlayProps) {
  if (!active) return null
  return (
    <div className="drop-overlay">
      <div className="drop-card">
        <span className="drop-icon"><UploadCloud size={34} /></span>
        <strong>释放以导入音频</strong>
        <span><FileAudio2 size={14} /> WAV、MP3、Ogg、AAC、FLAC（按浏览器能力）</span>
      </div>
    </div>
  )
}
