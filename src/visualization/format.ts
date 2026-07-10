export function formatTime(seconds: number, precise = false): string {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  const minutes = Math.floor(safeSeconds / 60)
  const remainder = safeSeconds - minutes * 60
  return precise
    ? `${String(minutes).padStart(2, '0')}:${remainder.toFixed(3).padStart(6, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(Math.floor(remainder)).padStart(2, '0')}`
}
