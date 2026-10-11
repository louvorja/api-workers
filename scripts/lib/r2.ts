import { AwsClient } from 'aws4fetch'

const endpoint = process.env.R2_ENDPOINT ?? ''
const bucket = process.env.R2_BUCKET ?? 'files'

const aws = new AwsClient({
  accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
  service: 's3',
  region: 'auto',
})

/** Bucket com os arquivos originais (MP3, BMP) e os bancos do Delphi. */
export const ORIGINALS_BUCKET = process.env.R2_ORIGINALS_BUCKET ?? 'files-original'

const url = (key: string, bucketName = bucket) =>
  `${endpoint}/${bucketName}/${key.split('/').map(encodeURIComponent).join('/')}`

export async function put(
  key: string,
  body: Uint8Array | string,
  contentType: string,
  bucketName = bucket,
) {
  const res = await aws.fetch(url(key, bucketName), {
    method: 'PUT',
    body,
    headers: { 'content-type': contentType },
  })
  if (!res.ok) throw new Error(`PUT ${key} -> ${res.status} ${await res.text()}`)
}

export async function get(key: string, bucketName = bucket): Promise<Uint8Array | null> {
  const res = await aws.fetch(url(key, bucketName))
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET ${key} -> ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

export async function exists(key: string, bucketName = bucket): Promise<boolean> {
  const res = await aws.fetch(url(key, bucketName), { method: 'HEAD' })
  if (res.status === 404) return false
  if (!res.ok) throw new Error(`HEAD ${key} -> ${res.status}`)
  return true
}

/** Lista todas as chaves do bucket sob um prefixo, paginando os 1000 por página do S3. */
export async function list(prefix = ''): Promise<string[]> {
  return [...(await listWithSizes(prefix)).keys()]
}

/** O inventário de mídia exclui snapshots, pacotes e estado da publicação. */
export async function mediaSizes(): Promise<Map<string, number>> {
  const inventories = await Promise.all(
    ['covers/', 'images/', 'musics/'].map((prefix) => listWithSizes(prefix)),
  )
  return new Map(inventories.flatMap((inventory) => [...inventory]))
}

/**
 * Chaves e tamanhos sob um prefixo. O `<Size>` já vem no mesmo `<Contents>` da
 * listagem, então sai de graça — e é o que permite ao snapshot declarar o
 * tamanho do arquivo que o acervo tem de fato, e não o da origem legada.
 */
export async function listWithSizes(
  prefix = '',
  bucketName = bucket,
): Promise<Map<string, number>> {
  const objetos = new Map<string, number>()
  let token: string | undefined

  do {
    const q = new URLSearchParams({ 'list-type': '2', prefix, 'max-keys': '1000' })
    if (token) q.set('continuation-token', token)

    const res = await aws.fetch(`${endpoint}/${bucketName}?${q}`)
    if (!res.ok) throw new Error(`LIST -> ${res.status}`)
    const xml = await res.text()

    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const bloco = m[1] as string
      const chave = /<Key>([\s\S]*?)<\/Key>/.exec(bloco)?.[1]
      const tamanho = /<Size>(\d+)<\/Size>/.exec(bloco)?.[1]
      if (chave) objetos.set(decodeXml(chave), Number(tamanho ?? 0))
    }
    token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1]?.trim()
  } while (token)

  return objetos
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

export async function del(key: string) {
  const res = await aws.fetch(url(key), { method: 'DELETE' })
  if (!res.ok && res.status !== 404) throw new Error(`DELETE ${key} -> ${res.status}`)
}
