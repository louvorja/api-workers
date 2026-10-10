import { type Context, Hono } from 'hono'
import { COMMON_HEADERS, notFound } from '../lib/http.ts'
import { serveObject } from '../lib/r2.ts'
import type { App } from '../types.ts'

type Row = Record<string, unknown>
type Kind = 'tudo' | 'canais' | 'playlists' | 'videos'
type Catalog = { channels?: Row[]; playlists?: Row[]; videos?: Row[] }

const LANGS = ['pt', 'es'] as const
const KINDS = new Set<Kind>(['tudo', 'canais', 'playlists', 'videos'])
const CACHE = 'public, max-age=3600, stale-while-revalidate=86400'

// O texto será executado no SQLite local. Aspa simples duplicada é a forma
// aceita pelo SQLite e evita que títulos do YouTube quebrem o INSERT.
const literal = (input: unknown) =>
  `'${String(input ?? '')
    // O Delphi separa instruções com ExtractStrings('|') e não reconhece
    // aspas SQL. A barra de largura cheia preserva o título sem quebrar o lote.
    .replaceAll('|', '｜')
    .replace(/'/g, "''")}'`

/**
 * Canais, playlists e vídeos validados de um idioma, como a publicação os
 * grava em rest/<lang>_collections_online.json.
 *
 * A rota é pública e sem autenticação, por isso não consulta o D1: cada
 * chamada leria o catálogo inteiro de vídeos da cota diária do banco.
 */
async function catalogOf(c: Context<App>, lang: string): Promise<Catalog | null> {
  const object = await c.env.FILES.get(`rest/${lang}_collections_online.json`)
  return object === null ? null : await object.json<Catalog>()
}

async function rows(c: Context<App>) {
  const rawKind = String(c.req.query('tipo') || 'tudo').toLowerCase() as Kind
  const kind: Kind = KINDS.has(rawKind) ? rawKind : 'tudo'
  const id = c.req.query('id') ?? ''
  const requested = c.req.query('lang') ?? c.req.query('id_language')
  const normalized = String(requested ?? 'pt').toLowerCase()
  const known = (LANGS as readonly string[]).includes(normalized) ? normalized : 'pt'
  // O retry HTTP do Delphi 26.11 perde `lang`, mas mantém o id global do canal
  // ou da playlist. Nesse caso o próprio id identifica o idioma. Requisições
  // sem id continuam em PT, como na API PHP.
  const anyLanguage = requested === undefined && id !== ''

  const primary = await catalogOf(c, anyLanguage ? 'pt' : known)
  if (primary === null) return null
  const others = anyLanguage
    ? await Promise.all(LANGS.filter((lang) => lang !== 'pt').map((lang) => catalogOf(c, lang)))
    : []
  const across = (key: 'playlists' | 'videos') => [
    ...(primary[key] ?? []),
    ...others.flatMap((catalog) => catalog?.[key] ?? []),
  ]

  const channels = kind === 'canais' || kind === 'tudo' ? (primary.channels ?? []) : undefined
  const playlists =
    kind === 'playlists' || kind === 'tudo'
      ? across('playlists').filter((row) => !id || row.channel_id === id)
      : undefined
  const videos =
    kind === 'videos' || kind === 'tudo'
      ? across('videos').filter((row) => !id || row.playlist_id === id)
      : undefined

  return { id, channels, playlists, videos }
}

export const onlineVideos = new Hono<App>()

onlineVideos.get('/onlinevideos', async (c) => {
  const data = await rows(c)
  if (data === null) {
    // Antes da primeira publicação o snapshot ainda não existe; o dump completo
    // que já está no bucket atende o caminho padrão do Delphi.
    if (
      c.req.query('tipo') ||
      c.req.query('id') ||
      c.req.query('format') ||
      c.req.query('lang') ||
      c.req.query('id_language')
    ) {
      return notFound(c)
    }
    const fallback = await serveObject(c.env.FILES, 'meta/onlinevideos.txt', c.req.raw, CACHE)
    return fallback ?? notFound(c)
  }

  c.header('Cache-Control', CACHE)
  const format = String(c.req.query('format') || 'sql').toLowerCase()
  if (format === 'json') {
    const body: Record<string, Row[]> = {}
    if (data.channels) body.channels = data.channels
    if (data.playlists) body.playlists = data.playlists
    if (data.videos) body.videos = data.videos
    return c.json(body)
  }

  const sql: string[] = []
  if (data.channels) {
    sql.push('DELETE FROM ONL_CANAIS')
    for (const row of data.channels) {
      sql.push(
        'INSERT INTO ONL_CANAIS (CANAL_ID,NOME,CUSTOM_URL,IMAGEM,IMAGEM_64) VALUES (' +
          [row.channel_id, row.title, row.custom_url, row.default_image, row.default_image_base64]
            .map(literal)
            .join(',') +
          ')',
      )
    }
  }
  if (data.playlists) {
    sql.push(`DELETE FROM ONL_PLAYLISTS${data.id ? ` WHERE CANAL_ID = ${literal(data.id)}` : ''}`)
    for (const row of data.playlists) {
      sql.push(
        'INSERT INTO ONL_PLAYLISTS (PLAYLIST_ID,CANAL_ID,NOME,IMAGEM,IMAGEM_64) VALUES (' +
          [row.playlist_id, row.channel_id, row.title, row.default_image, row.default_image_base64]
            .map(literal)
            .join(',') +
          ')',
      )
    }
  }
  if (data.videos) {
    sql.push(`DELETE FROM ONL_VIDEOS${data.id ? ` WHERE PLAYLIST_ID = ${literal(data.id)}` : ''}`)
    for (const row of data.videos) {
      sql.push(
        'INSERT INTO ONL_VIDEOS (VIDEO_ID,PLAYLIST_ID,NOME,POSICAO,IMAGEM,IMAGEM_64) VALUES (' +
          [
            row.video_id,
            row.playlist_id,
            row.title,
            row.sequence,
            row.default_image,
            row.default_image_base64,
          ]
            .map(literal)
            .join(',') +
          ')',
      )
    }
  }

  const headers = new Headers(COMMON_HEADERS)
  headers.set('Content-Type', 'text/plain; charset=UTF-8')
  headers.set('Cache-Control', CACHE)
  return new Response(`${sql.join('|')}\n`, { headers })
})
