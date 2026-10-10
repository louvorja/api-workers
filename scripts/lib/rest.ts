/**
 * Gera, a partir do banco, o retrato da camada REST pública que o Worker serve
 * de rest/ — o que hoje a ingestão copia da origem página a página.
 *
 * As listas saem do mesmo motor que atende o painel (são os mesmos controllers
 * na origem), então a rota pública e a tela de administração não divergem.
 */
import {
  filesSpec,
  fileUrl,
  MUSIC_FILES,
  musicFileColumns,
  type Resource,
  resources,
} from '../../src/features/admin.ts'
import {
  type Column,
  type ListSpec,
  MAX_PER_PAGE,
  paginate,
  presentRow,
  type Where,
} from '../../src/lib/admin/listing.ts'

type Row = Record<string, unknown>

const selectOf = (columns: Column[]) => columns.map((c) => `${c.expr} AS "${c.key}"`).join(', ')

/** Colunas de álbum nas rotas de categoria, que ordenam pela posição no vínculo. */
const categoryAlbumColumns = (base: string): Column[] => [
  { key: 'id_album', expr: 'albums.id_album' },
  { key: 'name', expr: 'albums.name', text: true },
  { key: 'id_file_image', expr: 'albums.id_file_image' },
  { key: 'url_image', expr: fileUrl(base, 'files'), text: true },
  { key: 'image_version', expr: 'files.version' },
  { key: 'id_language', expr: 'albums.id_language', text: true },
  { key: 'color', expr: 'albums.color', text: true },
  { key: 'order', expr: 'categories_albums."order"' },
]

const CATEGORY_ALBUMS_FROM =
  'albums JOIN categories_albums ON categories_albums.id_album = albums.id_album ' +
  'JOIN categories ON categories.id_category = categories_albums.id_category ' +
  'LEFT JOIN files ON albums.id_file_image = files.id_file'

export async function* generateRest(
  db: D1Database,
  apiBase: string,
): AsyncGenerator<[key: string, json: string]> {
  const base = `${apiBase}/file`
  const origin = new URL(apiBase)

  /** Todas as linhas de uma listagem, página a página, como a ingestão as juntava. */
  const all = async (spec: ListSpec, pre: Where[], params: Record<string, string> = {}) => {
    const rows: Row[] = []
    for (let page = 1; ; page++) {
      const url = new URL('/rest', origin)
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
      url.searchParams.set('limit', String(MAX_PER_PAGE))
      url.searchParams.set('page', String(page))
      const result = await paginate(db, spec, url, pre)
      rows.push(...result.data)
      if (page >= Number(result.last_page)) return rows
    }
  }
  const listOf = (resource: Resource, lang: string) => {
    const params = { id_language: lang }
    const { spec, pre } = resource.list(base, new URLSearchParams(params))
    return all(spec, pre, params)
  }
  const query = async (sql: string, ...params: unknown[]) =>
    (
      await db
        .prepare(sql)
        .bind(...params)
        .all<Row>()
    ).results

  const languages = await query('SELECT * FROM languages ORDER BY id_language')

  // A origem guarda em `file_name` o nome do arquivo dela; aqui ele é o do
  // objeto no acervo. Quem consome a lista pública continua vendo o original.
  const files = (await all(filesSpec(base), [])).map((file) => ({ ...file, file_name: file.name }))

  for (const { id_language } of languages) {
    const lang = String(id_language)

    const musics = await listOf(resources.musics, lang)
    const albums = await listOf(resources.albums, lang)
    const categories = await listOf(resources.categories, lang)
    yield [`${lang}_musics`, JSON.stringify(musics)]
    yield [`${lang}_albums`, JSON.stringify(albums)]
    yield [`${lang}_categories`, JSON.stringify(categories)]
    yield [`${lang}_lyrics`, JSON.stringify(await listOf(resources.lyrics, lang))]
    yield [`${lang}_albums_musics`, JSON.stringify(await listOf(resources.albumsMusics, lang))]
    yield [
      `${lang}_categories_albums`,
      JSON.stringify(await listOf(resources.categoriesAlbums, lang)),
    ]
    yield [`${lang}_files`, JSON.stringify(files)]
    yield [`${lang}_languages`, JSON.stringify(languages.map((row) => presentRow({ ...row })))]

    const hymnal = await all(
      {
        columns: [
          { key: 'id_music', expr: 'musics.id_music' },
          { key: 'name', expr: 'musics.name', text: true },
          { key: 'track', expr: 'albums_musics.track' },
          ...musicFileColumns(base),
          { key: 'id_language', expr: 'musics.id_language', text: true },
          { key: 'created_at', expr: 'musics.created_at' },
          { key: 'updated_at', expr: 'musics.updated_at' },
        ],
        from:
          'musics JOIN albums_musics ON albums_musics.id_music = musics.id_music ' +
          'JOIN categories_albums ON categories_albums.id_album = albums_musics.id_album ' +
          `JOIN categories ON categories.id_category = categories_albums.id_category ${MUSIC_FILES}`,
        tiebreak: 'musics.id_music ASC',
      },
      [
        { sql: 'musics.id_language = ?', params: [lang] },
        { sql: "categories.slug = 'hymnal'", params: [] },
        { sql: 'categories.id_language = ?', params: [lang] },
      ],
    )
    yield [`${lang}_hymnal`, JSON.stringify(hymnal)]

    for (const music of musics) {
      const item = await resources.musics.show(db, base, String(music.id_music))
      if (item) yield [`${lang}_music_${music.id_music}`, JSON.stringify(presentRow(item))]
    }
    for (const album of albums) {
      const item = await resources.albums.show(db, base, String(album.id_album))
      if (item) yield [`${lang}_album_${album.id_album}`, JSON.stringify(presentRow(item))]
    }

    for (const category of categories) {
      const where: Where[] = [
        { sql: 'categories.id_category = ?', params: [category.id_category] },
        { sql: 'albums.id_language = ?', params: [lang] },
      ]
      const rows = await all(
        {
          columns: [
            ...categoryAlbumColumns(base),
            { key: 'created_at', expr: 'albums.created_at' },
            { key: 'updated_at', expr: 'albums.updated_at' },
          ],
          from: CATEGORY_ALBUMS_FROM,
          tiebreak: 'categories_albums."order" ASC, albums.id_album ASC',
        },
        where,
      )
      yield [`${lang}_category_${category.id_category}_albums`, JSON.stringify(rows)]
      if (category.slug) {
        yield [`${lang}_categoryslug_${category.slug}_albums`, JSON.stringify(rows)]
      }

      const withMusics = await query(
        `SELECT ${selectOf(categoryAlbumColumns(base))} FROM ${CATEGORY_ALBUMS_FROM} ` +
          'WHERE categories.id_category = ? AND albums.id_language = ? ' +
          'ORDER BY categories_albums."order", albums.id_album',
        category.id_category,
        lang,
      )
      for (const album of withMusics) {
        album.musics = await query(
          'SELECT albums_musics.id_album, musics.id_music, albums_musics.track, musics.name, ' +
            `${selectOf(musicFileColumns(base))} ` +
            `FROM musics LEFT JOIN albums_musics ON albums_musics.id_music = musics.id_music ${MUSIC_FILES} ` +
            'WHERE albums_musics.id_album = ? ORDER BY albums_musics.track, musics.id_music',
          album.id_album,
        )
      }
      yield [
        `${lang}_category_${category.id_category}_awm`,
        JSON.stringify({ category, albums: withMusics }),
      ]
    }

    const online = {
      channels: await query(
        'SELECT channel_id, title, custom_url, default_image, default_image_base64 ' +
          "FROM online_videos_channels WHERE id_language = ? AND status = 'validated' " +
          'ORDER BY id_online_video_channel',
        lang,
      ),
      playlists: await query(
        'SELECT p.playlist_id, c.channel_id, p.title, p.default_image, p.default_image_base64 ' +
          'FROM online_videos_playlists p ' +
          'LEFT JOIN online_videos_channels c ON c.id_online_video_channel = p.id_online_video_channel ' +
          "WHERE p.id_language = ? AND p.status = 'validated' ORDER BY p.id_online_video_playlist",
        lang,
      ),
      videos: await query(
        'SELECT v.video_id, p.playlist_id, v.title, v.sequence, v.default_image, v.default_image_base64 ' +
          'FROM online_videos v ' +
          'LEFT JOIN online_videos_playlists p ON p.id_online_video_playlist = v.id_online_video_playlist ' +
          "WHERE v.id_language = ? AND v.status = 'validated' ORDER BY v.id_online_video",
        lang,
      ),
    }
    yield [`${lang}_collections_online`, JSON.stringify(online)]

    const config: Row = {}
    for (const row of await query('SELECT key, type, value FROM configs ORDER BY key')) {
      config[String(row.key)] = row.type === 'number' ? Number(row.value) : row.value
    }
    yield [`${lang}_config`, JSON.stringify(config)]
  }
}
