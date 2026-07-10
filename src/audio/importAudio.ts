const FINGERPRINT_CHUNK_BYTES = 64 * 1024

export const DEFAULT_MAX_ENCODED_AUDIO_BYTES = 1024 * 1024 * 1024
// The current Worker protocols transfer one full PCM copy. Keeping decoded PCM
// at or below 512 MiB bounds source + Worker input to roughly 1 GiB.
export const DEFAULT_MAX_DECODED_PCM_BYTES = 512 * 1024 * 1024
export const DEFAULT_MAX_ESTIMATED_WORKING_SET_BYTES = 1024 * 1024 * 1024
export const DEFAULT_SOFT_PCM_LIMIT_BYTES = 384 * 1024 * 1024

export type AudioImportStage =
  | 'validation'
  | 'fingerprint'
  | 'reading'
  | 'decoding'
  | 'preparing'

export type AudioImportErrorCode =
  | 'IMPORT_INVALID_FILE'
  | 'IMPORT_EMPTY_FILE'
  | 'IMPORT_FILE_TOO_LARGE'
  | 'IMPORT_FINGERPRINT_UNAVAILABLE'
  | 'IMPORT_FINGERPRINT_FAILED'
  | 'IMPORT_READ_FAILED'
  | 'IMPORT_AUDIO_UNAVAILABLE'
  | 'IMPORT_UNSUPPORTED_FORMAT'
  | 'IMPORT_DECODE_FAILED'
  | 'IMPORT_INVALID_PCM'
  | 'IMPORT_PCM_TOO_LARGE'
  | 'IMPORT_CANCELLED'

export interface AudioImportErrorDetails {
  readonly fileSizeBytes?: number
  readonly limitBytes?: number
  readonly decodedPcmBytes?: number
  readonly estimatedWorkingSetBytes?: number
}

export interface SerializedAudioImportError {
  readonly name: 'AudioImportError'
  readonly code: AudioImportErrorCode
  readonly stage: AudioImportStage
  readonly message: string
  readonly retryable: boolean
  readonly details?: AudioImportErrorDetails
}

/**
 * A UI-safe import failure. Browser exceptions are deliberately not exposed so
 * local paths and implementation-specific stack details cannot leak into state.
 */
export class AudioImportError extends Error {
  readonly code: AudioImportErrorCode
  readonly stage: AudioImportStage
  readonly retryable: boolean
  readonly details?: AudioImportErrorDetails

  constructor(failure: Omit<SerializedAudioImportError, 'name'>) {
    super(failure.message)
    this.name = 'AudioImportError'
    this.code = failure.code
    this.stage = failure.stage
    this.retryable = failure.retryable
    this.details = failure.details
  }

  toJSON(): SerializedAudioImportError {
    return {
      name: 'AudioImportError',
      code: this.code,
      stage: this.stage,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    }
  }
}

export interface AudioFileMetadata {
  readonly name: string
  readonly extension: string | null
  readonly mimeType: string
  readonly sizeBytes: number
  readonly lastModified: number
}

export interface ImportedAudioMetadata extends AudioFileMetadata {
  /** Non-authoritative cache/relink hint; never use as a security digest. */
  readonly fingerprint: string
  readonly durationSeconds: number
  readonly sampleRate: number
  readonly numberOfChannels: number
  readonly lengthSamples: number
  readonly pcmBytes: number
}

export interface PcmMemoryEstimate {
  readonly encodedBytes: number
  readonly decodedPcmBytes: number
  readonly estimatedWorkingSetBytes: number
  readonly softLimitBytes: number
  readonly exceedsSoftLimit: boolean
}

export interface ImportedAudio {
  /** Runtime-only. Do not place this value in a serializable project store. */
  readonly audioBuffer: AudioBuffer
  readonly metadata: ImportedAudioMetadata
  readonly memory: PcmMemoryEstimate
}

export interface ImportAudioOptions {
  readonly signal?: AbortSignal
  readonly maxEncodedBytes?: number
  readonly maxDecodedPcmBytes?: number
  readonly maxEstimatedWorkingSetBytes?: number
  readonly softPcmLimitBytes?: number
  /** Test/embedded-environment override; defaults to globalThis.crypto. */
  readonly cryptoProvider?: Pick<Crypto, 'subtle'>
}

export interface QuickFingerprintOptions {
  readonly signal?: AbortSignal
  readonly maxEncodedBytes?: number
  readonly cryptoProvider?: Pick<Crypto, 'subtle'>
}

export type AudioDecodeContext = Pick<BaseAudioContext, 'decodeAudioData'>

export function isAudioImportError(error: unknown): error is AudioImportError {
  return error instanceof AudioImportError
}

/**
 * Performs cheap checks only. Extension and MIME are retained as hints; the
 * browser decoder remains the authority for actual codec support.
 */
export function validateAudioFile(
  file: File,
  maxEncodedBytes = DEFAULT_MAX_ENCODED_AUDIO_BYTES,
): AudioFileMetadata {
  assertPositiveSafeByteLimit(maxEncodedBytes, 'maxEncodedBytes')

  if (
    !file ||
    typeof file.name !== 'string' ||
    typeof file.type !== 'string' ||
    !Number.isSafeInteger(file.size) ||
    !Number.isSafeInteger(file.lastModified) ||
    file.lastModified < 0 ||
    typeof file.slice !== 'function' ||
    typeof file.arrayBuffer !== 'function'
  ) {
    throw importFailure(
      'IMPORT_INVALID_FILE',
      'validation',
      '请选择有效的本地音频文件。',
      false,
    )
  }

  const name = file.name.trim()
  if (name.length === 0) {
    throw importFailure(
      'IMPORT_INVALID_FILE',
      'validation',
      '音频文件名不能为空。',
      false,
    )
  }

  if (file.size === 0) {
    throw importFailure(
      'IMPORT_EMPTY_FILE',
      'validation',
      '音频文件为空，请选择包含音频数据的文件。',
      false,
      { fileSizeBytes: 0 },
    )
  }

  if (file.size > maxEncodedBytes) {
    throw importFailure(
      'IMPORT_FILE_TOO_LARGE',
      'validation',
      '文件超过当前导入大小上限，请缩小文件或使用流式工具处理。',
      false,
      { fileSizeBytes: file.size, limitBytes: maxEncodedBytes },
    )
  }

  return {
    name,
    extension: getFileExtension(name),
    mimeType: file.type,
    sizeBytes: file.size,
    lastModified: file.lastModified,
  }
}

/**
 * Computes SHA-256 over a fixed-width size/mtime header plus the first and last
 * 64 KiB. The digest is fast and useful for cache lookup, but is intentionally
 * not a full-file integrity hash.
 */
export async function createQuickAudioFingerprint(
  file: File,
  options: QuickFingerprintOptions = {},
): Promise<string> {
  const metadata = validateAudioFile(
    file,
    options.maxEncodedBytes ?? DEFAULT_MAX_ENCODED_AUDIO_BYTES,
  )
  throwIfAborted(options.signal, 'fingerprint')

  const cryptoProvider = options.cryptoProvider ?? globalThis.crypto
  if (!cryptoProvider?.subtle || typeof cryptoProvider.subtle.digest !== 'function') {
    throw importFailure(
      'IMPORT_FINGERPRINT_UNAVAILABLE',
      'fingerprint',
      '当前浏览器无法生成本地文件指纹。',
      false,
    )
  }

  try {
    const firstEnd = Math.min(metadata.sizeBytes, FINGERPRINT_CHUNK_BYTES)
    const lastStart = Math.max(0, metadata.sizeBytes - FINGERPRINT_CHUNK_BYTES)
    const firstBytes = await file.slice(0, firstEnd).arrayBuffer()
    throwIfAborted(options.signal, 'fingerprint')
    const lastBytes = await file.slice(lastStart, metadata.sizeBytes).arrayBuffer()
    throwIfAborted(options.signal, 'fingerprint')

    const digestInput = buildFingerprintInput(
      metadata.sizeBytes,
      metadata.lastModified,
      firstBytes,
      lastBytes,
    )
    const digest = await cryptoProvider.subtle.digest(
      'SHA-256',
      digestInput.buffer as ArrayBuffer,
    )
    throwIfAborted(options.signal, 'fingerprint')
    return bytesToHex(new Uint8Array(digest))
  } catch (error) {
    if (isAudioImportError(error)) {
      throw error
    }
    if (options.signal?.aborted || getErrorName(error) === 'AbortError') {
      throw cancelledFailure('fingerprint')
    }
    throw importFailure(
      'IMPORT_FINGERPRINT_FAILED',
      'fingerprint',
      '读取文件摘要失败，原文件未被修改。',
      true,
      { fileSizeBytes: metadata.sizeBytes },
    )
  }
}

export function estimateDecodedPcmBytes(
  lengthSamples: number,
  numberOfChannels: number,
): number {
  if (
    !Number.isSafeInteger(lengthSamples) ||
    lengthSamples <= 0 ||
    !Number.isSafeInteger(numberOfChannels) ||
    numberOfChannels <= 0
  ) {
    throw importFailure(
      'IMPORT_INVALID_PCM',
      'preparing',
      '解码结果缺少有效的采样长度或声道信息。',
      false,
    )
  }

  const bytes = lengthSamples * numberOfChannels * Float32Array.BYTES_PER_ELEMENT
  if (!Number.isSafeInteger(bytes)) {
    throw importFailure(
      'IMPORT_INVALID_PCM',
      'preparing',
      '解码后的 PCM 数据规模无效。',
      false,
    )
  }
  return bytes
}

/**
 * Reads and decodes one local file. This function performs no network access and
 * returns the AudioBuffer separately from serializable metadata.
 */
export async function importAudio(
  file: File,
  audioContext: AudioDecodeContext,
  options: ImportAudioOptions = {},
): Promise<ImportedAudio> {
  const maxEncodedBytes =
    options.maxEncodedBytes ?? DEFAULT_MAX_ENCODED_AUDIO_BYTES
  const maxDecodedPcmBytes =
    options.maxDecodedPcmBytes ?? DEFAULT_MAX_DECODED_PCM_BYTES
  const maxEstimatedWorkingSetBytes = options.maxEstimatedWorkingSetBytes
    ?? DEFAULT_MAX_ESTIMATED_WORKING_SET_BYTES
  const softPcmLimitBytes =
    options.softPcmLimitBytes ?? DEFAULT_SOFT_PCM_LIMIT_BYTES

  assertPositiveSafeByteLimit(maxDecodedPcmBytes, 'maxDecodedPcmBytes')
  assertPositiveSafeByteLimit(
    maxEstimatedWorkingSetBytes,
    'maxEstimatedWorkingSetBytes',
  )
  assertPositiveSafeByteLimit(softPcmLimitBytes, 'softPcmLimitBytes')
  const fileMetadata = validateAudioFile(file, maxEncodedBytes)
  throwIfAborted(options.signal, 'validation')

  if (!audioContext || typeof audioContext.decodeAudioData !== 'function') {
    throw importFailure(
      'IMPORT_AUDIO_UNAVAILABLE',
      'decoding',
      '当前浏览器无法使用 Web Audio 解码音频。',
      false,
    )
  }

  const fingerprint = await createQuickAudioFingerprint(file, {
    signal: options.signal,
    maxEncodedBytes,
    cryptoProvider: options.cryptoProvider,
  })

  let encodedAudio: ArrayBuffer
  try {
    throwIfAborted(options.signal, 'reading')
    encodedAudio = await file.arrayBuffer()
    throwIfAborted(options.signal, 'reading')
  } catch (error) {
    if (isAudioImportError(error)) {
      throw error
    }
    if (options.signal?.aborted || getErrorName(error) === 'AbortError') {
      throw cancelledFailure('reading')
    }
    throw importFailure(
      'IMPORT_READ_FAILED',
      'reading',
      '读取音频文件失败，原文件未被修改。',
      true,
      { fileSizeBytes: fileMetadata.sizeBytes },
    )
  }

  let audioBuffer: AudioBuffer
  try {
    audioBuffer = await audioContext.decodeAudioData(encodedAudio)
    throwIfAborted(options.signal, 'decoding')
  } catch (error) {
    if (isAudioImportError(error)) {
      throw error
    }
    if (options.signal?.aborted || getErrorName(error) === 'AbortError') {
      throw cancelledFailure('decoding')
    }
    if (getErrorName(error) === 'NotSupportedError') {
      throw importFailure(
        'IMPORT_UNSUPPORTED_FORMAT',
        'decoding',
        '当前浏览器不支持此音频格式，请尝试转换为 WAV。',
        false,
        { fileSizeBytes: fileMetadata.sizeBytes },
      )
    }
    throw importFailure(
      'IMPORT_DECODE_FAILED',
      'decoding',
      '音频解码失败，文件可能损坏或编码不受支持。',
      true,
      { fileSizeBytes: fileMetadata.sizeBytes },
    )
  }

  validateDecodedAudioBuffer(audioBuffer)
  const decodedPcmBytes = estimateDecodedPcmBytes(
    audioBuffer.length,
    audioBuffer.numberOfChannels,
  )
  if (decodedPcmBytes > maxDecodedPcmBytes) {
    throw importFailure(
      'IMPORT_PCM_TOO_LARGE',
      'preparing',
      '解码后的 PCM 超过当前内存安全上限，未加载到工作区。',
      false,
      {
        fileSizeBytes: fileMetadata.sizeBytes,
        decodedPcmBytes,
        limitBytes: maxDecodedPcmBytes,
      },
    )
  }

  const estimatedWorkingSetBytes = fileMetadata.sizeBytes + decodedPcmBytes * 2
  if (estimatedWorkingSetBytes > maxEstimatedWorkingSetBytes) {
    throw importFailure(
      'IMPORT_PCM_TOO_LARGE',
      'preparing',
      '音频任务的预计工作内存超过安全上限，未加载到工作区。',
      false,
      {
        fileSizeBytes: fileMetadata.sizeBytes,
        decodedPcmBytes,
        estimatedWorkingSetBytes,
        limitBytes: maxEstimatedWorkingSetBytes,
      },
    )
  }

  const memory: PcmMemoryEstimate = {
    encodedBytes: fileMetadata.sizeBytes,
    decodedPcmBytes,
    estimatedWorkingSetBytes,
    softLimitBytes: softPcmLimitBytes,
    exceedsSoftLimit: estimatedWorkingSetBytes > softPcmLimitBytes,
  }

  return {
    audioBuffer,
    metadata: {
      ...fileMetadata,
      fingerprint,
      durationSeconds: audioBuffer.length / audioBuffer.sampleRate,
      sampleRate: audioBuffer.sampleRate,
      numberOfChannels: audioBuffer.numberOfChannels,
      lengthSamples: audioBuffer.length,
      pcmBytes: decodedPcmBytes,
    },
    memory,
  }
}

function validateDecodedAudioBuffer(audioBuffer: AudioBuffer): void {
  if (
    !audioBuffer ||
    !Number.isSafeInteger(audioBuffer.length) ||
    audioBuffer.length <= 0 ||
    !Number.isSafeInteger(audioBuffer.numberOfChannels) ||
    audioBuffer.numberOfChannels <= 0 ||
    !Number.isFinite(audioBuffer.sampleRate) ||
    audioBuffer.sampleRate <= 0 ||
    typeof audioBuffer.getChannelData !== 'function'
  ) {
    throw importFailure(
      'IMPORT_INVALID_PCM',
      'preparing',
      '音频解码结果无效或时长为零。',
      false,
    )
  }

  for (let channel = 0; channel < audioBuffer.numberOfChannels; channel += 1) {
    let channelData: Float32Array
    try {
      channelData = audioBuffer.getChannelData(channel)
    } catch {
      throw importFailure(
        'IMPORT_INVALID_PCM',
        'preparing',
        '音频解码结果包含不可读取的声道。',
        false,
      )
    }
    if (
      !(channelData instanceof Float32Array) ||
      channelData.length !== audioBuffer.length
    ) {
      throw importFailure(
        'IMPORT_INVALID_PCM',
        'preparing',
        '音频解码结果的声道长度不一致。',
        false,
      )
    }
  }
}

function buildFingerprintInput(
  sizeBytes: number,
  lastModified: number,
  firstBytes: ArrayBuffer,
  lastBytes: ArrayBuffer,
): Uint8Array {
  const header = new ArrayBuffer(16)
  const headerView = new DataView(header)
  headerView.setBigUint64(0, BigInt(sizeBytes), true)
  headerView.setBigUint64(8, BigInt(lastModified), true)

  const input = new Uint8Array(16 + firstBytes.byteLength + lastBytes.byteLength)
  input.set(new Uint8Array(header), 0)
  input.set(new Uint8Array(firstBytes), 16)
  input.set(new Uint8Array(lastBytes), 16 + firstBytes.byteLength)
  return input
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = ''
  for (const value of bytes) {
    hex += value.toString(16).padStart(2, '0')
  }
  return hex
}

function getFileExtension(name: string): string | null {
  const lastDot = name.lastIndexOf('.')
  if (lastDot <= 0 || lastDot === name.length - 1) {
    return null
  }
  return name.slice(lastDot + 1).toLowerCase()
}

function assertPositiveSafeByteLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`)
  }
}

function throwIfAborted(
  signal: AbortSignal | undefined,
  stage: AudioImportStage,
): void {
  if (signal?.aborted) {
    throw cancelledFailure(stage)
  }
}

function getErrorName(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('name' in error)) {
    return undefined
  }
  return typeof error.name === 'string' ? error.name : undefined
}

function cancelledFailure(stage: AudioImportStage): AudioImportError {
  return importFailure(
    'IMPORT_CANCELLED',
    stage,
    '音频导入已取消，原文件未被修改。',
    true,
  )
}

function importFailure(
  code: AudioImportErrorCode,
  stage: AudioImportStage,
  message: string,
  retryable: boolean,
  details?: AudioImportErrorDetails,
): AudioImportError {
  return new AudioImportError({
    code,
    stage,
    message,
    retryable,
    ...(details ? { details } : {}),
  })
}
