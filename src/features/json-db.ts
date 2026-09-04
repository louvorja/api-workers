import { Hono } from 'hono'
import { notFound } from '../lib/http.ts'
import { serveObject } from '../lib/r2.ts'
import type { App } from '../types.ts'

/** Mesma restrição que o cliente aplica em Path.db — mantém a chave fora do path do bucket. */
const KEY_RE = /^[a-zA-Z0-9_-]+$/

export const jsonDb = new Hono<App>()

// Sem chave, /json_db devolve o mesmo manifesto de /db/manifest. Precisa vir
// antes da rota com parâmetro.
jsonDb.on(['GET', 'HEAD'], '/json_db', async (c) => {
  const res = await serveObject(
    c.env.FILES,
    'meta/manifest.json',
    c.req.raw,
    'public, max-age=3600, stale-while-revalidate=86400',
  )
  return res ?? notFound(c)
})

jsonDb.on(['GET', 'HEAD'], '/json_db/:key', async (c) => {
  const key = c.req.param('key')
  if (!KEY_RE.test(key)) return notFound(c)

  const res = await serveObject(
    c.env.FILES,
    `json_db/${key}.json`,
    c.req.raw,
    'public, max-age=3600, stale-while-revalidate=86400',
  )
  return res ?? notFound(c)
})
