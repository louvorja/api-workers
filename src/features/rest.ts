import { type Context, Hono } from 'hono'
import { COMMON_HEADERS, notFound } from '../lib/http.ts'
import { paginate } from '../lib/paginate.ts'
import type { App } from '../types.ts'

const LANGS = new Set(['pt', 'es'])
const ID_RE = /^\d+$/
const CACHE = 'public, max-age=3600, stale-while-revalidate=86400'

export const rest = new Hono<App>()

function json(body: unknown, cache = CACHE): Response {
  const headers = new Headers(COMMON_HEADERS)
  headers.set('Content-Type', 'application/json')
  headers.set('Cache-Control', cache)
  return new Response(JSON.stringify(body), { headers })
}

/** Lê uma coleção do snapshot REST em rest/. */
async function load<T>(c: Context<App>, key: string): Promise<T | null> {
  const object = await c.env.FILES.get(`rest/${key}.json`)
  return object === null ? null : await object.json<T>()
}

type Row = Record<string, unknown>

/** Coleções servidas direto do snapshot, paginadas no formato Laravel. */
const COLLECTIONS: Record<string, string> = {
  musics: 'musics',
  albums: 'albums',
  categories: 'categories',
  hymnal: 'hymnal',
  lyrics: 'lyrics',
  files: 'files',
  albums_musics: 'albums_musics',
  categories_albums: 'categories_albums',
  languages: 'languages',
}

rest.get('/health', () =>
  json(
    {
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      services: { storage: 'ok', cache: 'ok' },
    },
    'no-store',
  ),
)

rest.get('/version', (c) =>
  json({
    api_version: '1.0.0',
    min_client_version: '1.0.0',
    runtime: 'Cloudflare Workers',
    db_version: c.env.DB_VERSION,
  }),
)

rest.get('/metadata', async (c) => {
  const data = await load<unknown>(c, 'metadata')
  return data === null ? notFound(c) : json(data)
})

for (const path of ['/:lang/config', '/:lang/configs']) {
  rest.get(path, async (c) => {
    const lang = c.req.param('lang') as string
    if (!LANGS.has(lang)) return notFound(c)
    const data = await load<Row>(c, `${lang}_config`)
    return data === null ? notFound(c) : json({ data })
  })
}

// Item de música: arquivo pré-computado com a letra já embutida, para não
// precisar varrer a coleção de letras inteira.
for (const path of ['/:lang/musics/:id', '/:lang/music/:id']) {
  rest.get(path, async (c) => {
    const lang = c.req.param('lang') as string
    const id = c.req.param('id') as string
    if (!LANGS.has(lang) || !ID_RE.test(id)) return notFound(c)
    const data = await load<Row>(c, `${lang}_music_${id}`)
    return data === null ? notFound(c) : json({ data })
  })
}

/**
 * O hinário devolve a linha da coleção — com `track` e sem envelope `data` —
 * e só resolve id que seja hino. Servir o item de música aqui daria 200 onde a
 * origem dá 404, e com outra forma.
 */
rest.get('/:lang/hymnal/:id', async (c) => {
  const lang = c.req.param('lang') as string
  const id = c.req.param('id') as string
  if (!LANGS.has(lang) || !ID_RE.test(id)) return notFound(c)
  const rows = await load<Row[]>(c, `${lang}_hymnal`)
  const hymn = rows?.find((h) => String(h.id_music) === id)
  return hymn === undefined ? notFound(c) : json(hymn)
})

rest.get('/:lang/categories/:id/albums-with-musics', async (c) => {
  const lang = c.req.param('lang') as string
  const id = c.req.param('id') as string
  if (!LANGS.has(lang) || !ID_RE.test(id)) return notFound(c)
  const data = await load<unknown>(c, `${lang}_category_${id}_awm`)
  return data === null ? notFound(c) : json(data)
})

/**
 * A origem interpola o parâmetro direto no atributo do iframe, então um valor
 * com aspas escapa do HTML. Aqui o id é restrito ao alfabeto de vídeo do
 * YouTube antes de entrar na página.
 */
const YT_ID_RE = /^[A-Za-z0-9_-]{1,32}$/

rest.get('/player', (c) => {
  const v = c.req.query('v') ?? ''
  const id = YT_ID_RE.test(v) ? v : ''
  const headers = new Headers(COMMON_HEADERS)
  headers.set('Content-Type', 'text/html; charset=UTF-8')
  headers.set('Cache-Control', 'public, max-age=3600')
  return new Response(
    `<html>
<head>
<title>Player</title>
<style>
html,body{margin:0;padding:0;background:#000;}
iframe{position:absolute;width:100%;height:100%;top:0;left:0;border:0;}
</style>
</head>
<body>
<iframe src="https://www.youtube.com/embed/${id}" title="Player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen>
</iframe>
</body>
</html>`,
    { headers },
  )
})

for (const path of ['/:lang/albums/:id', '/:lang/album/:id']) {
  rest.get(path, async (c) => {
    const lang = c.req.param('lang') as string
    const id = c.req.param('id') as string
    if (!LANGS.has(lang) || !ID_RE.test(id)) return notFound(c)
    const data = await load<Row>(c, `${lang}_album_${id}`)
    return data === null ? notFound(c) : json({ data })
  })
}

const SLUG_RE = /^[a-zA-Z0-9_-]+$/

rest.get('/:lang/albums/category/:slug', async (c) => {
  const lang = c.req.param('lang') as string
  const slug = c.req.param('slug') as string
  if (!LANGS.has(lang) || !SLUG_RE.test(slug)) return notFound(c)
  const rows = await load<Row[]>(c, `${lang}_categoryslug_${slug}_albums`)
  return rows === null ? notFound(c) : json(paginate(rows, new URL(c.req.url)))
})

rest.get('/:lang/categories/:id/albums', async (c) => {
  const lang = c.req.param('lang') as string
  const id = c.req.param('id') as string
  if (!LANGS.has(lang) || !ID_RE.test(id)) return notFound(c)
  const rows = await load<Row[]>(c, `${lang}_category_${id}_albums`)
  return rows === null ? notFound(c) : json(paginate(rows, new URL(c.req.url)))
})

rest.get('/:lang/collections/online', async (c) => {
  const object = await c.env.FILES.get('meta/onlinevideos.txt')
  if (object === null) return notFound(c)
  const headers = new Headers(COMMON_HEADERS)
  headers.set('Content-Type', 'text/html; charset=UTF-8')
  headers.set('Cache-Control', CACHE)
  return new Response(object.body, { headers })
})

for (const path of ['/download', '/:lang/download']) {
  rest.get(path, async (c) => {
    const object = await c.env.FILES.get('meta/params.json')
    const params = object === null ? null : await object.json<Record<string, string>>()
    const lang = c.req.param('lang')
    const key = lang && LANGS.has(lang) ? `${lang}_download` : 'download'
    const url = params?.[key] ?? params?.download
    return url ? c.redirect(url, 302) : notFound(c)
  })
}

// Curingas por último. `/:lang` tem um segmento só e casaria com /player,
// /health e /version se viesse antes deles.
rest.get('/:lang', (c) => {
  const lang = c.req.param('lang') as string
  return LANGS.has(lang) ? json([]) : notFound(c)
})

// Rota genérica: qualquer outra coleção conhecida do snapshot.
rest.get('/:lang/:collection', async (c) => {
  const lang = c.req.param('lang') as string
  const collection = COLLECTIONS[c.req.param('collection') as string]
  if (!LANGS.has(lang) || collection === undefined) return notFound(c)

  const rows = await load<Row[]>(c, `${lang}_${collection}`)
  return rows === null ? notFound(c) : json(paginate(rows, new URL(c.req.url)))
})
