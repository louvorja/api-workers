import { Hono } from 'hono'
import { COMMON_HEADERS, notFound } from '../lib/http.ts'
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
 * query, e os dois apps pedem a mesma URL (`?AAAAMMDD`). O catálogo sai
 * diferente em cada domínio, então `public` aqui entrega a um app a resposta
 * montada para o outro. Fica só no cache de quem pediu.
 */
const CATALOG_CACHE = 'private, max-age=86400'

/**
 * Domínio da API antiga. Quem chega por ele é cliente antigo — o app web em
 * app.louvorja.com.br usa os campos `url_*` do catálogo como endereço pronto,
 * sem acrescentar nada na frente, que era como a API PHP os devolvia.
 */
const LEGACY_HOSTS = new Set(['api.louvorja.com.br'])

/**
 * Reescreve os caminhos de mídia do catálogo como endereços completos.
 *
 * O áudio volta a ter o nome `.mp3`: nesse domínio ele ainda é servido pelo
 * servidor antigo, que tem os originais, porque navegadores de iPhones mais
 * velhos não tocam Opus. As imagens ficam como estão (JPEG) e saem daqui.
 */
export function legacyCatalog(text: string, origin: string): string {
  return text.replace(
    /"(url_[a-z_]+)":"\/(covers|images|musics)\/((?:[^"\\]|\\.)*)"/g,
    (_match, key: string, dir: string, rest: string) =>
      `"${key}":"${origin}/file/${dir}/${dir === 'musics' ? rest.replace(/\.opus$/, '.mp3') : rest}"`,
  )
}

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
  const res = await serveObject(c.env.FILES, 'meta/manifest.json', c.req.raw, JSON_CACHE)
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

  const url = new URL(c.req.url)
  if (LEGACY_HOSTS.has(url.hostname)) {
    const object = await c.env.FILES.get(`json_db/${key}.json`)
    if (object === null) return notFound(c)
    const headers = new Headers(COMMON_HEADERS)
    headers.set('Content-Type', 'application/json')
    headers.set('Cache-Control', CATALOG_CACHE)
    const body = legacyCatalog(await object.text(), url.origin)
    return new Response(c.req.method === 'HEAD' ? null : body, { headers })
  }

  const res = await serveObject(c.env.FILES, `json_db/${key}.json`, c.req.raw, CATALOG_CACHE)
  return res ?? notFound(c)
})
