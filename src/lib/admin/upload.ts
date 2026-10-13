export const AUDIO_UPLOAD_LIMIT = 50 * 1024 * 1024
export const IMAGE_UPLOAD_LIMIT = 10 * 1024 * 1024
export const MULTIPART_UPLOAD_LIMIT = AUDIO_UPLOAD_LIMIT + 64 * 1024

export class UploadError extends Error {
  readonly status: 409 | 413 | 422 | 503
  readonly field: string

  constructor(message: string, status: 409 | 413 | 422 | 503 = 422, field = 'file') {
    super(message)
    this.status = status
    this.field = field
  }
}

export type MediaUpload = {
  file: File
  type: 'music' | 'image_album' | 'image_music'
  dir: string
  key: string
  contentType: string
}

function safePart(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 180 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f<>:"/\\|?*#%]/.test(value) &&
    !value.endsWith('.') &&
    !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(value)
  )
}

async function limitedFormData(request: Request): Promise<FormData> {
  if (!/^multipart\/form-data\s*;/i.test(request.headers.get('content-type') ?? '')) {
    throw new UploadError('Envie o arquivo como multipart/form-data.')
  }
  const tooLarge = () => new UploadError('O envio excede o limite de 50 MiB.', 413)
  if (Number(request.headers.get('content-length')) > MULTIPART_UPLOAD_LIMIT) throw tooLarge()
  if (!request.body) throw new UploadError('Selecione um arquivo.')
  const reader = request.body.getReader()
  let total = 0
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) return controller.close()
      total += value.byteLength
      if (total > MULTIPART_UPLOAD_LIMIT) {
        await reader.cancel()
        controller.error(tooLarge())
      } else controller.enqueue(value)
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
  try {
    return await new Response(body, { headers: request.headers }).formData()
  } catch {
    if (total > MULTIPART_UPLOAD_LIMIT) throw tooLarge()
    throw new UploadError('O formulário de envio é inválido.')
  }
}

const ascii = (bytes: Uint8Array, start: number, length: number) =>
  String.fromCharCode(...bytes.subarray(start, start + length))

function mp3FrameLength(bytes: Uint8Array, offset: number): number {
  const a = bytes[offset]
  const b = bytes[offset + 1]
  const c = bytes[offset + 2]
  if (a !== 0xff || b === undefined || c === undefined || (b & 0xe0) !== 0xe0) return 0
  const version = (b >> 3) & 3
  const rateIndex = (c >> 2) & 3
  const bitrateIndex = c >> 4
  if (version === 1 || (b & 6) !== 2 || rateIndex === 3) return 0
  const bitrates =
    version === 3
      ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  const bitrate = bitrates[bitrateIndex]
  const rate = [44100, 48000, 32000][rateIndex]
  if (!bitrate || !rate) return 0
  const sampleRate = rate / (version === 3 ? 1 : version === 2 ? 2 : 4)
  return Math.floor(((version === 3 ? 144000 : 72000) * bitrate) / sampleRate) + ((c >> 1) & 1)
}

async function matchesSignature(file: File, extension: string): Promise<boolean> {
  const bytes = new Uint8Array(await file.slice(0, 512).arrayBuffer())
  const view = new DataView(bytes.buffer)
  if (extension === 'mp3') {
    let offset = 0
    if (ascii(bytes, 0, 3) === 'ID3') {
      if (
        bytes.length < 10 ||
        ![2, 3, 4].includes(bytes[3]!) ||
        bytes.slice(6, 10).some((v) => v > 127)
      )
        return false
      offset = 10 + bytes.slice(6, 10).reduce((n, v) => n * 128 + v, 0)
      if (bytes[3] === 4 && bytes[5]! & 0x10) offset += 10
    }
    const frames = new Uint8Array(await file.slice(offset, offset + 2048).arrayBuffer())
    const length = mp3FrameLength(frames, 0)
    return length > 0 && offset + length <= file.size && mp3FrameLength(frames, length) > 0
  }
  if (extension === 'opus') {
    if (
      bytes.length < 47 ||
      ascii(bytes, 0, 4) !== 'OggS' ||
      bytes[4] !== 0 ||
      (bytes[5]! & 2) === 0
    )
      return false
    const segments = bytes[26]!
    const start = 27 + segments
    return (
      segments > 0 &&
      bytes[27]! >= 19 &&
      ascii(bytes, start, 8) === 'OpusHead' &&
      bytes[start + 8] === 1 &&
      bytes[start + 9]! > 0
    )
  }
  if (extension === 'bmp') {
    return (
      bytes.length >= 26 &&
      ascii(bytes, 0, 2) === 'BM' &&
      view.getUint32(2, true) <= file.size &&
      view.getUint32(10, true) >= 26 &&
      view.getUint32(10, true) < file.size &&
      [12, 40, 52, 56, 108, 124].includes(view.getUint32(14, true))
    )
  }
  if (extension === 'png') {
    return (
      bytes.length >= 33 &&
      [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v) &&
      ascii(bytes, 12, 4) === 'IHDR' &&
      view.getUint32(8) === 13 &&
      view.getUint32(16) > 0 &&
      view.getUint32(20) > 0
    )
  }
  return (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes[3] !== 0 &&
    bytes[3] !== 0xff
  )
}

export async function readMediaUpload(request: Request): Promise<MediaUpload> {
  const form = await limitedFormData(request)
  const allowed = new Set(['file', 'type', 'dir', 'id_language'])
  for (const key of form.keys()) {
    if (!allowed.has(key) || form.getAll(key).length !== 1)
      throw new UploadError('Campo de envio inválido ou repetido.', 422, key)
  }
  const type = form.get('type')
  if (type !== 'music' && type !== 'image_album' && type !== 'image_music')
    throw new UploadError('Selecione o tipo de arquivo.', 422, 'type')
  const file = form.get('file')
  if (!(file instanceof File) || !file.size)
    throw new UploadError('Selecione um arquivo não vazio.')
  if (!safePart(file.name))
    throw new UploadError(
      'O nome do arquivo contém caracteres inválidos (incluindo # e %), nome reservado ou espaço/ponto no final.',
    )
  const limit = type === 'music' ? AUDIO_UPLOAD_LIMIT : IMAGE_UPLOAD_LIMIT
  if (file.size > limit)
    throw new UploadError(`O arquivo excede o limite de ${type === 'music' ? 50 : 10} MiB.`, 413)
  const extension = file.name.match(/\.([^.]+)$/)?.[1]?.toLowerCase() ?? ''
  const extensions =
    type === 'music'
      ? ['mp3', 'opus']
      : type === 'image_album'
        ? ['bmp']
        : ['bmp', 'jpg', 'jpeg', 'png']
  if (!extensions.includes(extension))
    throw new UploadError(`Formato permitido: ${extensions.join(', ')}.`)
  let dir: string
  if (type === 'music') {
    const language = form.get('id_language')
    if (language !== 'pt' && language !== 'es')
      throw new UploadError('Selecione o idioma pt ou es.', 422, 'id_language')
    const folder = form.get('dir') ?? 'Avulsas'
    if (typeof folder !== 'string' || !folder.split('/').every(safePart))
      throw new UploadError(
        'Informe uma pasta relativa válida, sem caracteres inválidos no Windows, # ou %.',
        422,
        'dir',
      )
    dir = `/musics/${language}/${folder}`
  } else {
    if (form.has('dir'))
      throw new UploadError('A pasta das imagens é definida pelo tipo.', 422, 'dir')
    if (form.has('id_language'))
      throw new UploadError('Informe idioma somente para áudio.', 422, 'id_language')
    dir = type === 'image_album' ? '/covers' : '/images'
  }
  const key = `${dir.slice(1)}/${file.name}`
  if (key.length > 240)
    throw new UploadError('O caminho completo deve ter no máximo 240 caracteres.', 422, 'dir')
  if (!(await matchesSignature(file, extension)))
    throw new UploadError('O conteúdo do arquivo não corresponde ao formato informado.')
  const contentType =
    extension === 'mp3'
      ? 'audio/mpeg'
      : extension === 'opus'
        ? 'audio/ogg'
        : extension === 'bmp'
          ? 'image/bmp'
          : extension === 'png'
            ? 'image/png'
            : 'image/jpeg'
  return { file, type, dir, key, contentType }
}

export async function storeMediaUpload<T>(
  upload: MediaUpload,
  published: R2Bucket,
  originals: R2Bucket,
  save: () => Promise<T>,
): Promise<T> {
  const created: R2Bucket[] = []
  try {
    for (const bucket of [originals, published]) {
      const object = await bucket.put(upload.key, upload.file, {
        onlyIf: { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: upload.contentType },
      })
      if (!object) throw new UploadError('Já existe um arquivo com esse nome nesta pasta.', 409)
      created.push(bucket)
    }
    return await save()
  } catch (error) {
    await Promise.all(created.map((bucket) => bucket.delete(upload.key)))
    throw error
  }
}
