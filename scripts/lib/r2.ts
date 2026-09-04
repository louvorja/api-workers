import { AwsClient } from 'aws4fetch'

const endpoint = process.env.R2_ENDPOINT ?? ''
const bucket = process.env.R2_BUCKET ?? 'files'

const aws = new AwsClient({
  accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
  service: 's3',
  region: 'auto',
})

const url = (key: string) =>
  `${endpoint}/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`

export async function put(key: string, body: Uint8Array | string, contentType: string) {
  const res = await aws.fetch(url(key), {
    method: 'PUT',
    body,
    headers: { 'content-type': contentType },
  })
  if (!res.ok) throw new Error(`PUT ${key} -> ${res.status} ${await res.text()}`)
}

export async function get(key: string): Promise<Uint8Array | null> {
  const res = await aws.fetch(url(key))
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET ${key} -> ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

/** Lista todas as chaves do bucket sob um prefixo, paginando os 1000 por página do S3. */
export async function list(prefix = ''): Promise<string[]> {
  const keys: string[] = []
  let token: string | undefined

  do {
    const q = new URLSearchParams({ 'list-type': '2', prefix, 'max-keys': '1000' })
    if (token) q.set('continuation-token', token)

    const res = await aws.fetch(`${endpoint}/${bucket}?${q}`)
    if (!res.ok) throw new Error(`LIST -> ${res.status}`)
    const xml = await res.text()

    for (const m of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) {
      keys.push(decodeXml(m[1] as string))
    }
    token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1]?.trim()
  } while (token)

  return keys
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
