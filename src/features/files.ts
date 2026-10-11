import { Hono } from 'hono'
import { COMMON_HEADERS, notFound } from '../lib/http.ts'
import { ORIGINALS_URL } from '../lib/media-urls.ts'
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
  // Quem pede `.mp3` recebe MP3: o que está aqui com esse nome, ou o original
  // (ver o redirecionamento abaixo). Entregar o Opus com nome de MP3 deixava
  // mudo quem só toca MP3, que é justamente quem ainda pede por esse nome.
  if (lower.endsWith('.mp3')) return [path]
  if (lower.endsWith('.bmp')) return [`${path.slice(0, -4)}.jpg`, path]
  // Caminho inverso: os JSONs pedem .opus, mas parte do acervo veio de fontes
  // de 128 kbps, onde converter para Opus não economiza espaço e só acrescenta
  // uma segunda geração de perda. Nessas faixas o MP3 original fica no bucket
  // no lugar do .opus, e sem este fallback o pedido do banco daria 404.
  if (lower.endsWith('.opus')) return [path, `${path.slice(0, -5)}.mp3`]
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

  // Só o segmento ".." sobe de diretório. Barrar a sequência em qualquer lugar
  // derrubava faixas com reticências no nome ("Pode Cair o Mundo...Estou em Paz").
  if (path === '' || path.startsWith('/')) return notFound(c)
  if (path.split('/').some((segment) => segment === '..')) return notFound(c)
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

  // A faixa foi convertida para Opus: o MP3 dela está no bucket dos originais.
  if (path.startsWith('musics/') && path.toLowerCase().endsWith('.mp3')) {
    const headers = new Headers(COMMON_HEADERS)
    headers.set('Location', `${ORIGINALS_URL}/${path.split('/').map(encodeURIComponent).join('/')}`)
    headers.set('Cache-Control', 'public, max-age=3600')
    return new Response(null, { status: 302, headers })
  }
  return notFound(c)
})
