export const WAVEFORM_AXIS_HEIGHT = 24
export const MIN_WAVEFORM_CHANNEL_HEIGHT = 64

export function normalizeVisibleChannels(
  visibleChannels: readonly number[],
  numberOfChannels: number,
): number[] {
  if (!Number.isSafeInteger(numberOfChannels) || numberOfChannels <= 0) return []

  const normalized: number[] = []
  const seen = new Set<number>()
  for (const channelIndex of visibleChannels) {
    if (
      !Number.isSafeInteger(channelIndex)
      || channelIndex < 0
      || channelIndex >= numberOfChannels
      || seen.has(channelIndex)
    ) continue

    seen.add(channelIndex)
    normalized.push(channelIndex)
  }
  return normalized
}

export function calculateWaveformCanvasHeight(
  hostHeight: number,
  visibleChannelCount: number,
): number {
  const safeHostHeight = Number.isFinite(hostHeight)
    ? Math.max(0, Math.round(hostHeight))
    : 0
  const safeChannelCount = Number.isSafeInteger(visibleChannelCount)
    ? Math.max(0, visibleChannelCount)
    : 0
  return Math.max(
    safeHostHeight,
    WAVEFORM_AXIS_HEIGHT + safeChannelCount * MIN_WAVEFORM_CHANNEL_HEIGHT,
  )
}
