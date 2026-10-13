import { Hono, type MiddlewareHandler } from 'hono'
import { COMMON_HEADERS, notFound } from '../lib/http.ts'
import { FILES_URL } from '../lib/media-urls.ts'
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
  // Clientes que pedem MP3 podem não decodificar Opus; não troque o codec.
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
 * json_db/ e meta/ têm rotas e validações próprias; não devem ser expostos por /file.
 */
const PUBLIC_PREFIXES = ['covers/', 'images/', 'musics/', 'system/']

/**
 * DESCONTINUADO. O catálogo já entrega o endereço completo do arquivo, direto
 * no armazenamento, e cada arquivo servido por aqui conta na cota diária de
 * requisições do Worker. A rota segue funcionando só para quem ainda monta
 * `/file/...` sozinho (Flute 1.9.x, Piano, catálogos antigos guardados).
 *
 * Para remover de vez: apague este arquivo, a linha `app.route('/', files)` em
 * `src/index.ts`, o bloco `/file/{path}` em `src/openapi.ts`, a regra `files`
 * em `src/lib/rate-limit.ts` e os testes do bloco `file` em `test/api.test.ts`.
 */
export const files = new Hono<App>()

const markDeprecated: MiddlewareHandler<App> = async (c, next) => {
  await next()
  c.header('Deprecation', 'true')
}
files.use('/file', markDeprecated)
files.use('/file/*', markDeprecated)

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
  if (path === '' || /[\\\x00-\x1f\x7f]/.test(path)) return notFound(c)
  if (path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..'))
    return notFound(c)
  if (!PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix))) return notFound(c)

  // Verifica o objeto exato antes do redirect: uma faixa só em Opus não satisfaz
  // um pedido de MP3, e um nome inexistente deve continuar respondendo 404.
  if (path.startsWith('system/') || (path.startsWith('musics/') && /\.mp3$/i.test(path))) {
    if ((await c.env.FILES.head(path)) === null) return notFound(c)
    const headers = new Headers(COMMON_HEADERS)
    headers.set('Location', `${FILES_URL}/${path.split('/').map(encodeURIComponent).join('/')}`)
    headers.set('Cache-Control', 'public, max-age=3600')
    return new Response(null, { status: 302, headers })
  }

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
