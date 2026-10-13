import type { MediaWork } from './media-plan.ts'
import { hasAudioSignature, hasImageSignature } from './media-signatures.ts'

const TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.opus': 'audio/ogg',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.bmp': 'image/bmp',
}

export function assertMediaBytes(key: string, body: Uint8Array | null): asserts body is Uint8Array {
  const extension = key.slice(key.lastIndexOf('.')).toLowerCase()
  if (
    !/^(musics|images|covers)\//.test(key) ||
    /[\\\x00-\x1f\x7f]/.test(key) ||
    key.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error(`caminho de mídia inválido: ${key}`)
  }
  if (
    !body?.length ||
    !(hasAudioSignature(body, extension) || hasImageSignature(body, extension))
  ) {
    throw new Error(`arquivo vazio ou formato diferente da extensão: ${key}`)
  }
}

export const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index])

export type MediaStorage = {
  get(key: string, bucket: 'files' | 'originals'): Promise<Uint8Array | null>
  put(
    key: string,
    body: Uint8Array,
    contentType: string,
    bucket: 'files' | 'originals',
  ): Promise<void>
}

export async function syncMediaCopy(item: MediaWork, storage: MediaStorage): Promise<void> {
  const body = await storage.get(item.key, item.source)
  assertMediaBytes(item.key, body)
  const existing = await storage.get(item.key, item.target)
  if (existing !== null) {
    if (!sameBytes(existing, body))
      throw new Error(`destino já contém bytes diferentes: ${item.key}`)
    return
  }
  const type = TYPES[item.key.slice(item.key.lastIndexOf('.')).toLowerCase()] as string
  await storage.put(item.key, body, type, item.target)
  const stored = await storage.get(item.key, item.target)
  if (stored === null || !sameBytes(stored, body))
    throw new Error(`cópia não conferiu: ${item.key}`)
}

export async function removeDuplicateAudio(
  item: { key: string; canonicalKey: string },
  storage: MediaStorage & { del(key: string): Promise<void> },
): Promise<void> {
  const [body, backup, canonical] = await Promise.all([
    storage.get(item.key, 'files'),
    storage.get(item.key, 'originals'),
    storage.get(item.canonicalKey, 'files'),
  ])
  assertMediaBytes(item.key, body)
  assertMediaBytes(item.key, backup)
  assertMediaBytes(item.canonicalKey, canonical)
  if (!sameBytes(body, backup)) throw new Error(`backup diferente; MP3 preservado: ${item.key}`)
  await storage.del(item.key)
}
