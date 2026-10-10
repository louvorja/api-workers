/**
 * Atualiza canais, playlists e vídeos do YouTube a partir de uma réplica SQL do
 * D1. O modo padrão apenas gera e valida o arquivo SQL; `--write` o aplica no
 * banco remoto depois que todas as respostas e thumbnails foram validadas.
 *
 *   npx wrangler d1 export louvorja --remote --output=replica.sql
 *   node --env-file=.env --experimental-strip-types scripts/refresh-online-videos.ts \
 *     --export=replica.sql [--out=refresh-online-videos.sql] [--write]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

type Row = Record<string, unknown>
type Status = 'pending' | 'validated' | 'error'

export const MAX_THUMBNAIL_BYTES = 64 * 1024
export const MAX_YOUTUBE_JSON_BYTES = 2 * 1024 * 1024
export const REQUEST_TIMEOUT_MS = 20_000
export const THUMBNAIL_CONCURRENCY = 4
export const MAX_PLAYLIST_PAGES = 1_000
export const MAX_THUMBNAIL_REDIRECTS = 3

const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3/'
// O Delphi sempre salva IMAGEM_64 com extensão .jpg e abre via TJPEGImage.
const IMAGE_TYPES = new Set(['image/jpeg'])
const IMAGE_HOSTS = ['ytimg.com', 'ggpht.com', 'googleusercontent.com']
const ID_RE = /^[A-Za-z0-9_-]{1,200}$/

export type SnapshotChannel = {
  id: number
  channelId: string
  status: Status
  playlists: string[]
  language: string
}

export type SnapshotPlaylist = {
  id: number
  channelId: number
  playlistId: string
  status: Status
  language: string
}

export type SnapshotVideo = {
  id: number
  playlistId: number
  videoId: string
}

export type Snapshot = {
  channels: SnapshotChannel[]
  playlists: SnapshotPlaylist[]
  videos: SnapshotVideo[]
}

export type YoutubeImages = {
  defaultImage: string
  mediumImage: string
  highImage: string
  standardImage: string
  maxresImage: string
}

export type YoutubeResource = YoutubeImages & {
  title: string
  description: string
  customUrl: string | null
}

export type YoutubeVideo = YoutubeImages & {
  videoId: string
  title: string
  description: string
  sequence: number
}

export type PlaylistItems = { items: YoutubeVideo[]; pages: number }

export type YoutubeClient = {
  channel: (id: string) => Promise<YoutubeResource>
  playlist: (id: string) => Promise<YoutubeResource>
  playlistItems: (id: string) => Promise<PlaylistItems>
}

export type ChannelUpdate = YoutubeResource & {
  channelId: string
  defaultImageBase64: string | null
}

export type PlaylistUpsert = YoutubeResource & {
  channelId: string
  playlistId: string
  language: string
  defaultImageBase64: string | null
}

export type VideoInsert = YoutubeVideo & {
  channelId: string
  playlistId: string
  language: string
  defaultImageBase64: string | null
}

export type ChannelFailure = {
  channelId: string
  error: string
}

export type PlaylistFailure = {
  channelId: string
  playlistId: string
  language: string
  error: string
}

export type VideoFailure = Omit<VideoInsert, 'defaultImageBase64'> & {
  error: string
}

export type RefreshPlan = {
  channels: ChannelUpdate[]
  channelFailures: ChannelFailure[]
  removedPlaylists: Array<{ channelId: string; playlistId: string }>
  playlists: PlaylistUpsert[]
  playlistFailures: PlaylistFailure[]
  removedVideos: Array<{ playlistId: string; videoId: string }>
  videos: VideoInsert[]
  videoFailures: VideoFailure[]
  report: {
    channelsValidated: number
    channelsFailed: number
    playlistsCreated: number
    playlistsValidated: number
    playlistsFailed: number
    playlistsRemoved: number
    playlistsScanned: number
    playlistPages: number
    videosCreated: number
    videosFailed: number
    videosRemoved: number
    videosKept: number
    thumbnailsDownloaded: number
  }
}

type EffectivePlaylist = {
  playlistId: string
  channelId: string
  language: string
  current?: SnapshotPlaylist
}

type ThumbnailDownloader = (url: string, label: string) => Promise<string>

/** Falhas globais ou respostas inválidas tornam inseguro continuar o lote. */
export class FatalRefreshError extends Error {
  override name = 'FatalRefreshError'
}

/** Recurso removido, privado ou indisponível; os outros itens ainda podem avançar. */
class ResourceUnavailableError extends Error {
  override name = 'ResourceUnavailableError'
}

function failureMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : fallback
  const safe = raw.replaceAll('\0', '�').trim() || fallback
  return Array.from(safe).slice(0, 2_000).join('')
}

function rethrowFatal(error: unknown): void {
  if (error instanceof FatalRefreshError) throw error
}

const isRecord = (value: unknown): value is Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

function record(value: unknown, label: string): Row {
  if (!isRecord(value)) throw new Error(`${label}: objeto ausente ou inválido`)
  return value
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label}: texto ausente ou inválido`)
  return value
}

function optionalText(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null
  return text(value, label)
}

function integer(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label}: inteiro ausente ou inválido`)
  return parsed
}

function identifier(value: unknown, label: string): string {
  const parsed = text(value, label)
  if (!ID_RE.test(parsed)) throw new Error(`${label}: identificador inválido`)
  return parsed
}

function status(value: unknown, label: string): Status {
  if (value === 'pending' || value === 'validated' || value === 'error') return value
  throw new Error(`${label}: status inválido`)
}

export function truncateTitle(value: string): string {
  return Array.from(value).slice(0, 100).join('')
}

export function parsePlaylistIds(value: unknown, channelId = 'canal'): string[] {
  let parsed = value
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown
    } catch {
      throw new Error(`${channelId}: campo playlists não contém JSON válido`)
    }
  }
  if (!Array.isArray(parsed)) throw new Error(`${channelId}: campo playlists deve ser uma lista`)

  const unique = new Set<string>()
  for (const item of parsed) unique.add(identifier(item, `${channelId}: playlist`))
  return [...unique]
}

export function validateThumbnailUrl(value: string, label = 'thumbnail'): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${label}: URL inválida`)
  }
  const host = url.hostname.toLowerCase()
  const allowedHost = IMAGE_HOSTS.some((base) => host === base || host.endsWith(`.${base}`))
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    !allowedHost ||
    value.length > 2_048
  ) {
    throw new Error(`${label}: origem de imagem não permitida`)
  }
  return url.toString()
}

function imageUrl(thumbnails: Row, key: string, label: string): string {
  const candidate = thumbnails[key]
  if (candidate === null || candidate === undefined) return ''
  const url = text(record(candidate, `${label}.${key}`).url, `${label}.${key}.url`)
  return validateThumbnailUrl(url, `${label}.${key}`)
}

function parseImages(snippet: Row, label: string): YoutubeImages {
  const value = snippet.thumbnails
  if (value === null || value === undefined) {
    return { defaultImage: '', mediumImage: '', highImage: '', standardImage: '', maxresImage: '' }
  }
  const thumbnails = record(value, `${label}.thumbnails`)
  const high = imageUrl(thumbnails, 'high', `${label}.thumbnails`)
  return {
    defaultImage: imageUrl(thumbnails, 'default', `${label}.thumbnails`),
    mediumImage: imageUrl(thumbnails, 'medium', `${label}.thumbnails`),
    highImage: high,
    // A API PHP publicava `high` neste campo, apesar do nome `standard`.
    standardImage: high,
    maxresImage: imageUrl(thumbnails, 'maxres', `${label}.thumbnails`),
  }
}

export function parseResourceResponse(
  payload: unknown,
  expectedId: string,
  kind: 'canal' | 'playlist',
): YoutubeResource {
  const root = record(payload, `YouTube ${kind} ${expectedId}`)
  if (!Array.isArray(root.items)) throw new Error(`YouTube ${kind} ${expectedId}: items inválido`)
  const item = root.items.find(
    (candidate) => isRecord(candidate) && optionalText(candidate.id, 'id') === expectedId,
  )
  if (!item || !isRecord(item)) {
    throw new ResourceUnavailableError(`YouTube ${kind} ${expectedId}: não encontrado`)
  }
  const snippet = record(item.snippet, `YouTube ${kind} ${expectedId}.snippet`)
  return {
    title: truncateTitle(text(snippet.title, `YouTube ${kind} ${expectedId}.title`)),
    description: text(snippet.description, `YouTube ${kind} ${expectedId}.description`),
    customUrl:
      kind === 'canal'
        ? optionalText(snippet.customUrl, `YouTube ${kind} ${expectedId}.customUrl`)
        : null,
    ...parseImages(snippet, `YouTube ${kind} ${expectedId}`),
  }
}

export function parsePlaylistItemsPage(
  payload: unknown,
  playlistId: string,
): { items: YoutubeVideo[]; nextPageToken?: string } {
  const root = record(payload, `YouTube playlistItems ${playlistId}`)
  if (!Array.isArray(root.items)) {
    throw new Error(`YouTube playlistItems ${playlistId}: items inválido`)
  }
  const next = optionalText(root.nextPageToken, `YouTube playlistItems ${playlistId}.nextPageToken`)
  if (next !== null && (!next || next.length > 1_024)) {
    throw new Error(`YouTube playlistItems ${playlistId}: nextPageToken inválido`)
  }

  const items: YoutubeVideo[] = []
  for (const [index, value] of root.items.entries()) {
    const snippet = record(value, `YouTube playlistItems ${playlistId}[${index}]`).snippet
    const data = record(snippet, `YouTube playlistItems ${playlistId}[${index}].snippet`)
    const thumbnails = data.thumbnails
    // Vídeos privados/removidos chegam sem thumbnails; o PHP também os ignorava.
    if (!isRecord(thumbnails) || Object.keys(thumbnails).length === 0) continue
    const resource = record(
      data.resourceId,
      `YouTube playlistItems ${playlistId}[${index}].resourceId`,
    )
    const position = integer(
      data.position,
      `YouTube playlistItems ${playlistId}[${index}].position`,
    )
    if (position < 0)
      throw new Error(`YouTube playlistItems ${playlistId}[${index}]: posição inválida`)
    items.push({
      videoId: identifier(
        resource.videoId,
        `YouTube playlistItems ${playlistId}[${index}].videoId`,
      ),
      title: truncateTitle(text(data.title, `YouTube playlistItems ${playlistId}[${index}].title`)),
      description: text(
        data.description,
        `YouTube playlistItems ${playlistId}[${index}].description`,
      ),
      sequence: position,
      ...parseImages(data, `YouTube playlistItems ${playlistId}[${index}]`),
    })
  }
  return next === null ? { items } : { items, nextPageToken: next }
}

async function readLimited(response: Response, limit: number, label: string): Promise<Uint8Array> {
  const length = response.headers.get('content-length')
  if (length !== null) {
    const parsed = Number(length)
    if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > limit) {
      throw new Error(`${label}: tamanho excede o limite de ${limit} bytes`)
    }
  }
  if (!response.body) throw new Error(`${label}: resposta sem corpo`)

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      total += chunk.value.byteLength
      if (total > limit) {
        await reader.cancel()
        throw new Error(`${label}: tamanho excede o limite de ${limit} bytes`)
      }
      chunks.push(chunk.value)
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${label}:`)) throw error
    throw new Error(`${label}: falha ao ler a resposta`)
  }

  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

function imageSignatureMatches(type: string, body: Uint8Array): boolean {
  if (type === 'image/jpeg') return body.length >= 3 && body[0] === 0xff && body[1] === 0xd8
  return false
}

export async function downloadThumbnail(
  url: string,
  label: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  let currentUrl = validateThumbnailUrl(url, label)
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  let response: Response | undefined
  for (let redirects = 0; redirects <= MAX_THUMBNAIL_REDIRECTS; redirects++) {
    try {
      response = await fetchImpl(currentUrl, {
        headers: { Accept: 'image/jpeg' },
        redirect: 'manual',
        signal,
      })
    } catch {
      throw new Error(`${label}: falha de rede ao baixar thumbnail`)
    }
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    const location = response.headers.get('location')
    if (!location || redirects === MAX_THUMBNAIL_REDIRECTS) {
      throw new Error(`${label}: redirecionamentos demais na thumbnail`)
    }
    currentUrl = validateThumbnailUrl(
      new URL(location, currentUrl).toString(),
      `${label}: redirecionamento`,
    )
  }
  if (!response) throw new Error(`${label}: resposta ausente ao baixar thumbnail`)
  if (!response.ok) throw new Error(`${label}: thumbnail respondeu HTTP ${response.status}`)
  if (response.url) validateThumbnailUrl(response.url, `${label}: redirecionamento`)

  const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim()
  if (!contentType || !IMAGE_TYPES.has(contentType)) {
    throw new Error(`${label}: tipo de thumbnail inválido`)
  }
  const body = await readLimited(response, MAX_THUMBNAIL_BYTES, label)
  if (body.length === 0 || !imageSignatureMatches(contentType, body)) {
    throw new Error(`${label}: conteúdo não corresponde ao tipo da thumbnail`)
  }
  return `data:${contentType};base64,${Buffer.from(body).toString('base64')}`
}

async function youtubeJson(
  fetchImpl: typeof fetch,
  apiKey: string,
  resource: string,
  params: Record<string, string>,
  label: string,
): Promise<unknown> {
  const url = new URL(resource, YOUTUBE_API)
  for (const [key, value] of Object.entries({ ...params, key: apiKey })) {
    url.searchParams.set(key, value)
  }

  let response: Response
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new Error(`${label}: falha de rede ao consultar o YouTube`)
  }
  if (!response.ok) {
    let reasons: string[] = []
    const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim()
    if (contentType === 'application/json' || contentType?.endsWith('+json')) {
      try {
        const body = await readLimited(response, MAX_YOUTUBE_JSON_BYTES, label)
        const payload = JSON.parse(new TextDecoder().decode(body)) as unknown
        if (isRecord(payload) && isRecord(payload.error) && Array.isArray(payload.error.errors)) {
          reasons = payload.error.errors
            .filter(isRecord)
            .map((item) => item.reason)
            .filter((reason): reason is string => typeof reason === 'string')
        }
      } catch {
        throw new FatalRefreshError(`${label}: resposta de erro inválida do YouTube`)
      }
    }
    const unavailable = new Set([
      'channelNotFound',
      'playlistNotFound',
      'playlistItemsNotAccessible',
      'videoNotFound',
    ])
    const message = `${label}: YouTube respondeu HTTP ${response.status}`
    if (response.status === 404 || reasons.some((reason) => unavailable.has(reason))) {
      throw new ResourceUnavailableError(message)
    }
    throw new FatalRefreshError(message)
  }
  const contentType = (response.headers.get('content-type') ?? '').split(';', 1)[0]?.trim()
  if (contentType !== 'application/json' && !contentType?.endsWith('+json')) {
    throw new FatalRefreshError(`${label}: YouTube respondeu conteúdo não JSON`)
  }

  let body: Uint8Array
  try {
    body = await readLimited(response, MAX_YOUTUBE_JSON_BYTES, label)
  } catch (error) {
    throw new FatalRefreshError(failureMessage(error, `${label}: resposta inválida`))
  }
  let decoded: string
  try {
    decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body)
  } catch {
    throw new FatalRefreshError(`${label}: YouTube respondeu texto inválido`)
  }
  try {
    return JSON.parse(decoded) as unknown
  } catch {
    throw new FatalRefreshError(`${label}: YouTube respondeu JSON inválido`)
  }
}

export function createYoutubeClient(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): YoutubeClient {
  if (!apiKey.trim()) throw new Error('YOUTUBE_API_KEY não configurada')
  return {
    async channel(id) {
      const payload = await youtubeJson(
        fetchImpl,
        apiKey,
        'channels',
        { part: 'snippet', id },
        `canal ${id}`,
      )
      try {
        return parseResourceResponse(payload, id, 'canal')
      } catch (error) {
        if (error instanceof ResourceUnavailableError) throw error
        throw new FatalRefreshError(failureMessage(error, `canal ${id}: resposta inválida`))
      }
    },
    async playlist(id) {
      const payload = await youtubeJson(
        fetchImpl,
        apiKey,
        'playlists',
        { part: 'snippet', id },
        `playlist ${id}`,
      )
      try {
        return parseResourceResponse(payload, id, 'playlist')
      } catch (error) {
        if (error instanceof ResourceUnavailableError) throw error
        throw new FatalRefreshError(failureMessage(error, `playlist ${id}: resposta inválida`))
      }
    },
    async playlistItems(id) {
      const items: YoutubeVideo[] = []
      const tokens = new Set<string>()
      let pageToken: string | undefined
      let pages = 0
      do {
        if (++pages > MAX_PLAYLIST_PAGES) {
          throw new Error(`playlist ${id}: excedeu ${MAX_PLAYLIST_PAGES} páginas`)
        }
        const params: Record<string, string> = {
          part: 'snippet',
          playlistId: id,
          maxResults: '50',
        }
        if (pageToken) params.pageToken = pageToken
        const payload = await youtubeJson(
          fetchImpl,
          apiKey,
          'playlistItems',
          params,
          `playlistItems ${id} página ${pages}`,
        )
        let page: ReturnType<typeof parsePlaylistItemsPage>
        try {
          page = parsePlaylistItemsPage(payload, id)
        } catch (error) {
          throw new FatalRefreshError(
            failureMessage(error, `playlistItems ${id}: resposta inválida`),
          )
        }
        items.push(...page.items)
        pageToken = page.nextPageToken
        if (pageToken) {
          if (tokens.has(pageToken)) {
            throw new FatalRefreshError(`playlist ${id}: paginação repetiu o token`)
          }
          tokens.add(pageToken)
        }
      } while (pageToken)
      return { items, pages }
    },
  }
}

export async function mapLimit<T, R>(
  values: readonly T[],
  limit: number,
  work: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limite de concorrência inválido')
  const results = new Array<R>(values.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++
      results[index] = await work(values[index] as T, index)
    }
  })
  await Promise.all(runners)
  return results
}

export function loadSnapshot(db: DatabaseSync): Snapshot {
  const channels = db
    .prepare(
      'SELECT id_online_video_channel, channel_id, status, playlists, id_language ' +
        'FROM online_videos_channels ORDER BY id_online_video_channel',
    )
    .all()
    .map((source) => {
      const row = source as Row
      const channelId = identifier(row.channel_id, 'online_videos_channels.channel_id')
      return {
        id: integer(row.id_online_video_channel, `${channelId}.id`),
        channelId,
        status: status(row.status, `${channelId}.status`),
        playlists: parsePlaylistIds(row.playlists, channelId),
        language: text(row.id_language, `${channelId}.id_language`),
      }
    })
  const playlists = db
    .prepare(
      'SELECT id_online_video_playlist, id_online_video_channel, playlist_id, status, id_language ' +
        'FROM online_videos_playlists ORDER BY id_online_video_playlist',
    )
    .all()
    .map((source) => {
      const row = source as Row
      const playlistId = identifier(row.playlist_id, 'online_videos_playlists.playlist_id')
      return {
        id: integer(row.id_online_video_playlist, `${playlistId}.id`),
        channelId: integer(row.id_online_video_channel, `${playlistId}.channel`),
        playlistId,
        status: status(row.status, `${playlistId}.status`),
        language: text(row.id_language, `${playlistId}.id_language`),
      }
    })
  const videos = db
    .prepare(
      'SELECT id_online_video, id_online_video_playlist, video_id ' +
        'FROM online_videos ORDER BY id_online_video',
    )
    .all()
    .map((source) => {
      const row = source as Row
      const videoId = identifier(row.video_id, 'online_videos.video_id')
      return {
        id: integer(row.id_online_video, `${videoId}.id`),
        playlistId: integer(row.id_online_video_playlist, `${videoId}.playlist`),
        videoId,
      }
    })
  return { channels, playlists, videos }
}

export async function buildRefreshPlan(
  snapshot: Snapshot,
  youtube: YoutubeClient,
  thumbnail: ThumbnailDownloader,
): Promise<RefreshPlan> {
  const channels: ChannelUpdate[] = []
  const channelFailures: ChannelFailure[] = []
  const removedPlaylists: RefreshPlan['removedPlaylists'] = []
  const playlists: PlaylistUpsert[] = []
  const playlistFailureById = new Map<string, PlaylistFailure>()
  const removedVideos: RefreshPlan['removedVideos'] = []
  const videoCandidates: Omit<VideoInsert, 'defaultImageBase64'>[] = []
  const report: RefreshPlan['report'] = {
    channelsValidated: 0,
    channelsFailed: 0,
    playlistsCreated: 0,
    playlistsValidated: 0,
    playlistsFailed: 0,
    playlistsRemoved: 0,
    playlistsScanned: 0,
    playlistPages: 0,
    videosCreated: 0,
    videosFailed: 0,
    videosRemoved: 0,
    videosKept: 0,
    thumbnailsDownloaded: 0,
  }

  const thumbnailCache = new Map<string, Promise<string>>()
  const image = async (url: string, label: string): Promise<string | null> => {
    if (!url) return null
    let pending = thumbnailCache.get(url)
    if (!pending) {
      pending = thumbnail(url, label)
      thumbnailCache.set(url, pending)
      report.thumbnailsDownloaded++
    }
    return pending
  }

  for (const channel of snapshot.channels) {
    if (channel.status !== 'pending') continue
    try {
      const resource = await youtube.channel(channel.channelId)
      channels.push({
        channelId: channel.channelId,
        ...resource,
        defaultImageBase64: await image(resource.defaultImage, `canal ${channel.channelId}`),
      })
      report.channelsValidated++
    } catch (error) {
      rethrowFatal(error)
      channelFailures.push({
        channelId: channel.channelId,
        error: failureMessage(error, `canal ${channel.channelId}: falha desconhecida`),
      })
      report.channelsFailed++
    }
  }

  const channelById = new Map(snapshot.channels.map((channel) => [channel.id, channel]))
  const playlistByNaturalId = new Map<string, SnapshotPlaylist>()
  for (const playlist of snapshot.playlists) {
    if (!channelById.has(playlist.channelId)) {
      throw new Error(`playlist ${playlist.playlistId}: canal interno ausente`)
    }
    if (playlistByNaturalId.has(playlist.playlistId)) {
      throw new Error(`playlist ${playlist.playlistId}: identificador duplicado na réplica`)
    }
    playlistByNaturalId.set(playlist.playlistId, playlist)
  }

  const effective: EffectivePlaylist[] = []
  for (const channel of snapshot.channels) {
    const declared = new Set(channel.playlists)
    for (const current of snapshot.playlists) {
      if (current.channelId === channel.id && !declared.has(current.playlistId)) {
        removedPlaylists.push({ channelId: channel.channelId, playlistId: current.playlistId })
        report.playlistsRemoved++
      }
    }
    for (const playlistId of channel.playlists) {
      const current = playlistByNaturalId.get(playlistId)
      if (current && current.channelId !== channel.id) {
        const owner = channelById.get(current.channelId)?.channelId ?? String(current.channelId)
        throw new Error(
          `playlist ${playlistId}: declarada pelos canais ${owner} e ${channel.channelId}`,
        )
      }
      effective.push({
        playlistId,
        channelId: channel.channelId,
        language: channel.language,
        ...(current ? { current } : {}),
      })
    }
  }

  for (const playlist of effective) {
    if (playlist.current && playlist.current.status !== 'pending') continue
    try {
      const resource = await youtube.playlist(playlist.playlistId)
      playlists.push({
        channelId: playlist.channelId,
        playlistId: playlist.playlistId,
        language: playlist.language,
        ...resource,
        defaultImageBase64: await image(resource.defaultImage, `playlist ${playlist.playlistId}`),
      })
      report.playlistsValidated++
    } catch (error) {
      rethrowFatal(error)
      playlistFailureById.set(playlist.playlistId, {
        channelId: playlist.channelId,
        playlistId: playlist.playlistId,
        language: playlist.language,
        error: failureMessage(error, `playlist ${playlist.playlistId}: falha desconhecida`),
      })
    }
    if (!playlist.current) report.playlistsCreated++
  }

  const videosByPlaylist = new Map<number, SnapshotVideo[]>()
  for (const video of snapshot.videos) {
    const list = videosByPlaylist.get(video.playlistId) ?? []
    list.push(video)
    videosByPlaylist.set(video.playlistId, list)
  }

  for (const playlist of effective) {
    let fetched: PlaylistItems
    try {
      fetched = await youtube.playlistItems(playlist.playlistId)
    } catch (error) {
      rethrowFatal(error)
      if (!playlistFailureById.has(playlist.playlistId)) {
        playlistFailureById.set(playlist.playlistId, {
          channelId: playlist.channelId,
          playlistId: playlist.playlistId,
          language: playlist.language,
          error: failureMessage(error, `playlist ${playlist.playlistId}: falha desconhecida`),
        })
      }
      continue
    }
    report.playlistsScanned++
    report.playlistPages += fetched.pages
    const desired = new Map<string, YoutubeVideo>()
    for (const video of fetched.items) {
      if (!desired.has(video.videoId)) desired.set(video.videoId, video)
    }
    const current = playlist.current ? (videosByPlaylist.get(playlist.current.id) ?? []) : []
    const currentIds = new Set(current.map((video) => video.videoId))

    for (const video of current) {
      if (!desired.has(video.videoId)) {
        removedVideos.push({ playlistId: playlist.playlistId, videoId: video.videoId })
        report.videosRemoved++
      } else {
        report.videosKept++
      }
    }
    for (const video of desired.values()) {
      if (currentIds.has(video.videoId)) continue
      videoCandidates.push({
        channelId: playlist.channelId,
        playlistId: playlist.playlistId,
        language: playlist.language,
        ...video,
      })
      report.videosCreated++
    }
  }

  const videoResults = await mapLimit(
    videoCandidates,
    THUMBNAIL_CONCURRENCY,
    async (video): Promise<{ video: VideoInsert } | { failure: VideoFailure }> => {
      try {
        return {
          video: {
            ...video,
            defaultImageBase64: await image(
              video.defaultImage,
              `vídeo ${video.videoId} da playlist ${video.playlistId}`,
            ),
          },
        }
      } catch (error) {
        rethrowFatal(error)
        return {
          failure: {
            ...video,
            error: failureMessage(error, `vídeo ${video.videoId}: falha desconhecida`),
          },
        }
      }
    },
  )
  const videos: VideoInsert[] = []
  const videoFailures: VideoFailure[] = []
  for (const result of videoResults) {
    if ('video' in result) videos.push(result.video)
    else videoFailures.push(result.failure)
  }
  const playlistFailures = [...playlistFailureById.values()]
  report.playlistsFailed = playlistFailures.length
  report.videosFailed = videoFailures.length

  return {
    channels,
    channelFailures,
    removedPlaylists,
    playlists,
    playlistFailures,
    removedVideos,
    videos,
    videoFailures,
    report,
  }
}

export type SqlValue = string | number | boolean | null

export function sqlLiteral(value: SqlValue): string {
  if (value === null) return 'NULL'
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('número não finito no SQL')
    return String(value)
  }
  if (value.includes('\0')) throw new Error('texto com byte NUL não pode ser gravado no SQL')
  return `'${value.replaceAll("'", "''")}'`
}

const assignments = (values: Record<string, SqlValue>) =>
  Object.entries(values)
    .map(([column, value]) => `"${column}" = ${sqlLiteral(value)}`)
    .join(', ')

export function buildMutationSql(plan: RefreshPlan, timestamp: string): string {
  const statements: string[] = []
  for (const channel of plan.channels) {
    statements.push(
      'UPDATE online_videos_channels SET ' +
        assignments({
          title: channel.title,
          description: channel.description,
          custom_url: channel.customUrl,
          default_image: channel.defaultImage,
          medium_image: channel.mediumImage,
          high_image: channel.highImage,
          default_image_base64: channel.defaultImageBase64,
          error: null,
          status: 'validated',
          updated_at: timestamp,
        }) +
        ` WHERE channel_id = ${sqlLiteral(channel.channelId)} AND status = 'pending';`,
    )
  }
  for (const channel of plan.channelFailures) {
    statements.push(
      'UPDATE online_videos_channels SET ' +
        assignments({ error: channel.error, status: 'error', updated_at: timestamp }) +
        ` WHERE channel_id = ${sqlLiteral(channel.channelId)} AND status = 'pending';`,
    )
  }
  for (const removed of plan.removedPlaylists) {
    statements.push(
      'DELETE FROM online_videos_playlists ' +
        `WHERE playlist_id = ${sqlLiteral(removed.playlistId)} ` +
        'AND id_online_video_channel = ' +
        `(SELECT id_online_video_channel FROM online_videos_channels WHERE channel_id = ${sqlLiteral(removed.channelId)});`,
    )
  }
  for (const playlist of plan.playlists) {
    const columns = [
      'id_online_video_channel',
      'playlist_id',
      'title',
      'description',
      'default_image',
      'medium_image',
      'high_image',
      'standard_image',
      'maxres_image',
      'default_image_base64',
      'error',
      'status',
      'id_language',
      'created_at',
      'updated_at',
    ]
    const values: SqlValue[] = [
      playlist.playlistId,
      playlist.title,
      playlist.description,
      playlist.defaultImage,
      playlist.mediumImage,
      playlist.highImage,
      playlist.standardImage,
      playlist.maxresImage,
      playlist.defaultImageBase64,
      null,
      'validated',
      playlist.language,
      timestamp,
      timestamp,
    ]
    statements.push(
      `INSERT INTO online_videos_playlists (${columns.map((column) => `"${column}"`).join(', ')}) ` +
        'VALUES (' +
        `(SELECT id_online_video_channel FROM online_videos_channels WHERE channel_id = ${sqlLiteral(playlist.channelId)}), ` +
        `${values.map(sqlLiteral).join(', ')}) ` +
        'ON CONFLICT(playlist_id) DO UPDATE SET ' +
        '"id_online_video_channel" = CASE ' +
        'WHEN online_videos_playlists.id_online_video_channel = excluded.id_online_video_channel ' +
        'THEN excluded.id_online_video_channel ELSE NULL END, ' +
        assignments({
          title: playlist.title,
          description: playlist.description,
          default_image: playlist.defaultImage,
          medium_image: playlist.mediumImage,
          high_image: playlist.highImage,
          standard_image: playlist.standardImage,
          maxres_image: playlist.maxresImage,
          default_image_base64: playlist.defaultImageBase64,
          error: null,
          status: 'validated',
          id_language: playlist.language,
          updated_at: timestamp,
        }) +
        ';',
    )
  }
  for (const playlist of plan.playlistFailures) {
    statements.push(
      'INSERT INTO online_videos_playlists ' +
        '("id_online_video_channel", "playlist_id", "error", "status", "id_language", "created_at", "updated_at") ' +
        'VALUES (' +
        `(SELECT id_online_video_channel FROM online_videos_channels WHERE channel_id = ${sqlLiteral(playlist.channelId)}), ` +
        `${sqlLiteral(playlist.playlistId)}, ${sqlLiteral(playlist.error)}, 'error', ` +
        `${sqlLiteral(playlist.language)}, ${sqlLiteral(timestamp)}, ${sqlLiteral(timestamp)}) ` +
        'ON CONFLICT(playlist_id) DO UPDATE SET ' +
        assignments({ error: playlist.error, status: 'error', updated_at: timestamp }) +
        ';',
    )
  }
  for (const removed of plan.removedVideos) {
    statements.push(
      'DELETE FROM online_videos ' +
        `WHERE video_id = ${sqlLiteral(removed.videoId)} ` +
        'AND id_online_video_playlist = ' +
        `(SELECT id_online_video_playlist FROM online_videos_playlists WHERE playlist_id = ${sqlLiteral(removed.playlistId)});`,
    )
  }
  for (const video of plan.videos) {
    const columns = [
      'id_online_video_playlist',
      'video_id',
      'title',
      'description',
      'sequence',
      'default_image',
      'medium_image',
      'high_image',
      'standard_image',
      'maxres_image',
      'default_image_base64',
      'error',
      'status',
      'id_language',
      'created_at',
      'updated_at',
    ]
    const values: SqlValue[] = [
      video.videoId,
      video.title,
      video.description,
      video.sequence,
      video.defaultImage,
      video.mediumImage,
      video.highImage,
      video.standardImage,
      video.maxresImage,
      video.defaultImageBase64,
      null,
      'validated',
      video.language,
      timestamp,
      timestamp,
    ]
    statements.push(
      `INSERT INTO online_videos (${columns.map((column) => `"${column}"`).join(', ')}) ` +
        'VALUES (' +
        '(SELECT p.id_online_video_playlist FROM online_videos_playlists p ' +
        'JOIN online_videos_channels c ' +
        'ON c.id_online_video_channel = p.id_online_video_channel ' +
        `WHERE p.playlist_id = ${sqlLiteral(video.playlistId)} ` +
        `AND c.channel_id = ${sqlLiteral(video.channelId)}), ` +
        `${values.map(sqlLiteral).join(', ')}) ` +
        'ON CONFLICT(id_online_video_playlist, video_id) DO NOTHING;',
    )
  }
  for (const video of plan.videoFailures) {
    const columns = [
      'id_online_video_playlist',
      'video_id',
      'title',
      'description',
      'sequence',
      'default_image',
      'medium_image',
      'high_image',
      'standard_image',
      'maxres_image',
      'default_image_base64',
      'error',
      'status',
      'id_language',
      'created_at',
      'updated_at',
    ]
    const values: SqlValue[] = [
      video.videoId,
      video.title,
      video.description,
      video.sequence,
      video.defaultImage,
      video.mediumImage,
      video.highImage,
      video.standardImage,
      video.maxresImage,
      null,
      video.error,
      'error',
      video.language,
      timestamp,
      timestamp,
    ]
    statements.push(
      `INSERT INTO online_videos (${columns.map((column) => `"${column}"`).join(', ')}) ` +
        'VALUES (' +
        '(SELECT p.id_online_video_playlist FROM online_videos_playlists p ' +
        'JOIN online_videos_channels c ' +
        'ON c.id_online_video_channel = p.id_online_video_channel ' +
        `WHERE p.playlist_id = ${sqlLiteral(video.playlistId)} ` +
        `AND c.channel_id = ${sqlLiteral(video.channelId)}), ` +
        `${values.map(sqlLiteral).join(', ')}) ` +
        'ON CONFLICT(id_online_video_playlist, video_id) DO UPDATE SET ' +
        assignments({ error: video.error, status: 'error', updated_at: timestamp }) +
        ';',
    )
  }

  if (statements.length === 0) return '-- Nenhuma alteração de vídeos online.\n'
  return `-- Gerado por scripts/refresh-online-videos.ts; não contém a chave do YouTube.\n${statements.join('\n')}\n`
}

export function validateMutationSql(exportSql: string, mutationSql: string): void {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(readFileSync(exportSql, 'utf8'))
    db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;')
    try {
      db.exec(mutationSql)
      const violations = db.prepare('PRAGMA foreign_key_check').all()
      if (violations.length > 0) {
        throw new Error(`SQL gerou ${violations.length} violação(ões) de chave estrangeira`)
      }
    } finally {
      db.exec('ROLLBACK')
    }
  } finally {
    db.close()
  }
}

function writeAtomic(path: string, contents: string): void {
  const absolute = resolve(path)
  mkdirSync(dirname(absolute), { recursive: true })
  const staging = `${absolute}.tmp-${process.pid}`
  try {
    writeFileSync(staging, contents, { encoding: 'utf8', mode: 0o600 })
    renameSync(staging, absolute)
  } finally {
    rmSync(staging, { force: true })
  }
}

export type RefreshOptions = {
  exportSql: string
  outputSql?: string
  database?: string
  write?: boolean
  apiKey: string
  fetchImpl?: typeof fetch
  now?: Date
  execute?: (database: string, sqlFile: string) => void
}

export async function refreshOnlineVideos(options: RefreshOptions) {
  const exportSql = resolve(options.exportSql)
  if (!existsSync(exportSql)) throw new Error(`export D1 não encontrado: ${options.exportSql}`)
  if (!options.apiKey.trim()) throw new Error('YOUTUBE_API_KEY não configurada')
  const outputSql = resolve(options.outputSql ?? 'refresh-online-videos.sql')
  if (outputSql === exportSql) throw new Error('o SQL de saída não pode sobrescrever o export D1')

  const db = new DatabaseSync(':memory:')
  let snapshot: Snapshot
  try {
    db.exec(readFileSync(exportSql, 'utf8'))
    snapshot = loadSnapshot(db)
  } finally {
    db.close()
  }

  const fetchImpl = options.fetchImpl ?? fetch
  const youtube = createYoutubeClient(options.apiKey, fetchImpl)
  const plan = await buildRefreshPlan(snapshot, youtube, (url, label) =>
    downloadThumbnail(url, label, fetchImpl),
  )
  const timestamp = (options.now ?? new Date()).toISOString().slice(0, 19).replace('T', ' ')
  const sql = buildMutationSql(plan, timestamp)
  validateMutationSql(exportSql, sql)
  writeAtomic(outputSql, sql)

  const statements =
    plan.channels.length +
    plan.channelFailures.length +
    plan.removedPlaylists.length +
    plan.playlists.length +
    plan.playlistFailures.length +
    plan.removedVideos.length +
    plan.videos.length +
    plan.videoFailures.length

  if (options.write && statements > 0) {
    const database = options.database?.trim() || 'louvorja'
    const execute =
      options.execute ??
      ((name: string, file: string) => {
        execFileSync(
          'npx',
          ['wrangler', 'd1', 'execute', name, '--remote', `--file=${file}`, '--yes'],
          { stdio: 'inherit' },
        )
      })
    execute(database, outputSql)
  }
  return { plan, sql, outputSql, statements }
}

function argsMap(argv: string[]) {
  return new Map(
    argv.map((argument) => {
      const [key, ...value] = argument.replace(/^--/, '').split('=')
      return [key as string, value.join('=')] as const
    }),
  )
}

async function cli() {
  const args = argsMap(process.argv.slice(2))
  if (args.has('help')) {
    console.log(
      'Uso: npm run online-videos:refresh -- --export=replica.sql ' +
        '[--out=refresh-online-videos.sql] [--database=louvorja] [--write]',
    )
    return
  }
  const exportSql = args.get('export')
  if (!exportSql) throw new Error('informe --export=<arquivo do wrangler d1 export>')
  const result = await refreshOnlineVideos({
    exportSql,
    outputSql: args.get('out') || undefined,
    database: args.get('database') || undefined,
    write: args.has('write'),
    apiKey: process.env.YOUTUBE_API_KEY ?? '',
  })
  const report = result.plan.report
  console.log(`SQL validado: ${result.outputSql} (${result.statements} instruções)`)
  console.log(
    `Canais: ${report.channelsValidated} validados, ${report.channelsFailed} com erro; playlists: ` +
      `${report.playlistsCreated} criadas, ${report.playlistsValidated} validadas, ` +
      `${report.playlistsFailed} com erro, ${report.playlistsRemoved} removidas, ` +
      `${report.playlistsScanned} consultadas ` +
      `em ${report.playlistPages} página(s).`,
  )
  console.log(
    `Vídeos: ${report.videosCreated} criados, ${report.videosFailed} com erro, ` +
      `${report.videosRemoved} removidos, ` +
      `${report.videosKept} preservados; thumbnails baixados: ${report.thumbnailsDownloaded}.`,
  )
  if (!args.has('write'))
    console.log('Simulação: banco remoto não alterado. Use --write para aplicar.')
  else if (result.statements === 0) console.log('Nada a aplicar no banco remoto.')
  else console.log(`Atualização aplicada no banco ${args.get('database') || 'louvorja'}.`)
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  cli().catch((error) => {
    console.error(error instanceof Error ? error.message : 'Falha desconhecida')
    process.exitCode = 1
  })
}
