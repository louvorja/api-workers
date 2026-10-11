import { Hono } from 'hono'
import { COMMON_HEADERS, notFound } from '../lib/http.ts'
import {
  BUNDLE_KEY,
  BUNDLE_VARIANT_KEYS,
  CATALOG_VARIANT_KEYS,
  MANIFEST_VARIANT_KEYS,
  mediaVariantFor,
  withMediaUrls,
} from '../lib/media-urls.ts'
import { serveObject } from '../lib/r2.ts'
import type { App } from '../types.ts'

/**
 * Formato novo da API legada: mesmo conteúdo de /json_db, embrulhado em
 * { data, meta } e paginado. O violin-app ainda consome /json_db, mas o
 * manifesto e o instalador apontam para cá.
 */
const KEY_RE = /^[a-zA-Z0-9_-]+$/
const DEFAULT_PER_PAGE = 50
// Manifesto, pacote e tabelas mudam a cada publicação: uma hora de cache é o
// atraso máximo para um app perceber o catálogo novo.
const SNAPSHOT_CACHE = 'public, max-age=3600, stale-while-revalidate=86400'
// A Bíblia é estática: o pacote só muda se alguém republicar os capítulos.
const BIBLE_CACHE = 'public, max-age=86400, stale-while-revalidate=604800'
// O que carrega endereço de mídia sai diferente em cada domínio, e o cache do
// Worker tem uma chave só para todos eles: só quem pediu pode guardar.
const CATALOG_CACHE = 'private, max-age=3600'

export const db = new Hono<App>()

db.on(['GET', 'HEAD'], '/db/manifest', async (c) => {
  const res = await serveObject(
    c.env.FILES,
    MANIFEST_VARIANT_KEYS[mediaVariantFor(new URL(c.req.url).hostname)],
    c.req.raw,
    CATALOG_CACHE,
  )
  return res ?? notFound(c)
})

// Bundle somente dos capítulos bíblicos. As telas bíblicas baixam esse ZIP sob
// demanda, sem trazer catálogo, músicas e outros dados do banco.
db.on(['GET', 'HEAD'], '/db/bible-bundle', async (c) => {
  const res = await serveObject(c.env.FILES, 'meta/bible-bundle.zip', c.req.raw, BIBLE_CACHE)
  return res ?? notFound(c)
})

// O pacote inicial não traz capítulos; /db/bundle continua sendo a restauração completa.
db.on(['GET', 'HEAD'], '/db/catalog-bundle', async (c) => {
  const key = CATALOG_VARIANT_KEYS[mediaVariantFor(new URL(c.req.url).hostname)]
  return (await serveObject(c.env.FILES, key, c.req.raw, CATALOG_CACHE)) ?? notFound(c)
})

// Precisa vir antes de /db/:key, senão o curinga tenta ler json_db/bundle.json.
// Cada domínio recebe o pacote com os endereços de mídia dele já escritos. O
// pacote sem endereços é a reserva enquanto a variante não foi publicada: os
// apps completam o caminho com o endereço da API.
db.on(['GET', 'HEAD'], '/db/bundle', async (c) => {
  const variant = BUNDLE_VARIANT_KEYS[mediaVariantFor(new URL(c.req.url).hostname)]
  for (const key of [variant, BUNDLE_KEY]) {
    const res = await serveObject(c.env.FILES, key, c.req.raw, CATALOG_CACHE)
    if (res) return res
  }
  return notFound(c)
})

// Precisa vir antes de /db/:key: extrai os valores diretamente do mesmo JSON
// usado pela rota de tabela, como DatabaseJsonController@categories fazia.
db.get('/db/:table/categories', async (c) => {
  const table = c.req.param('table')
  const column = c.req.query('column')
  if (!column) {
    return c.json({ error: 'Parâmetro column é obrigatório' }, 400, {
      'Cache-Control': 'no-store',
    })
  }
  if (!KEY_RE.test(table)) return c.json({ error: 'Table not found' }, 404)

  const object = await c.env.FILES.get(`json_db/${table}.json`)
  if (object === null) return c.json({ error: 'Table not found' }, 404)

  const data = await object.json<unknown>()
  const unique = new Map<string, string | number>()
  if (Array.isArray(data)) {
    for (const item of data) {
      if (item === null || typeof item !== 'object') continue
      const value = (item as Record<string, unknown>)[column]
      if (value === null || value === undefined || value === '') continue

      // Chaves numéricas de array são inteiros em PHP; preserve esse detalhe no
      // JSON para colunas de ids e números.
      const normalized =
        typeof value === 'number'
          ? Math.trunc(value)
          : typeof value === 'boolean'
            ? value
              ? 1
              : 0
            : String(value)
      const integer =
        typeof normalized === 'string' && /^(?:0|-?[1-9]\d*)$/.test(normalized)
          ? Number(normalized)
          : normalized
      unique.set(`${typeof integer}:${integer}`, integer)
    }
  }

  const categories = [...unique.values()].sort((left, right) => {
    if (typeof left === 'number' && typeof right === 'number') return left - right
    const a = String(left)
    const b = String(right)
    return a < b ? -1 : a > b ? 1 : 0
  })
  return c.json(categories, 200, { 'Cache-Control': SNAPSHOT_CACHE })
})

db.on(['GET', 'HEAD'], '/db/:key', async (c) => {
  const key = c.req.param('key')
  if (!KEY_RE.test(key)) return notFound(c)

  const object = await c.env.FILES.get(`json_db/${key}.json`)
  if (object === null) return notFound(c)

  // Capítulo bíblico não tem mídia e sai igual em todo domínio.
  const isBible = key.startsWith('bible_')
  const text = await object.text()
  const data = JSON.parse(
    isBible ? text : withMediaUrls(text, mediaVariantFor(new URL(c.req.url).hostname)),
  ) as unknown
  const perPage = Math.max(1, Number(c.req.query('per_page')) || DEFAULT_PER_PAGE)
  const page = Math.max(1, Number(c.req.query('page')) || 1)

  // Só lista é fatiada. Registro único (config, capítulo bíblico) volta inteiro
  // e o total conta os campos — é o que a origem faz.
  const isList = Array.isArray(data)
  const total = isList ? data.length : Object.keys(data as object).length
  const body = isList ? (data as unknown[]).slice((page - 1) * perPage, page * perPage) : data

  const headers = new Headers(COMMON_HEADERS)
  headers.set('Content-Type', 'application/json')
  headers.set('Cache-Control', isBible ? SNAPSHOT_CACHE : CATALOG_CACHE)

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
