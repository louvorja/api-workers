import { Hono } from 'hono'
import { COMMON_HEADERS, notFound } from '../lib/http.ts'
import { MANIFEST_VARIANT_KEYS, mediaVariantFor, withMediaUrls } from '../lib/media-urls.ts'
import { serveObject } from '../lib/r2.ts'
import type { App } from '../types.ts'

/** Mesma restrição que o cliente aplica em Path.db — mantém a chave fora do path do bucket. */
const KEY_RE = /^[a-zA-Z0-9_-]+$/
// O violin-app acrescenta a data à URL (e um carimbo único quando o operador
// pede para atualizar), então um dia de cache não segura conteúdo velho: no dia
// seguinte a URL é outra. Sem cache, cada abertura repetida vira uma requisição
// na cota diária do plano gratuito — resposta 304 também conta.
const JSON_CACHE = 'public, max-age=86400, stale-while-revalidate=604800'

/**
 * O cache do Worker não separa as respostas por domínio: a chave é só caminho e
 * query, e os dois apps pedem a mesma URL (`?AAAAMMDD`). O catálogo sai com
 * endereços de mídia diferentes em cada domínio (ver lib/media-urls.ts), então
 * `public` aqui entrega a um app a resposta montada para o outro. Fica só no
 * cache de quem pediu.
 */
const CATALOG_CACHE = 'private, max-age=86400'

/**
 * `config` é a pergunta "há banco novo?". O menu de atualizações do violin-app
 * pede essa chave sem a data na URL: com um dia de cache ele repetia por 24 horas
 * a versão que viu primeiro, mesmo depois de ela mudar no servidor.
 */
const VERSION_CACHE = 'private, no-cache'

/**
 * Quem pede capítulo que não existe quase sempre é um script varrendo versões e
 * livros. A resposta mostra a ele o caminho certo; os apps só olham o status.
 */
const BIBLE_BUNDLE_HINT =
  'Para baixar a Bíblia inteira use /db/bible-bundle: um ZIP com todos os capítulos.'

export const jsonDb = new Hono<App>()

// Sem chave, /json_db devolve o mesmo manifesto de /db/manifest. Precisa vir
// antes da rota com parâmetro.
jsonDb.on(['GET', 'HEAD'], '/json_db', async (c) => {
  const res = await serveObject(
    c.env.FILES,
    MANIFEST_VARIANT_KEYS[mediaVariantFor(new URL(c.req.url).hostname)],
    c.req.raw,
    CATALOG_CACHE,
  )
  return res ?? notFound(c)
})

jsonDb.on(['GET', 'HEAD'], '/json_db/:key', async (c) => {
  const key = c.req.param('key')
  if (!KEY_RE.test(key)) return notFound(c)

  // Os capítulos da Bíblia não têm mídia: saem iguais nos dois domínios, sem
  // reescrita, e por isso são os únicos que podem ficar no cache compartilhado.
  if (key.startsWith('bible_')) {
    const res = await serveObject(c.env.FILES, `json_db/${key}.json`, c.req.raw, JSON_CACHE)
    if (res) return res
    c.header('Cache-Control', 'no-store')
    return c.json({ error: 'Arquivo não encontrado!', details: BIBLE_BUNDLE_HINT }, 404)
  }

  const object = await c.env.FILES.get(`json_db/${key}.json`)
  if (object === null) return notFound(c)
  const headers = new Headers(COMMON_HEADERS)
  headers.set('Content-Type', 'application/json')
  headers.set('Cache-Control', key === 'config' ? VERSION_CACHE : CATALOG_CACHE)
  const body = withMediaUrls(await object.text(), mediaVariantFor(new URL(c.req.url).hostname))
  return new Response(c.req.method === 'HEAD' ? null : body, { headers })
})
