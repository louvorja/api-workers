import { type Context, Hono, type MiddlewareHandler } from 'hono'
import { COMMON_HEADERS, notFound } from '../lib/http.ts'
import { type MediaVariant, withMediaUrls } from '../lib/media-urls.ts'
import { paginate } from '../lib/paginate.ts'
import { foldText } from '../lib/sql.ts'
import type { App } from '../types.ts'

const LANGS = new Set(['pt', 'es'])
const ID_RE = /^\d+$/
// Uma hora no cliente e na borda. Cada resposta sem cache é uma requisição a
// mais na cota diária do plano gratuito, e o catálogo muda poucas vezes por dia.
const CACHE = 'public, max-age=3600, stale-while-revalidate=86400'
/** Teto de registros de download por dia: mantém a escrita no D1 previsível. */
const DOWNLOAD_LOGS_PER_DAY = 500

export const rest = new Hono<App>()

function json(body: unknown, cache = CACHE, variant?: MediaVariant): Response {
  const headers = new Headers(COMMON_HEADERS)
  headers.set('Content-Type', 'application/json')
  headers.set('Cache-Control', cache)
  const text = JSON.stringify(body)
  return new Response(variant ? withMediaUrls(text, variant) : text, { headers })
}

/** A paginação depende da origem pedida: não pode usar o cache compartilhado. */
function catalogJson(body: unknown): Response {
  return json(body, 'private, max-age=3600', 'current')
}

/** Lê uma coleção do snapshot REST em rest/. */
async function load<T>(c: Context<App>, key: string): Promise<T | null> {
  const object = await c.env.FILES.get(`rest/${key}.json`)
  return object === null ? null : await object.json<T>()
}

type Row = Record<string, unknown>

export type Collection = {
  fields: string[]
  text: Set<string>
}

const collection = (fields: string[], text: string[]): Collection => ({
  fields,
  text: new Set(text),
})

/**
 * Campos aceitos por Data::data em cada controller PHP. A ordem também é a da
 * origem: ela importa quando um cliente combina filtros `or:` e filtros AND.
 */
export const COLLECTIONS: Record<string, Collection> = {
  languages: collection(['id_language', 'language'], ['id_language', 'language']),
  musics: collection(
    [
      'id_music',
      'name',
      'id_file_image',
      'url_image',
      'image_version',
      'id_file_music',
      'url_music',
      'music_version',
      'id_file_instrumental_music',
      'url_instrumental_music',
      'instrumental_music_version',
      'id_language',
      'created_at',
      'updated_at',
    ],
    ['name', 'url_image', 'url_music', 'url_instrumental_music', 'id_language'],
  ),
  categories: collection(
    ['id_category', 'name', 'slug', 'order', 'type', 'id_language'],
    ['name', 'slug', 'type', 'id_language'],
  ),
  categories_albums: collection(
    [
      'id_category_album',
      'id_category',
      'category_name',
      'id_album',
      'album_name',
      'name',
      'order',
      'id_language',
    ],
    ['category_name', 'album_name', 'name', 'id_language'],
  ),
  albums: collection(
    [
      'id_album',
      'name',
      'id_file_image',
      'url_image',
      'image_version',
      'id_language',
      'color',
      'subtitle',
      'order',
      'created_at',
      'updated_at',
    ],
    ['name', 'url_image', 'id_language', 'color', 'subtitle'],
  ),
  albums_musics: collection(
    ['id_album_music', 'id_music', 'music_name', 'id_album', 'album_name', 'track', 'id_language'],
    ['music_name', 'album_name', 'id_language'],
  ),
  lyrics: collection(
    [
      'id_lyric',
      'id_music',
      'music',
      'lyric',
      'aux_lyric',
      'id_file_image',
      'time',
      'instrumental_time',
      'show_slide',
      'order',
      'id_language',
    ],
    ['music', 'lyric', 'aux_lyric', 'time', 'instrumental_time', 'id_language'],
  ),
  hymnal: collection(
    [
      'id_music',
      'name',
      'track',
      'id_file_image',
      'url_image',
      'image_version',
      'id_file_music',
      'url_music',
      'music_version',
      'id_file_instrumental_music',
      'url_instrumental_music',
      'instrumental_music_version',
      'id_language',
      'created_at',
      'updated_at',
    ],
    ['name', 'url_image', 'url_music', 'url_instrumental_music', 'id_language'],
  ),
  files: collection(
    [
      'id_file',
      'name',
      'type',
      'size',
      'host',
      'dir',
      'file_name',
      'image_position',
      'duration',
      'version',
    ],
    ['name', 'type', 'host', 'dir', 'file_name', 'duration'],
  ),
}

type Filter = { field: string; like: boolean; or: boolean; value: unknown }

/** Mesmo pequeno protocolo de filtros de Data::whereExplode na API PHP. */
function filterOf(field: string, raw: string): Filter {
  const colon = raw.indexOf(':')
  if (colon === -1) {
    return {
      field,
      like: false,
      or: false,
      value: raw === 'true' ? true : raw === 'false' ? false : raw,
    }
  }

  const op = raw.slice(0, colon)
  const rest = raw.slice(colon + 1)
  if (op === 'like' || op === 'orlike') {
    const pattern = rest.replaceAll('*', '%')
    return {
      field,
      like: true,
      or: op === 'orlike',
      value: pattern === 'true' ? true : pattern === 'false' ? false : pattern,
    }
  }
  if (op === 'or') {
    return {
      field,
      like: false,
      or: true,
      value: rest === 'true' ? true : rest === 'false' ? false : rest,
    }
  }
  return { field, like: false, or: false, value: raw }
}

/** LIKE com `_`: programação dinâmica por caractere, sem regex nem backtracking. */
function likeWithUnderscore(text: string, pattern: string): boolean {
  const input = [...text]
  let previous = Array<boolean>(input.length + 1).fill(false)
  previous[0] = true
  for (const token of pattern) {
    const current = Array<boolean>(input.length + 1).fill(false)
    if (token === '%') current[0] = previous[0] ?? false
    for (let i = 1; i <= input.length; i++) {
      current[i] =
        token === '%'
          ? (previous[i] ?? false) || (current[i - 1] ?? false)
          : (token === '_' || token === input[i - 1]) && (previous[i - 1] ?? false)
    }
    previous = current
  }
  return previous[input.length] ?? false
}

/**
 * Compila um padrão LIKE num teste sobre o texto já dobrado.
 *
 * O padrão é preparado uma vez por requisição, não por linha. Sem `_` — o caso
 * de toda busca do painel e dos apps — ele vira uma sequência de trechos
 * procurados em ordem com `indexOf`, linear no tamanho do texto.
 */
export function likeMatcher(pattern: string): (folded: string) => boolean {
  const folded = foldText(pattern)
  if (folded.includes('_')) return (input) => likeWithUnderscore(input, folded)

  const segments = folded.split('%')
  if (segments.length === 1) return (input) => input === folded

  const first = segments[0] as string
  const last = segments[segments.length - 1] as string
  const middle = segments.slice(1, -1).filter((segment) => segment !== '')
  return (input) => {
    if (input.length < first.length + last.length || !input.startsWith(first)) return false
    let position = first.length
    for (const segment of middle) {
      const found = input.indexOf(segment, position)
      if (found === -1) return false
      position = found + segment.length
    }
    return input.length - last.length >= position && input.endsWith(last)
  }
}

type Test = (value: unknown) => boolean

/** O lado fixo da comparação (o valor pedido) é dobrado e convertido uma vez só. */
function testOf(filter: Filter, text: boolean): Test {
  if (filter.like) {
    const matches = likeMatcher(
      String(typeof filter.value === 'boolean' ? Number(filter.value) : filter.value),
    )
    return (value) => value !== null && value !== undefined && matches(foldText(String(value)))
  }

  const right = typeof filter.value === 'boolean' ? (filter.value ? 1 : 0) : filter.value
  const rightText = String(right)
  const rightFolded = foldText(rightText)
  const rightNumber = Number(right)
  return (value) => {
    if (value === null || value === undefined) return false
    if (text || typeof value === 'string') return foldText(String(value)) === rightFolded
    const leftNumber = Number(value)
    return Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
      ? leftNumber === rightNumber
      : String(value) === rightText
  }
}

function fieldValue(row: Row, collectionName: string, field: string, url: URL): unknown {
  // `host` existia no MySQL, mas no D1 foi normalizado para a origem de /file.
  if (collectionName === 'files' && field === 'host') return row.host ?? `${url.origin}/file`
  return row[field]
}

export function filterRows(rows: Row[], name: string, spec: Collection, url: URL): Row[] {
  const filters = spec.fields.flatMap((field) => {
    const raw = url.searchParams.get(field)
    if (raw === null) return []
    const filter = filterOf(field, raw)
    return [{ field, or: filter.or, test: testOf(filter, spec.text.has(field)) }]
  })
  if (filters.length === 0) return rows

  return rows.filter((row) => {
    // SQL dá precedência a AND. Cada `or:` abre um novo grupo de ANDs.
    let anyGroup = false
    let group: boolean | undefined
    for (const filter of filters) {
      // Num grupo que já falhou, os ANDs seguintes não mudam nada.
      if (group === false && !filter.or) continue
      const matches = filter.test(fieldValue(row, name, filter.field, url))
      if (group === undefined) group = matches
      else if (filter.or) {
        anyGroup ||= group
        group = matches
      } else group &&= matches
    }
    return anyGroup || group === true
  })
}

/** Valor de ordenação de uma linha; o texto dobrado é calculado no máximo uma vez. */
type SortKey = { raw: unknown; folded?: string }

function compareKeys(a: SortKey, b: SortKey, text: boolean): number {
  if (a.raw === b.raw) return 0
  if (a.raw === null || a.raw === undefined) return -1
  if (b.raw === null || b.raw === undefined) return 1
  if (!text && typeof a.raw === 'number' && typeof b.raw === 'number') return a.raw - b.raw
  a.folded ??= foldText(String(a.raw))
  b.folded ??= foldText(String(b.raw))
  return a.folded < b.folded ? -1 : a.folded > b.folded ? 1 : 0
}

export function sortRows(rows: Row[], name: string, spec: Collection, url: URL): Row[] {
  const requested = (url.searchParams.get('sort_by') ?? '').split(',').flatMap((item) => {
    const [field, direction = 'asc'] = item.split('.')
    return field ? [{ field, desc: direction.toLowerCase() === 'desc' }] : []
  })
  if (requested.length === 0) return rows

  // Vale ordenar por qualquer campo que exista em alguma linha.
  const sorts = requested
    .filter(
      ({ field }) =>
        (name === 'files' && field === 'host') || rows.some((row) => Object.hasOwn(row, field)),
    )
    .map((sort) => ({ ...sort, text: spec.text.has(sort.field) }))
  if (sorts.length === 0) return rows

  // O comparador roda perto de um milhão de vezes na coleção de letras: cada
  // linha guarda as chaves prontas em vez de dobrar o texto a cada comparação.
  const keyed = rows.map((row) => ({
    row,
    keys: sorts.map((sort): SortKey => ({ raw: fieldValue(row, name, sort.field, url) })),
  }))
  keyed.sort((left, right) => {
    for (const [index, sort] of sorts.entries()) {
      const result = compareKeys(
        left.keys[index] as SortKey,
        right.keys[index] as SortKey,
        sort.text,
      )
      if (result !== 0) return sort.desc ? -result : result
    }
    return 0
  })
  return keyed.map((entry) => entry.row)
}

function pageSize(url: URL): number {
  const limit = Math.trunc(Number(url.searchParams.get('limit')))
  if (!Number.isFinite(limit) || limit === 0) return 15
  return limit < 0 ? 9999 : limit
}

function phpInteger(raw: string): number {
  const numeric = raw.trimStart().match(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i)
  if (!numeric) return 0
  const value = Number(numeric[0])
  if (Number.isFinite(value)) return Math.trunc(value)
  return value < 0 ? Number.MIN_SAFE_INTEGER : Number.MAX_SAFE_INTEGER
}

/** Um texto só casa com coluna inteira no SQLite quando é um número bem formado. */
function sqliteInteger(raw: string): number | null {
  const text = raw.trim()
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null
  const value = Number(text)
  return Number.isInteger(value) ? value : null
}

const snapshot = async (c: Context<App>, lang: string, name: string): Promise<Row[]> =>
  (await load<Row[]>(c, `${lang}_${name}`)) ?? []

const byId = (rows: Row[], key: string) =>
  [...rows].sort((left, right) => Number(left[key]) - Number(right[key]))

/**
 * Filtros relacionais que não podem ser calculados só com uma linha do snapshot.
 *
 * Saem dos outros snapshots do mesmo idioma, nunca do D1: as rotas públicas não
 * têm autenticação, e uma consulta ao banco por chamada deixaria a cota diária
 * de leitura na mão de qualquer um.
 */
async function relationalRows(
  c: Context<App>,
  lang: string,
  name: string,
  rows: Row[],
  url: URL,
): Promise<Row[]> {
  const album = url.searchParams.get('id_album')
  if (album !== null && (name === 'musics' || name === 'lyrics')) {
    const albumId = sqliteInteger(album)
    if (albumId === null) return []
    const ids = new Set(
      (await snapshot(c, lang, 'albums_musics'))
        .filter((link) => Number(link.id_album) === albumId)
        .map((link) => String(link.id_music)),
    )
    return rows.filter((row) => ids.has(String(row.id_music)))
  }

  if (album !== null && name === 'files') {
    const albumId = phpInteger(album)
    const [albums, links, musics] = await Promise.all([
      snapshot(c, lang, 'albums'),
      snapshot(c, lang, 'albums_musics'),
      snapshot(c, lang, 'musics'),
    ])
    const ids = new Set<string>()
    const add = (value: unknown) => {
      if (value !== null && value !== undefined) ids.add(String(value))
    }
    for (const row of albums) if (Number(row.id_album) === albumId) add(row.id_file_image)
    const inAlbum = new Set(
      links
        .filter((link) => Number(link.id_album) === albumId)
        .map((link) => String(link.id_music)),
    )
    for (const music of musics) {
      if (!inAlbum.has(String(music.id_music))) continue
      add(music.id_file_music)
      add(music.id_file_instrumental_music)
      add(music.id_file_image)
    }
    // As letras são o snapshot mais pesado: só entram quando o álbum tem músicas.
    if (inAlbum.size > 0) {
      for (const lyric of await snapshot(c, lang, 'lyrics')) {
        if (inAlbum.has(String(lyric.id_music))) add(lyric.id_file_image)
      }
    }
    return rows.filter((row) => ids.has(String(row.id_file)))
  }

  const slugs = url.searchParams.get('categories_slug')
  if (slugs !== null && name === 'albums') {
    const list = new Set(slugs.split(','))
    const [categories, relations] = await Promise.all([
      snapshot(c, lang, 'categories'),
      snapshot(c, lang, 'categories_albums'),
    ])
    const wanted = new Set(
      categories
        .filter((category) => list.has(String(category.slug)))
        .map((category) => String(category.id_category)),
    )
    const byAlbum = new Map<string, Row[]>()
    for (const relation of byId(relations, 'id_category_album')) {
      if (!wanted.has(String(relation.id_category))) continue
      const key = String(relation.id_album)
      byAlbum.set(key, [...(byAlbum.get(key) ?? []), relation])
    }
    const joined = rows.flatMap((row) =>
      (byAlbum.get(String(row.id_album)) ?? []).map((relation) => ({
        ...row,
        subtitle: relation.name,
        order: relation.order,
      })),
    )
    const seen = new Set<string>()
    return joined.filter((row) => {
      const key = JSON.stringify(row)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  return rows
}

/** Expansões `with_*` do Eloquent, montadas só para as linhas da página. */
async function expandRelations(
  c: Context<App>,
  lang: string,
  name: string,
  rows: Row[],
  url: URL,
): Promise<Row[]> {
  if (name === 'musics' && Number(url.searchParams.get('with_albums')) === 1) {
    const owners = new Set(rows.map((row) => String(row.id_music)))
    const [links, albums] = await Promise.all([
      snapshot(c, lang, 'albums_musics'),
      snapshot(c, lang, 'albums'),
    ])
    const albumById = new Map(albums.map((album) => [String(album.id_album), album]))
    const byMusic = new Map<string, Row[]>()
    for (const link of byId(links, 'id_album_music')) {
      const key = String(link.id_music)
      const album = albumById.get(String(link.id_album))
      if (!owners.has(key) || !album) continue
      byMusic.set(key, [
        ...(byMusic.get(key) ?? []),
        {
          id_album: album.id_album,
          name: album.name,
          id_file_image: album.id_file_image,
          color: album.color,
          id_language: album.id_language,
          created_at: album.created_at,
          updated_at: album.updated_at,
          pivot: { id_music: link.id_music, id_album: link.id_album, track: link.track },
        },
      ])
    }
    return rows.map((row) => ({ ...row, albums: byMusic.get(String(row.id_music)) ?? [] }))
  }

  if (name === 'albums' && Number(url.searchParams.get('with_categories')) === 1) {
    const owners = new Set(rows.map((row) => String(row.id_album)))
    const [relations, categories] = await Promise.all([
      snapshot(c, lang, 'categories_albums'),
      snapshot(c, lang, 'categories'),
    ])
    const categoryById = new Map(
      categories.map((category) => [String(category.id_category), category]),
    )
    const byAlbum = new Map<string, Row[]>()
    for (const relation of byId(relations, 'id_category_album')) {
      const key = String(relation.id_album)
      const category = categoryById.get(String(relation.id_category))
      if (!owners.has(key) || !category) continue
      byAlbum.set(key, [
        ...(byAlbum.get(key) ?? []),
        {
          id_category: category.id_category,
          name: category.name,
          slug: category.slug,
          order: category.order,
          type: category.type,
          id_language: category.id_language,
          created_at: category.created_at,
          updated_at: category.updated_at,
          pivot: {
            id_album: relation.id_album,
            id_category: relation.id_category,
            name: relation.name,
            order: relation.order,
          },
        },
      ])
    }
    return rows.map((row) => ({ ...row, categories: byAlbum.get(String(row.id_album)) ?? [] }))
  }

  return rows
}

rest.get('/health', async (c) => {
  const [database, storage] = await Promise.allSettled([
    c.env.DB.prepare('SELECT 1 AS ok').first(),
    c.env.FILES.head('meta/params.json'),
  ])
  const databaseOk = database.status === 'fulfilled' && database.value !== null
  const storageOk = storage.status === 'fulfilled' && storage.value !== null
  const healthy = databaseOk && storageOk
  return c.json(
    {
      status: healthy ? 'ok' : 'error',
      timestamp: new Date().toISOString(),
      version: '1.0.0',
      services: {
        database: databaseOk ? 'ok' : 'error',
        storage: storageOk ? 'ok' : 'error',
      },
    },
    healthy ? 200 : 503,
    { 'Cache-Control': 'no-store' },
  )
})

rest.get('/version', async (c) => {
  const object = await c.env.FILES.get('meta/params.json')
  const params = object === null ? {} : await object.json<Record<string, unknown>>()
  return json({
    api_version: '1.0.0',
    min_client_version: '1.0.0',
    runtime: 'Cloudflare Workers',
    db_version: params.db_version ?? null,
  })
})

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
    return data === null ? notFound(c) : catalogJson({ data })
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
  return hymn === undefined ? notFound(c) : catalogJson(hymn)
})

rest.get('/:lang/categories/:id/albums-with-musics', async (c) => {
  const lang = c.req.param('lang') as string
  const id = c.req.param('id') as string
  if (!LANGS.has(lang) || !ID_RE.test(id)) return notFound(c)
  const data = await load<unknown>(c, `${lang}_category_${id}_awm`)
  return data === null ? notFound(c) : catalogJson(data)
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
    return data === null ? notFound(c) : catalogJson({ data })
  })
}

const SLUG_RE = /^[a-zA-Z0-9_-]+$/

/**
 * DESCONTINUADAS: as duas rotas abaixo têm chave equivalente no json_db
 * (`{lang}_doxology_albums`, `{lang}_children_albums`, `{lang}_collections_online`).
 * Seguem no ar só para versões antigas do violin-app.
 */
const markDeprecated: MiddlewareHandler<App> = async (c, next) => {
  await next()
  c.header('Deprecation', 'true')
}
rest.use('/:lang/albums/category/:slug', markDeprecated)
rest.use('/:lang/collections/online', markDeprecated)

rest.get('/:lang/albums/category/:slug', async (c) => {
  const lang = c.req.param('lang') as string
  const slug = c.req.param('slug') as string
  if (!LANGS.has(lang) || !SLUG_RE.test(slug)) return notFound(c)
  const rows = await load<Row[]>(c, `${lang}_categoryslug_${slug}_albums`)
  return rows === null ? notFound(c) : catalogJson(paginate(rows, new URL(c.req.url)))
})

rest.get('/:lang/categories/:id/albums', async (c) => {
  const lang = c.req.param('lang') as string
  const id = c.req.param('id') as string
  if (!LANGS.has(lang) || !ID_RE.test(id)) return notFound(c)
  const rows = await load<Row[]>(c, `${lang}_category_${id}_albums`)
  return rows === null ? notFound(c) : catalogJson(paginate(rows, new URL(c.req.url)))
})

rest.get('/:lang/collections/online', async (c) => {
  const lang = c.req.param('lang') as string
  if (!LANGS.has(lang)) return notFound(c)
  const data = await load<unknown>(c, `${lang}_collections_online`)
  return data === null ? notFound(c) : json(data)
})

for (const path of ['/download', '/:lang/download']) {
  rest.get(path, async (c) => {
    const object = await c.env.FILES.get('meta/params.json')
    const params = object === null ? null : await object.json<Record<string, string>>()
    const pathLang = c.req.param('lang')?.toLowerCase()
    if (pathLang && !LANGS.has(pathLang)) return notFound(c)
    const queryLang = c.req.query('lang')?.toLowerCase()
    const lang = pathLang ?? (queryLang && LANGS.has(queryLang) ? queryLang : 'pt')
    const download = params?.[`${lang}_download`] ?? params?.pt_download
    if (!download) return notFound(c)

    // Rota sem autenticação que grava no banco: um contador por dia limita os
    // registros, e depois do teto a chamada não escreve mais nada. Sem a tabela
    // do contador (migration ainda não aplicada) o registro simplesmente falha.
    const forwarded = c.req.header('X-Forwarded-For') ?? null
    const logDownload = async () => {
      await c.env.DB.batch([
        c.env.DB.prepare(
          "INSERT INTO public_write_budget (day, name, used) VALUES (date('now'), 'download', 1) " +
            'ON CONFLICT (day, name) DO UPDATE SET used = used + 1 WHERE used <= ?',
        ).bind(DOWNLOAD_LOGS_PER_DAY),
        c.env.DB.prepare(
          'INSERT INTO download_logs ' +
            '(version, ip, http_client_ip, http_x_forwarded_for, remote_addr, browser, id_language, created_at, updated_at) ' +
            "SELECT ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now') " +
            "WHERE (SELECT used FROM public_write_budget WHERE day = date('now') AND name = 'download') <= ?",
        ).bind(
          params?.[`${lang}_version`] ?? '',
          c.req.header('CF-Connecting-IP') ?? forwarded?.split(',')[0]?.trim() ?? null,
          c.req.header('Client-IP') ?? null,
          forwarded,
          c.req.header('Remote-Addr') ?? null,
          c.req.header('User-Agent') ?? null,
          lang,
          DOWNLOAD_LOGS_PER_DAY,
        ),
      ])
    }
    c.executionCtx.waitUntil(
      logDownload().catch((reason) => console.error('download_log_failed', reason)),
    )
    return c.redirect(download, 302)
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
  const name = c.req.param('collection') as string
  const spec = COLLECTIONS[name]
  if (!LANGS.has(lang) || spec === undefined) return notFound(c)

  const rows = await load<Row[]>(c, `${lang}_${name}`)
  if (rows === null) return notFound(c)

  const url = new URL(c.req.url)
  const related = await relationalRows(c, lang, name, rows, url)
  const filtered = filterRows(related, name, spec, url)
  const page = paginate(sortRows(filtered, name, spec, url), url, pageSize(url))
  page.data = await expandRelations(c, lang, name, page.data as Row[], url)
  return catalogJson(page)
})
