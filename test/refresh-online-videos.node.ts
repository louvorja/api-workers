import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  buildMutationSql,
  buildRefreshPlan,
  createYoutubeClient,
  downloadThumbnail,
  MAX_THUMBNAIL_BYTES,
  parsePlaylistIds,
  parsePlaylistItemsPage,
  parseResourceResponse,
  refreshOnlineVideos,
  type Snapshot,
  sqlLiteral,
  type YoutubeClient,
  type YoutubeResource,
  type YoutubeVideo,
} from '../scripts/refresh-online-videos.ts'

const schema = `
  PRAGMA foreign_keys = ON;
  CREATE TABLE online_videos_channels (
    id_online_video_channel INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL UNIQUE,
    title TEXT, description TEXT, custom_url TEXT,
    default_image TEXT, medium_image TEXT, high_image TEXT,
    default_image_base64 TEXT, error TEXT,
    status TEXT NOT NULL DEFAULT 'pending', playlists TEXT NOT NULL,
    id_language TEXT NOT NULL, created_at TEXT, updated_at TEXT
  );
  CREATE TABLE online_videos_playlists (
    id_online_video_playlist INTEGER PRIMARY KEY AUTOINCREMENT,
    id_online_video_channel INTEGER NOT NULL REFERENCES online_videos_channels(id_online_video_channel) ON DELETE CASCADE,
    playlist_id TEXT NOT NULL UNIQUE,
    title TEXT, description TEXT, default_image TEXT, medium_image TEXT,
    high_image TEXT, standard_image TEXT, maxres_image TEXT,
    default_image_base64 TEXT, error TEXT,
    status TEXT NOT NULL DEFAULT 'pending', id_language TEXT NOT NULL,
    created_at TEXT, updated_at TEXT
  );
  CREATE TABLE online_videos (
    id_online_video INTEGER PRIMARY KEY AUTOINCREMENT,
    id_online_video_playlist INTEGER NOT NULL REFERENCES online_videos_playlists(id_online_video_playlist) ON DELETE CASCADE,
    video_id TEXT NOT NULL, title TEXT, description TEXT, sequence INTEGER,
    default_image TEXT, medium_image TEXT, high_image TEXT,
    standard_image TEXT, maxres_image TEXT, default_image_base64 TEXT,
    error TEXT, status TEXT NOT NULL DEFAULT 'pending', id_language TEXT NOT NULL,
    created_at TEXT, updated_at TEXT,
    UNIQUE(id_online_video_playlist, video_id)
  );
`

const image = (name: string) => `https://i.ytimg.com/${name}.jpg`

function resource(title: string, defaultImage = image(title)): YoutubeResource {
  return {
    title,
    description: `Descrição de ${title}`,
    customUrl: null,
    defaultImage,
    mediumImage: image(`${title}-medium`),
    highImage: image(`${title}-high`),
    standardImage: image(`${title}-high`),
    maxresImage: image(`${title}-maxres`),
  }
}

function video(videoId: string, sequence: number): YoutubeVideo {
  return {
    videoId,
    title: `Vídeo ${videoId}`,
    description: `Descrição ${videoId}`,
    sequence,
    defaultImage: image(videoId),
    mediumImage: image(`${videoId}-medium`),
    highImage: image(`${videoId}-high`),
    standardImage: image(`${videoId}-high`),
    maxresImage: image(`${videoId}-maxres`),
  }
}

const fixtureSnapshot: Snapshot = {
  channels: [
    {
      id: 1,
      channelId: 'UCone',
      status: 'pending',
      playlists: ['PLkeep', 'PLnew'],
      language: 'pt',
    },
  ],
  playlists: [
    { id: 10, channelId: 1, playlistId: 'PLkeep', status: 'pending', language: 'pt' },
    { id: 11, channelId: 1, playlistId: 'PLold', status: 'validated', language: 'pt' },
  ],
  videos: [
    { id: 100, playlistId: 10, videoId: 'videoKeep' },
    { id: 101, playlistId: 10, videoId: 'videoOld' },
    { id: 102, playlistId: 11, videoId: 'videoCascade' },
  ],
}

function fixtureYoutube(): YoutubeClient {
  return {
    async channel(id) {
      assert.equal(id, 'UCone')
      return { ...resource("Canal d'Água", image('shared')), customUrl: '@canal' }
    },
    async playlist(id) {
      assert.ok(id === 'PLkeep' || id === 'PLnew')
      return resource(`Playlist ${id}`, image('shared'))
    },
    async playlistItems(id) {
      if (id === 'PLnew') return { items: [], pages: 1 }
      assert.equal(id, 'PLkeep')
      return {
        items: [video('videoKeep', 0), video('videoNew', 1), video('videoNew', 2)],
        pages: 2,
      }
    },
  }
}

test('valida e deduplica o JSON de playlists declarado pelo canal', () => {
  assert.deepEqual(parsePlaylistIds('["PLum","PLdois","PLum"]', 'UCx'), ['PLum', 'PLdois'])
  assert.throws(() => parsePlaylistIds('{"id":"PLum"}', 'UCx'), /deve ser uma lista/)
  assert.throws(() => parsePlaylistIds('["PL ok"]', 'UCx'), /identificador inválido/)
  assert.throws(() => parsePlaylistIds('[', 'UCx'), /não contém JSON válido/)
})

test('valida recursos e ignora playlistItems removidos sem thumbnails', () => {
  const parsed = parseResourceResponse(
    {
      items: [
        {
          id: 'UCone',
          snippet: {
            title: 'Canal',
            description: 'Descrição',
            customUrl: '@canal',
            thumbnails: { default: { url: image('canal') } },
          },
        },
      ],
    },
    'UCone',
    'canal',
  )
  assert.equal(parsed.defaultImage, image('canal'))
  assert.equal(parsed.customUrl, '@canal')

  const page = parsePlaylistItemsPage(
    {
      nextPageToken: 'pagina-2',
      items: [
        { snippet: { thumbnails: {}, title: 'Deleted video' } },
        {
          snippet: {
            resourceId: { videoId: 'videoUm' },
            title: 'Vídeo',
            description: 'Descrição',
            position: 0,
            thumbnails: { default: { url: image('videoUm') } },
          },
        },
      ],
    },
    'PLum',
  )
  assert.equal(page.nextPageToken, 'pagina-2')
  assert.deepEqual(
    page.items.map((item) => item.videoId),
    ['videoUm'],
  )
  assert.throws(
    () =>
      parseResourceResponse(
        { items: [{ id: 'outro', snippet: { title: 'x', description: 'x' } }] },
        'UCone',
        'canal',
      ),
    /não encontrado/,
  )
})

test('pagina todos os playlistItems e nunca inclui a chave nos erros', async () => {
  const requests: URL[] = []
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    requests.push(url)
    const second = url.searchParams.get('pageToken') === 'pagina-2'
    return Response.json(
      {
        items: [
          {
            snippet: {
              resourceId: { videoId: second ? 'videoDois' : 'videoUm' },
              title: second ? 'Dois' : 'Um',
              description: 'Descrição',
              position: second ? 1 : 0,
              thumbnails: { default: { url: image(second ? 'dois' : 'um') } },
            },
          },
        ],
        ...(second ? {} : { nextPageToken: 'pagina-2' }),
      },
      { headers: { 'content-type': 'application/json' } },
    )
  }) as typeof fetch

  const result = await createYoutubeClient('chave-super-secreta', fakeFetch).playlistItems('PLum')
  assert.equal(result.pages, 2)
  assert.deepEqual(
    result.items.map((item) => item.videoId),
    ['videoUm', 'videoDois'],
  )
  assert.equal(requests[0]?.searchParams.get('maxResults'), '50')
  assert.equal(requests[1]?.searchParams.get('pageToken'), 'pagina-2')

  const failedFetch = (async () => new Response('', { status: 403 })) as typeof fetch
  await assert.rejects(
    () => createYoutubeClient('chave-super-secreta', failedFetch).channel('UCone'),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /HTTP 403/)
      assert.equal(error.message.includes('chave-super-secreta'), false)
      return true
    },
  )
  await assert.rejects(
    () =>
      buildRefreshPlan(
        {
          channels: [
            { id: 1, channelId: 'UCone', status: 'pending', playlists: [], language: 'pt' },
          ],
          playlists: [],
          videos: [],
        },
        createYoutubeClient('chave-super-secreta', failedFetch),
        async () => '',
      ),
    /HTTP 403/,
  )
})

test('thumbnail exige origem, tipo, assinatura e tamanho seguros', async () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
  let acceptedType = ''
  const validFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    acceptedType = new Headers(init?.headers).get('accept') ?? ''
    return new Response(jpeg, {
      headers: { 'content-type': 'image/jpeg', 'content-length': String(jpeg.length) },
    })
  }) as typeof fetch
  const encoded = await downloadThumbnail(image('thumb'), 'thumb', validFetch)
  assert.equal(encoded, `data:image/jpeg;base64,${Buffer.from(jpeg).toString('base64')}`)
  assert.equal(acceptedType, 'image/jpeg')

  const webpFetch = (async () =>
    new Response(new Uint8Array([0x52, 0x49, 0x46, 0x46]), {
      headers: { 'content-type': 'image/webp' },
    })) as typeof fetch
  await assert.rejects(() => downloadThumbnail(image('webp'), 'thumb', webpFetch), /tipo/)

  let called = false
  const forbiddenFetch = (async () => {
    called = true
    return new Response(jpeg)
  }) as typeof fetch
  await assert.rejects(
    () => downloadThumbnail('https://example.com/thumb.jpg', 'thumb', forbiddenFetch),
    /origem de imagem não permitida/,
  )
  assert.equal(called, false)

  let redirects = 0
  const redirectedFetch = (async () => {
    redirects++
    return new Response(null, {
      status: 302,
      headers: { location: 'http://127.0.0.1/segredo' },
    })
  }) as typeof fetch
  await assert.rejects(
    () => downloadThumbnail(image('redirect'), 'thumb', redirectedFetch),
    /origem de imagem não permitida/,
  )
  assert.equal(redirects, 1)

  const largeFetch = (async () =>
    new Response(jpeg, {
      headers: {
        'content-type': 'image/jpeg',
        'content-length': String(MAX_THUMBNAIL_BYTES + 1),
      },
    })) as typeof fetch
  await assert.rejects(() => downloadThumbnail(image('large'), 'thumb', largeFetch), /tamanho/)

  const fakeImage = (async () =>
    new Response('não é imagem', { headers: { 'content-type': 'image/jpeg' } })) as typeof fetch
  await assert.rejects(
    () => downloadThumbnail(image('fake'), 'thumb', fakeImage),
    /não corresponde/,
  )
})

test('planeja canais pending, reconcilia playlists e remove/cria vídeos', async () => {
  const downloads: string[] = []
  const plan = await buildRefreshPlan(fixtureSnapshot, fixtureYoutube(), async (url) => {
    downloads.push(url)
    return `data:image/jpeg;base64,${Buffer.from(url).toString('base64')}`
  })

  assert.equal(plan.channels.length, 1)
  assert.deepEqual(plan.removedPlaylists, [{ channelId: 'UCone', playlistId: 'PLold' }])
  assert.deepEqual(
    plan.playlists.map((playlist) => playlist.playlistId),
    ['PLkeep', 'PLnew'],
  )
  assert.deepEqual(plan.removedVideos, [{ playlistId: 'PLkeep', videoId: 'videoOld' }])
  assert.deepEqual(
    plan.videos.map((item) => item.videoId),
    ['videoNew'],
  )
  assert.deepEqual(plan.report, {
    channelsValidated: 1,
    channelsFailed: 0,
    playlistsCreated: 1,
    playlistsValidated: 2,
    playlistsFailed: 0,
    playlistsRemoved: 1,
    playlistsScanned: 2,
    playlistPages: 3,
    videosCreated: 1,
    videosFailed: 0,
    videosRemoved: 1,
    videosKept: 1,
    thumbnailsDownloaded: 2,
  })
  assert.deepEqual(downloads.sort(), [image('shared'), image('videoNew')].sort())
})

test('registra recurso removido, playlist privada e thumbnail inválida sem abortar os demais', async () => {
  const snapshot: Snapshot = {
    channels: [
      {
        id: 1,
        channelId: 'UCremoved',
        status: 'pending',
        playlists: ['PLprivate'],
        language: 'pt',
      },
      {
        id: 2,
        channelId: 'UCworking',
        status: 'pending',
        playlists: ['PLworking'],
        language: 'pt',
      },
    ],
    playlists: [],
    videos: [],
  }
  const youtube: YoutubeClient = {
    async channel(id) {
      if (id === 'UCremoved') throw new Error('canal removido')
      return resource('Canal ativo', image('channel-working'))
    },
    async playlist(id) {
      if (id === 'PLprivate') throw new Error('playlist privada')
      return resource('Playlist ativa', image('playlist-working'))
    },
    async playlistItems(id) {
      if (id === 'PLprivate') throw new Error('itens da playlist estão privados')
      return {
        items: [video('videoOk', 0), video('videoBadThumb', 1)],
        pages: 1,
      }
    },
  }

  const plan = await buildRefreshPlan(snapshot, youtube, async (url) => {
    if (url === image('videoBadThumb')) throw new Error('thumbnail removida')
    return `data:image/jpeg;base64,${Buffer.from(url).toString('base64')}`
  })

  assert.deepEqual(
    plan.channels.map((item) => item.channelId),
    ['UCworking'],
  )
  assert.deepEqual(plan.channelFailures, [{ channelId: 'UCremoved', error: 'canal removido' }])
  assert.deepEqual(
    plan.playlists.map((item) => item.playlistId),
    ['PLworking'],
  )
  assert.deepEqual(plan.playlistFailures, [
    {
      channelId: 'UCremoved',
      playlistId: 'PLprivate',
      language: 'pt',
      error: 'playlist privada',
    },
  ])
  assert.deepEqual(
    plan.videos.map((item) => item.videoId),
    ['videoOk'],
  )
  assert.deepEqual(
    plan.videoFailures.map((item) => item.videoId),
    ['videoBadThumb'],
  )
  assert.deepEqual(plan.report, {
    channelsValidated: 1,
    channelsFailed: 1,
    playlistsCreated: 2,
    playlistsValidated: 1,
    playlistsFailed: 1,
    playlistsRemoved: 0,
    playlistsScanned: 1,
    playlistPages: 1,
    videosCreated: 2,
    videosFailed: 1,
    videosRemoved: 0,
    videosKept: 0,
    thumbnailsDownloaded: 4,
  })

  const db = new DatabaseSync(':memory:')
  db.exec(schema)
  db.exec(`
    INSERT INTO online_videos_channels
      (id_online_video_channel, channel_id, status, playlists, id_language)
    VALUES
      (1, 'UCremoved', 'pending', '["PLprivate"]', 'pt'),
      (2, 'UCworking', 'pending', '["PLworking"]', 'pt');
  `)
  db.exec(buildMutationSql(plan, '2026-10-10 12:34:56'))
  assert.deepEqual(
    db
      .prepare('SELECT channel_id, status FROM online_videos_channels ORDER BY channel_id')
      .all()
      .map((row) => ({ ...row })),
    [
      { channel_id: 'UCremoved', status: 'error' },
      { channel_id: 'UCworking', status: 'validated' },
    ],
  )
  assert.deepEqual(
    db
      .prepare('SELECT playlist_id, status FROM online_videos_playlists ORDER BY playlist_id')
      .all()
      .map((row) => ({ ...row })),
    [
      { playlist_id: 'PLprivate', status: 'error' },
      { playlist_id: 'PLworking', status: 'validated' },
    ],
  )
  assert.deepEqual(
    db
      .prepare('SELECT video_id, status FROM online_videos ORDER BY video_id')
      .all()
      .map((row) => ({ ...row })),
    [
      { video_id: 'videoBadThumb', status: 'error' },
      { video_id: 'videoOk', status: 'validated' },
    ],
  )
  db.close()
})

test('SQL rigorosamente escapado reproduz o plano e preserva vídeos existentes', async () => {
  const plan = await buildRefreshPlan(
    fixtureSnapshot,
    fixtureYoutube(),
    async (url) => `data:image/jpeg;base64,${Buffer.from(url).toString('base64')}`,
  )
  const sql = buildMutationSql(plan, '2026-10-10 12:34:56')
  assert.ok(sql.includes("Canal d''Água"))
  assert.equal(sql.includes('BEGIN'), false)
  assert.equal(sql.includes('COMMIT'), false)
  assert.equal(sqlLiteral("d'Água"), "'d''Água'")
  assert.throws(() => sqlLiteral('a\0b'), /byte NUL/)

  const db = new DatabaseSync(':memory:')
  db.exec(schema)
  db.exec(`
    INSERT INTO online_videos_channels
      (id_online_video_channel, channel_id, status, playlists, id_language)
    VALUES (1, 'UCone', 'pending', '["PLkeep","PLnew"]', 'pt');
    INSERT INTO online_videos_playlists
      (id_online_video_playlist, id_online_video_channel, playlist_id, title, status, id_language)
    VALUES
      (10, 1, 'PLkeep', 'Antiga', 'pending', 'pt'),
      (11, 1, 'PLold', 'Obsoleta', 'validated', 'pt');
    INSERT INTO online_videos
      (id_online_video, id_online_video_playlist, video_id, title, status, id_language)
    VALUES
      (100, 10, 'videoKeep', 'Título preservado', 'validated', 'pt'),
      (101, 10, 'videoOld', 'Sai', 'validated', 'pt'),
      (102, 11, 'videoCascade', 'Sai em cascata', 'validated', 'pt');
  `)
  db.exec(`BEGIN IMMEDIATE; ${sql} COMMIT;`)

  assert.deepEqual(
    db
      .prepare('SELECT playlist_id FROM online_videos_playlists ORDER BY playlist_id')
      .all()
      .map((row) => row.playlist_id),
    ['PLkeep', 'PLnew'],
  )
  assert.deepEqual(
    db
      .prepare('SELECT video_id, title FROM online_videos ORDER BY video_id')
      .all()
      .map((row) => ({ ...row })),
    [
      { video_id: 'videoKeep', title: 'Título preservado' },
      { video_id: 'videoNew', title: 'Vídeo videoNew' },
    ],
  )
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  assert.equal(
    db.prepare("SELECT status FROM online_videos_channels WHERE channel_id = 'UCone'").get()
      ?.status,
    'validated',
  )
  db.close()
})

test('orquestrador é dry-run por padrão e só chama executor em --write', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'louvorja-online-videos-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const exportSql = join(root, 'replica.sql')
  const outputSql = join(root, 'mudancas.sql')
  writeFileSync(
    exportSql,
    `${schema}
      INSERT INTO online_videos_channels
        (id_online_video_channel, channel_id, status, playlists, id_language)
      VALUES (1, 'UCone', 'pending', '[]', 'pt');
    `,
  )

  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
  const fakeFetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input))
    if (url.hostname === 'www.googleapis.com') {
      return Response.json(
        {
          items: [
            {
              id: 'UCone',
              snippet: {
                title: 'Canal',
                description: 'Descrição',
                customUrl: '@canal',
                thumbnails: { default: { url: image('canal') } },
              },
            },
          ],
        },
        { headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } })
  }) as typeof fetch

  const executions: Array<{ database: string; file: string }> = []
  const dryRun = await refreshOnlineVideos({
    exportSql,
    outputSql,
    apiKey: 'chave-secreta',
    fetchImpl: fakeFetch,
    now: new Date('2026-10-10T12:00:00Z'),
    execute: (database, file) => executions.push({ database, file }),
  })
  assert.equal(dryRun.statements, 1)
  assert.equal(executions.length, 0)
  assert.equal(readFileSync(outputSql, 'utf8').includes('chave-secreta'), false)

  await refreshOnlineVideos({
    exportSql,
    outputSql,
    apiKey: 'chave-secreta',
    fetchImpl: fakeFetch,
    now: new Date('2026-10-10T12:00:00Z'),
    write: true,
    execute: (database, file) => executions.push({ database, file }),
  })
  assert.deepEqual(executions, [{ database: 'louvorja', file: outputSql }])
})
