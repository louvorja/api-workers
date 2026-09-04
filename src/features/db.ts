import { Hono } from 'hono'
import { COMMON_HEADERS, notFound } from '../lib/http.ts'
import { serveObject } from '../lib/r2.ts'
import type { App } from '../types.ts'

/**
 * Formato novo da API legada: mesmo conteúdo de /json_db, embrulhado em
 * { data, meta } e paginado. O violin-app ainda consome /json_db, mas o
 * manifesto e o instalador apontam para cá.
 */
const KEY_RE = /^[a-zA-Z0-9_-]+$/
const DEFAULT_PER_PAGE = 50
const CACHE = 'public, max-age=3600, stale-while-revalidate=86400'

export const db = new Hono<App>()

db.on(['GET', 'HEAD'], '/db/manifest', async (c) => {
  const res = await serveObject(c.env.FILES, 'meta/manifest.json', c.req.raw, CACHE)
  return res ?? notFound(c)
})

// Precisa vir antes de /db/:key, senão o curinga tenta ler json_db/bundle.json.
db.on(['GET', 'HEAD'], '/db/bundle', async (c) => {
  const res = await serveObject(c.env.FILES, 'meta/bundle.zip', c.req.raw, CACHE)
  return res ?? notFound(c)
})

db.on(['GET', 'HEAD'], '/db/:key', async (c) => {
  const key = c.req.param('key')
  if (!KEY_RE.test(key)) return notFound(c)

  const object = await c.env.FILES.get(`json_db/${key}.json`)
  if (object === null) return notFound(c)

  const data = await object.json<unknown>()
  const perPage = Math.max(1, Number(c.req.query('per_page')) || DEFAULT_PER_PAGE)
  const page = Math.max(1, Number(c.req.query('page')) || 1)

  // Só lista é fatiada. Registro único (config, capítulo bíblico) volta inteiro
  // e o total conta os campos — é o que a origem faz.
  const isList = Array.isArray(data)
  const total = isList ? data.length : Object.keys(data as object).length
  const body = isList ? (data as unknown[]).slice((page - 1) * perPage, page * perPage) : data

  const headers = new Headers(COMMON_HEADERS)
  headers.set('Content-Type', 'application/json')
  headers.set('Cache-Control', CACHE)

  return new Response(
    JSON.stringify({
      data: body,
      meta: {
        total,
        per_page: perPage,
        current_page: page,
        last_page: isList ? Math.max(1, Math.ceil(total / perPage)) : 1,
      },
    }),
    { headers },
  )
})
