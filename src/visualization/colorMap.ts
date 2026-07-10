export type Rgb = readonly [number, number, number]

const STOPS: ReadonlyArray<readonly [number, Rgb]> = [
  [0, [7, 10, 20]],
  [0.14, [28, 21, 74]],
  [0.32, [37, 67, 132]],
  [0.5, [28, 145, 168]],
  [0.68, [74, 207, 138]],
  [0.84, [235, 218, 83]],
  [1, [255, 111, 76]],
]

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

export function normalizeDb(value: number, minDb: number, maxDb: number): number {
  if (!Number.isFinite(value) || maxDb <= minDb) return 0
  return clamp01((value - minDb) / (maxDb - minDb))
}

export function spectrumColor(normalizedValue: number): Rgb {
  const value = clamp01(normalizedValue)
  for (let index = 1; index < STOPS.length; index += 1) {
    const current = STOPS[index]
    const previous = STOPS[index - 1]
    if (!current || !previous || value > current[0]) continue
    const span = current[0] - previous[0]
    const amount = span === 0 ? 0 : (value - previous[0]) / span
    return [
      Math.round(previous[1][0] + (current[1][0] - previous[1][0]) * amount),
      Math.round(previous[1][1] + (current[1][1] - previous[1][1]) * amount),
      Math.round(previous[1][2] + (current[1][2] - previous[1][2]) * amount),
    ]
  }
  return STOPS.at(-1)?.[1] ?? [255, 111, 76]
}

export function spectrumCss(value: number, minDb: number, maxDb: number): string {
  const [red, green, blue] = spectrumColor(normalizeDb(value, minDb, maxDb))
  return `rgb(${red} ${green} ${blue})`
}
