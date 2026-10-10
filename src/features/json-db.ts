import { Hono } from 'hono'
import { notFound } from '../lib/http.ts'
import { serveObject } from '../lib/r2.ts'
import type { App } from '../types.ts'

/** Mesma restrição que o cliente aplica em Path.db — mantém a chave fora do path do bucket. */
const KEY_RE = /^[a-zA-Z0-9_-]+$/
// O violin-app acrescenta a data à URL (e um carimbo único quando o operador
// pede para atualizar), então um dia de cache não segura conteúdo velho: no dia
// seguinte a URL é outra. Sem cache, cada abertura repetida vira uma requisição
// na cota diária do plano gratuito — resposta 304 também conta.
const JSON_CACHE = 'public, max-age=86400, stale-while-revalidate=604800'

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

  const res = await serveObject(c.env.FILES, `json_db/${key}.json`, c.req.raw, JSON_CACHE)
  return res ?? notFound(c)
})
