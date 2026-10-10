const HEADER_SCAN_BYTES = 512

export const AUDIO_SIGNATURE_BYTES = HEADER_SCAN_BYTES

export function hasMp3Signature(value: Uint8Array): boolean {
  if (value.byteLength >= 3 && value[0] === 0x49 && value[1] === 0x44 && value[2] === 0x33) {
    return true
  }
  const limit = Math.min(value.byteLength, HEADER_SCAN_BYTES)
  for (let index = 0; index + 2 < limit; index++) {
    const first = value[index] as number
    const second = value[index + 1] as number
    const third = value[index + 2] as number
    if (first !== 0xff || (second & 0xe0) !== 0xe0) continue
    const version = (second >> 3) & 0x03
    const layer = (second >> 1) & 0x03
    const bitrate = (third >> 4) & 0x0f
    const sampleRate = (third >> 2) & 0x03
    if (version !== 1 && layer !== 0 && bitrate !== 0 && bitrate !== 15 && sampleRate !== 3) {
      return true
    }
  }
  return false
}

export function hasOpusSignature(value: Uint8Array): boolean {
  if (
    value.byteLength < 12 ||
    value[0] !== 0x4f ||
    value[1] !== 0x67 ||
    value[2] !== 0x67 ||
    value[3] !== 0x53
  ) {
    return false
  }
  const marker = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]
  const limit = Math.min(value.byteLength, HEADER_SCAN_BYTES)
  for (let index = 4; index + marker.length <= limit; index++) {
    if (marker.every((byte, offset) => value[index + offset] === byte)) return true
  }
  return false
}

export function hasAudioSignature(value: Uint8Array, extension: string): boolean {
  if (extension === '.mp3') return hasMp3Signature(value)
  if (extension === '.opus') return hasOpusSignature(value)
  return false
}

export function hasBmpSignature(value: Uint8Array): boolean {
  return value.byteLength >= 2 && value[0] === 0x42 && value[1] === 0x4d
}

export function hasImageSignature(value: Uint8Array, extension: string): boolean {
  if (extension === '.jpg' || extension === '.jpeg') {
    return value.byteLength >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff
  }
  if (extension === '.png') {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    return (
      value.byteLength >= signature.length &&
      signature.every((byte, index) => value[index] === byte)
    )
  }
  if (extension === '.bmp') return hasBmpSignature(value)
  return false
}

export function mediaFormatLabel(extension: string): string {
  switch (extension) {
    case '.mp3':
      return 'MP3'
    case '.opus':
      return 'Ogg/Opus'
    case '.jpg':
    case '.jpeg':
      return 'JPEG'
    case '.png':
      return 'PNG'
    case '.bmp':
      return 'BMP'
    default:
      return extension || '<sem extensão>'
  }
}
