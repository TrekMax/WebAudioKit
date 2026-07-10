import { describe, expect, it } from 'vitest'

import {
  calculatePeakNormalizationGain,
  encodeWav,
  findPeak,
  getWavEncodingInfo,
  type PlanarPcmData,
} from './wav'

function pcm(channels: number[][], sampleRate = 48_000): PlanarPcmData {
  return {
    sampleRate,
    channels: channels.map((channel) => Float32Array.from(channel)),
  }
}

function ascii(view: DataView, offset: number, length: number): string {
  return String.fromCharCode(
    ...Array.from({ length }, (_, index) => view.getUint8(offset + index)),
  )
}

function readPcm24(view: DataView, offset: number): number {
  let value =
    view.getUint8(offset) |
    (view.getUint8(offset + 1) << 8) |
    (view.getUint8(offset + 2) << 16)
  if ((value & 0x800000) !== 0) {
    value -= 0x1000000
  }
  return value
}

describe('encodeWav', () => {
  it('writes a valid PCM16 header and exact interleaved selection', () => {
    const source = pcm([
      [-1, -0.5, 0, 0.5, 1],
      [1, 0.25, -0.25, -1, 0],
    ])

    const output = encodeWav(source, {
      format: 'pcm16',
      range: { start: 1, end: 3 },
    })
    const view = new DataView(output)

    expect(ascii(view, 0, 4)).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(44)
    expect(ascii(view, 8, 4)).toBe('WAVE')
    expect(ascii(view, 12, 4)).toBe('fmt ')
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(2)
    expect(view.getUint32(24, true)).toBe(48_000)
    expect(view.getUint32(28, true)).toBe(192_000)
    expect(view.getUint16(32, true)).toBe(4)
    expect(view.getUint16(34, true)).toBe(16)
    expect(ascii(view, 36, 4)).toBe('data')
    expect(view.getUint32(40, true)).toBe(8)
    expect(output.byteLength).toBe(52)

    expect([
      view.getInt16(44, true),
      view.getInt16(46, true),
      view.getInt16(48, true),
      view.getInt16(50, true),
    ]).toEqual([-16_384, 8_192, 0, -8_192])
  })

  it('maps PCM24 positive and negative full scale without overflow', () => {
    const view = new DataView(encodeWav(pcm([[-1, 0, 1]]), { format: 'pcm24' }))

    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(34, true)).toBe(24)
    expect(view.getUint32(40, true)).toBe(9)
    expect(readPcm24(view, 44)).toBe(-8_388_608)
    expect(readPcm24(view, 47)).toBe(0)
    expect(readPcm24(view, 50)).toBe(8_388_607)
  })

  it('writes IEEE Float32 data and sanitizes non-finite samples', () => {
    const source: PlanarPcmData = {
      sampleRate: 44_100,
      channels: [Float32Array.of(1.25, Number.NaN, Number.POSITIVE_INFINITY, -1.5)],
    }
    const view = new DataView(encodeWav(source, { format: 'float32' }))

    expect(view.getUint16(20, true)).toBe(3)
    expect(view.getUint16(34, true)).toBe(32)
    expect(view.getFloat32(44, true)).toBe(1.25)
    expect(view.getFloat32(48, true)).toBe(0)
    expect(view.getFloat32(52, true)).toBe(0)
    expect(view.getFloat32(56, true)).toBe(-1.5)
  })

  it('preserves all eight source channels and their interleaved order', () => {
    const source = pcm(Array.from(
      { length: 8 },
      (_, channelIndex) => [channelIndex / 10],
    ))
    const view = new DataView(encodeWav(source, { format: 'float32' }))

    expect(view.getUint16(22, true)).toBe(8)
    expect(view.getUint16(32, true)).toBe(32)
    expect(view.getUint32(40, true)).toBe(32)
    expect(Array.from(
      { length: 8 },
      (_, channelIndex) => view.getFloat32(44 + channelIndex * 4, true),
    )).toEqual(Array.from({ length: 8 }, (_, channelIndex) => (
      expect.closeTo(channelIndex / 10, 6)
    )))
  })

  it('normalizes all channels against the selected global peak', () => {
    const source = pcm([
      [0.1, 0.25, 0.1],
      [-0.2, 0.05, 0.1],
    ])
    const targetPeakDbfs = -6.020599913279624
    const info = getWavEncodingInfo(source, {
      format: 'float32',
      range: { start: 0, end: 2 },
      normalize: true,
      targetPeakDbfs,
    })

    expect(info.peak).toBeCloseTo(0.25)
    expect(info.gain).toBeCloseTo(2)

    const view = new DataView(
      encodeWav(source, {
        format: 'float32',
        range: { start: 0, end: 2 },
        normalize: true,
        targetPeakDbfs,
      }),
    )
    expect(view.getFloat32(44, true)).toBeCloseTo(0.2)
    expect(view.getFloat32(48, true)).toBeCloseTo(-0.4)
    expect(view.getFloat32(52, true)).toBeCloseTo(0.5)
    expect(view.getFloat32(56, true)).toBeCloseTo(0.1)
  })

  it('keeps silent normalization at unity gain and permits an empty range', () => {
    const source = pcm([[0, 0]])

    expect(calculatePeakNormalizationGain(0, -1)).toBe(1)
    expect(getWavEncodingInfo(source, { normalize: true }).gain).toBe(1)

    const output = encodeWav(source, { range: { start: 1, end: 1 } })
    const view = new DataView(output)
    expect(output.byteLength).toBe(44)
    expect(view.getUint32(40, true)).toBe(0)
  })

  it('finds finite peaks in a half-open sample range', () => {
    const source: PlanarPcmData = {
      sampleRate: 8_000,
      channels: [Float32Array.of(Number.NaN, -0.75, 1, 0.25)],
    }

    expect(findPeak(source, { start: 0, end: 2 })).toBe(0.75)
    expect(findPeak(source, { start: 2, end: 4 })).toBe(1)
  })

  it('rejects invalid ranges, channel layouts, and normalization targets', () => {
    const source = pcm([[0, 0], [0, 0]])

    expect(() => encodeWav(source, { range: { start: 0, end: 3 } })).toThrow(RangeError)
    expect(() => encodeWav(source, { range: { start: 1.5, end: 2 } })).toThrow(RangeError)
    expect(() => encodeWav(source, { normalize: true, targetPeakDbfs: 1 })).toThrow(RangeError)
    expect(() =>
      encodeWav({
        sampleRate: 48_000,
        channels: [Float32Array.of(0), Float32Array.of(0, 1)],
      }),
    ).toThrow(RangeError)
  })
})
