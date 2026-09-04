import { Hono } from 'hono'
import { COMMON_HEADERS, notFound } from '../lib/http.ts'
import { serveObject } from '../lib/r2.ts'
import type { App } from '../types.ts'

/**
 * Chaves candidatas no bucket para um caminho pedido.
 *
 * O acervo foi normalizado: áudio em .opus e capas em .jpg. Os JSONs já
 * apontam para as chaves novas, mas instalações antigas do desktop têm URLs
 * .mp3/.bmp em cache local, então a extensão antiga continua resolvendo.
 *
 * A chave normalizada vem primeiro: o .bmp original segue no bucket e pesa 8x
 * mais, então servi-lo por ser "match exato" seria uma regressão.
 */
function candidates(path: string): string[] {
  const lower = path.toLowerCase()
  if (lower.endsWith('.mp3')) return [`${path.slice(0, -4)}.opus`, path]
  if (lower.endsWith('.bmp')) return [`${path.slice(0, -4)}.jpg`, path]
  return [path]
}

/**
 * Prefixos que /file expõe. O bucket também guarda o dump do banco em json_db/
 * e os arquivos de meta/, que têm rota própria e validação de chave própria —
 * servi-los aqui daria um caminho não validado para dentro do mesmo bucket e
 * acoplaria a API pública ao layout interno de armazenamento.
 */
const MEDIA_PREFIXES = ['covers/', 'images/', 'musics/']

export const files = new Hono<App>()

// HEAD na raiz é o teste de disponibilidade do desktop (download/index.js).
files.on(['GET', 'HEAD'], '/file', (c) => c.body(null, 200, COMMON_HEADERS))

files.on(['GET', 'HEAD'], '/file/*', async (c) => {
  const raw = c.req.path.slice('/file/'.length)
  let path: string
  try {
    path = decodeURIComponent(raw)
  } catch {
    return notFound(c)
  }

  if (path === '' || path.includes('..') || path.startsWith('/')) return notFound(c)
  if (!MEDIA_PREFIXES.some((prefix) => path.startsWith(prefix))) return notFound(c)

  for (const key of candidates(path)) {
    const res = await serveObject(
      c.env.FILES,
      key,
      c.req.raw,
      'public, max-age=31536000, immutable',
    )
    if (res) return res
  }
  return notFound(c)
})
