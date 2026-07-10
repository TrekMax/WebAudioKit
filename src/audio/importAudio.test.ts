import { describe, expect, it } from 'vitest'

import {
  AudioImportError,
  createQuickAudioFingerprint,
  importAudio,
  validateAudioFile,
  type AudioDecodeContext,
} from './importAudio'

const CHUNK_BYTES = 64 * 1024

function createAudioBuffer(
  length = 12_000,
  sampleRate = 48_000,
  numberOfChannels = 2,
): AudioBuffer {
  const channels = Array.from(
    { length: numberOfChannels },
    () => new Float32Array(length),
  )
  return {
    duration: length / sampleRate,
    length,
    numberOfChannels,
    sampleRate,
    getChannelData: (channel: number) => channels[channel],
  } as unknown as AudioBuffer
}

class FakeDecodeContext {
  decodedInput: ArrayBuffer | null = null
  decodeError: unknown = null

  constructor(readonly result: AudioBuffer) {}

  async decodeAudioData(audioData: ArrayBuffer): Promise<AudioBuffer> {
    this.decodedInput = audioData
    if (this.decodeError) {
      throw this.decodeError
    }
    return this.result
  }
}

function asDecodeContext(context: FakeDecodeContext): AudioDecodeContext {
  return context as unknown as AudioDecodeContext
}

async function expectedFingerprint(
  bytes: Uint8Array,
  lastModified: number,
): Promise<string> {
  const first = bytes.slice(0, Math.min(bytes.length, CHUNK_BYTES))
  const last = bytes.slice(Math.max(0, bytes.length - CHUNK_BYTES))
  const header = new ArrayBuffer(16)
  const view = new DataView(header)
  view.setBigUint64(0, BigInt(bytes.length), true)
  view.setBigUint64(8, BigInt(lastModified), true)

  const input = new Uint8Array(16 + first.length + last.length)
  input.set(new Uint8Array(header), 0)
  input.set(first, 16)
  input.set(last, 16 + first.length)

  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    input.buffer as ArrayBuffer,
  )
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('')
}

describe('quick audio fingerprint', () => {
  it('hashes size, mtime, and the first and last 64 KiB', async () => {
    const bytes = Uint8Array.from(
      { length: CHUNK_BYTES * 2 + 17 },
      (_, index) => index % 251,
    )
    const lastModified = 1_720_000_000_123
    const file = new File([bytes], 'Reference.WAV', {
      type: 'audio/wav',
      lastModified,
    })

    await expect(createQuickAudioFingerprint(file)).resolves.toBe(
      await expectedFingerprint(bytes, lastModified),
    )
  })

  it('is deliberately unaffected by bytes outside the quick first/last sample', async () => {
    const first = new Uint8Array(CHUNK_BYTES).fill(1)
    const last = new Uint8Array(CHUNK_BYTES).fill(2)
    const fileA = new File(
      [first, new Uint8Array(CHUNK_BYTES).fill(3), last],
      'a.wav',
      { lastModified: 10 },
    )
    const fileB = new File(
      [first, new Uint8Array(CHUNK_BYTES).fill(4), last],
      'b.wav',
      { lastModified: 10 },
    )

    expect(await createQuickAudioFingerprint(fileA)).toBe(
      await createQuickAudioFingerprint(fileB),
    )
  })
})

describe('audio import', () => {
  it('validates basic metadata without treating MIME or extension as codec authority', () => {
    const file = new File([Uint8Array.of(1)], '  sample.CUSTOM  ', {
      type: 'application/octet-stream',
      lastModified: 42,
    })

    expect(validateAudioFile(file)).toEqual({
      name: 'sample.CUSTOM',
      extension: 'custom',
      mimeType: 'application/octet-stream',
      sizeBytes: 1,
      lastModified: 42,
    })
  })

  it('reads, decodes, fingerprints, and reports the planar Float32 PCM budget', async () => {
    const encodedBytes = Uint8Array.of(82, 73, 70, 70, 1, 2, 3, 4)
    const file = new File([encodedBytes], 'tone.wav', {
      type: 'audio/wav',
      lastModified: 99,
    })
    const audioBuffer = createAudioBuffer(12_000, 48_000, 2)
    const context = new FakeDecodeContext(audioBuffer)

    const imported = await importAudio(file, asDecodeContext(context), {
      softPcmLimitBytes: 150_000,
    })

    expect(context.decodedInput?.byteLength).toBe(encodedBytes.byteLength)
    expect(imported.audioBuffer).toBe(audioBuffer)
    expect(imported.metadata).toMatchObject({
      name: 'tone.wav',
      extension: 'wav',
      mimeType: 'audio/wav',
      sizeBytes: 8,
      lastModified: 99,
      durationSeconds: 0.25,
      sampleRate: 48_000,
      numberOfChannels: 2,
      lengthSamples: 12_000,
      pcmBytes: 96_000,
    })
    expect(imported.metadata.fingerprint).toMatch(/^[a-f0-9]{64}$/)
    expect(imported.memory).toEqual({
      encodedBytes: 8,
      decodedPcmBytes: 96_000,
      estimatedWorkingSetBytes: 192_008,
      softLimitBytes: 150_000,
      exceedsSoftLimit: true,
    })
  })

  it('returns structured validation, decode, and memory-limit failures', async () => {
    const context = new FakeDecodeContext(createAudioBuffer())

    await expect(
      importAudio(new File([], 'empty.wav'), asDecodeContext(context)),
    ).rejects.toMatchObject({
      name: 'AudioImportError',
      code: 'IMPORT_EMPTY_FILE',
      stage: 'validation',
      retryable: false,
    })

    context.decodeError = new DOMException('not supported', 'NotSupportedError')
    await expect(
      importAudio(
        new File([Uint8Array.of(1)], 'codec.bin'),
        asDecodeContext(context),
      ),
    ).rejects.toMatchObject({
      code: 'IMPORT_UNSUPPORTED_FORMAT',
      stage: 'decoding',
      retryable: false,
    })

    context.decodeError = null
    await expect(
      importAudio(
        new File([Uint8Array.of(1)], 'large.wav'),
        asDecodeContext(context),
        { maxDecodedPcmBytes: 95_999 },
      ),
    ).rejects.toMatchObject({
      code: 'IMPORT_PCM_TOO_LARGE',
      stage: 'preparing',
      details: {
        decodedPcmBytes: 96_000,
        limitBytes: 95_999,
      },
    })

    await expect(
      importAudio(
        new File([Uint8Array.of(1)], 'working-set.wav'),
        asDecodeContext(context),
        { maxEstimatedWorkingSetBytes: 192_000 },
      ),
    ).rejects.toMatchObject({
      code: 'IMPORT_PCM_TOO_LARGE',
      stage: 'preparing',
      details: {
        decodedPcmBytes: 96_000,
        estimatedWorkingSetBytes: 192_001,
        limitBytes: 192_000,
      },
    })
  })

  it('serializes errors without exposing the browser exception or local data', () => {
    const error = new AudioImportError({
      code: 'IMPORT_READ_FAILED',
      stage: 'reading',
      message: '读取失败。',
      retryable: true,
      details: { fileSizeBytes: 123 },
    })

    expect(error.toJSON()).toEqual({
      name: 'AudioImportError',
      code: 'IMPORT_READ_FAILED',
      stage: 'reading',
      message: '读取失败。',
      retryable: true,
      details: { fileSizeBytes: 123 },
    })
  })

  it('ignores a late decode result after cancellation', async () => {
    const controller = new AbortController()
    const audioBuffer = createAudioBuffer()
    const context: AudioDecodeContext = {
      async decodeAudioData(): Promise<AudioBuffer> {
        controller.abort()
        return audioBuffer
      },
    }

    await expect(
      importAudio(
        new File([Uint8Array.of(1)], 'cancel.wav'),
        context,
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({
      code: 'IMPORT_CANCELLED',
    })
  })
})
