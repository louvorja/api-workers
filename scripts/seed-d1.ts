/**
 * Gera a carga inicial do D1 a partir do retrato que já está no R2 — as mesmas
 * coleções que a API serve em rest/ e json_db/.
 *
 * Não fala com a origem nem com o banco: lê um diretório (ver pull-snapshot.ts)
 * e escreve arquivos .sql numerados, na ordem que as chaves estrangeiras pedem.
 * No fim imprime em quantos dias a carga cabe no plano gratuito, que limita o
 * D1 a 100 mil linhas escritas por dia. Aplicar é com o wrangler:
 *
 *   npx wrangler d1 execute louvorja --remote --file=seed/<arquivo>.sql
 *
 * Os versículos da Bíblia ficam de fora por padrão: são 404 mil linhas que
 * ninguém edita pelo painel e que já estão publicadas no R2, capítulo a
 * capítulo. `--bible` os inclui.
 *
 *   node --experimental-strip-types scripts/seed-d1.ts --snapshot=<dir> [--out=seed] [--bible]
 *   node --experimental-strip-types scripts/seed-d1.ts --snapshot=<dir> [--out=seed] --bible-only
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizedMediaPath } from './lib/media.ts'

const args = new Map(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=') as [string, string]),
)
const snapshotArg = args.get('snapshot')
const OUT = args.get('out') ?? 'seed'
if (!snapshotArg) throw new Error('informe --snapshot=<diretório do retrato>')
const SNAPSHOT = snapshotArg
const BIBLE_ONLY = args.has('bible-only')
const INCLUDE_BIBLE = args.has('bible') || BIBLE_ONLY
if (BIBLE_ONLY && args.has('bible')) {
  throw new Error('use apenas um entre --bible e --bible-only')
}

type Row = Record<string, unknown>
const LANGS = ['pt', 'es'] as const

const load = <T>(key: string): T => JSON.parse(readFileSync(join(SNAPSHOT, key), 'utf8')) as T
const both = (collection: string): Row[] =>
  LANGS.flatMap((lang) => load<Row[]>(`rest/${lang}_${collection}.json`))

/** A API serializa em ISO-8601; o banco guarda 'YYYY-MM-DD HH:MM:SS' em UTC. */
const sqlDate = (value: unknown) =>
  typeof value === 'string' && value ? value.slice(0, 19).replace('T', ' ') : null

/**
 * As letras têm quebra de linha CRLF dentro do texto, e ferramentas que leem
 * SQL linha a linha (o shell do sqlite3, por exemplo) descartam o \r em
 * silêncio. Ele entra como char(13) para chegar ao banco de qualquer jeito.
 */
function literal(value: unknown): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return value ? '1' : '0'
  const text = `'${String(value).replace(/'/g, "''")}'`
  return text.includes('\r') ? `(${text.replaceAll('\r', "'||char(13)||'")})` : text
}

// O D1 recusa comando acima de 100 KB; cada INSERT fecha antes disso.
const MAX_STATEMENT_BYTES = 80_000
// Arquivo menor que o limite diário, para a carga poder ser dividida em dias.
const MAX_ROWS_PER_FILE = 10_000
// Folga sobre as 100 mil escritas diárias do plano gratuito.
const DAILY_WRITES = 80_000
/**
 * Escritas a mais por linha inserida: uma por índice e, nas tabelas com total
 * em `row_counts`, uma do gatilho que o mantém.
 */
const EXTRA_WRITES: Record<string, number> = {
  files: 3,
  categories: 1,
  musics: 1,
  lyrics: 2,
  albums_musics: 3,
  categories_albums: 2,
  bible_version: 1,
  bible_book: 1,
  bible_verse: 1,
  online_videos_channels: 1,
  online_videos_playlists: 1,
  online_videos: 1,
}

let tableIndex = 0
let totalRows = 0
const written: Array<{ name: string; writes: number }> = []

function statementsFor(table: string, columns: string[], rows: Row[], conflict = ''): string[] {
  const head = `INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(', ')}) VALUES\n`
  const statements: string[] = []
  let current: string[] = []
  let size = head.length

  for (const row of rows) {
    const tuple = `(${columns.map((c) => literal(row[c])).join(', ')})`
    const bytes = Buffer.byteLength(tuple) + 2
    if (current.length > 0 && size + bytes > MAX_STATEMENT_BYTES) {
      statements.push(`${head}${current.join(',\n')}${conflict};`)
      current = []
      size = head.length
    }
    current.push(tuple)
    size += bytes
  }
  if (current.length > 0) statements.push(`${head}${current.join(',\n')}${conflict};`)
  return statements
}

function emit(table: string, columns: string[], rows: Row[], conflict = '') {
  const prefix = String(++tableIndex).padStart(2, '0')
  const parts = Math.max(1, Math.ceil(rows.length / MAX_ROWS_PER_FILE))

  for (let part = 0; part < parts; part++) {
    const slice = rows.slice(part * MAX_ROWS_PER_FILE, (part + 1) * MAX_ROWS_PER_FILE)
    const suffix = parts > 1 ? `_${String(part + 1).padStart(2, '0')}` : ''
    const name = `${prefix}_${table}${suffix}.sql`
    writeFileSync(join(OUT, name), `${statementsFor(table, columns, slice, conflict).join('\n')}\n`)
    written.push({ name, writes: slice.length * (1 + (EXTRA_WRITES[table] ?? 0)) })
  }
  totalRows += rows.length
  console.log(`  ${prefix}_${table}: ${rows.length} linhas em ${parts} arquivo(s)`)
}

function emitControl(label: string, sql: string, writes = 1) {
  const prefix = String(++tableIndex).padStart(2, '0')
  const name = `${prefix}_${label}.sql`
  writeFileSync(join(OUT, name), `${sql.trim()}\n`)
  written.push({ name, writes })
  console.log(`  ${prefix}_${label}: marcador`)
}

const BIBLE_MARKER = 'bible_seed_complete'

function readBibleSeed(): {
  versions: Row[]
  books: Row[]
  verses: Row[]
  chapters: number
} {
  const versions = LANGS.flatMap((lang) =>
    load<Row[]>(`json_db/${lang}_bible_version.json`).map(
      (row): Row => ({
        ...row,
        id_language: lang,
      }),
    ),
  )
  const books = LANGS.flatMap((lang) =>
    load<Row[]>(`json_db/${lang}_bible_book.json`).map(
      (row): Row => ({
        ...row,
        id_language: lang,
      }),
    ),
  )
  const versionById = new Map<number, Row>()
  const bookById = new Map<number, Row>()
  for (const version of versions) {
    const id = Number(version.id_bible_version)
    if (!Number.isSafeInteger(id) || id < 1 || versionById.has(id)) {
      throw new Error(`id_bible_version inválido ou duplicado: ${String(version.id_bible_version)}`)
    }
    versionById.set(id, version)
  }
  for (const book of books) {
    const id = Number(book.id_bible_book)
    const chapters = Number(book.chapters)
    if (!Number.isSafeInteger(id) || id < 1 || bookById.has(id)) {
      throw new Error(`id_bible_book inválido ou duplicado: ${String(book.id_bible_book)}`)
    }
    if (!Number.isSafeInteger(chapters) || chapters < 1) {
      throw new Error(`bible_book ${id} tem chapters inválido: ${String(book.chapters)}`)
    }
    bookById.set(id, book)
  }

  const expected = new Set<string>()
  for (const [versionId, version] of versionById) {
    for (const [bookId, book] of bookById) {
      if (version.id_language !== book.id_language) continue
      for (let chapter = 1; chapter <= Number(book.chapters); chapter++) {
        expected.add(`${versionId}:${bookId}:${chapter}`)
      }
    }
  }
  if (expected.size === 0) throw new Error('snapshot não define capítulos bíblicos esperados')

  const verses: Row[] = []
  const actual = new Set<string>()
  for (const file of readdirSync(join(SNAPSHOT, 'bible')).sort()) {
    if (!file.startsWith('bible_')) continue
    const match = /^bible_(\d+)_(\d+)_(\d+)\.json$/.exec(file)
    if (!match) throw new Error(`${file}: nome de capítulo bíblico inválido`)
    const [versionId, bookId, chapter] = match.slice(1).map(Number) as [number, number, number]
    const version = versionById.get(versionId)
    const book = bookById.get(bookId)
    const key = `${versionId}:${bookId}:${chapter}`
    if (!version || !book || version.id_language !== book.id_language || !expected.has(key)) {
      throw new Error(`${file}: capítulo não corresponde aos metadados`)
    }
    if (actual.has(key)) throw new Error(`${file}: capítulo duplicado`)
    actual.add(key)

    const chapterJson = load<unknown>(`bible/${file}`)
    if (chapterJson === null || typeof chapterJson !== 'object' || Array.isArray(chapterJson)) {
      throw new Error(`${file}: esperado objeto versículo -> texto`)
    }
    const entries = Object.entries(chapterJson as Record<string, unknown>)
    if (entries.length === 0) throw new Error(`${file}: capítulo vazio`)
    for (const [verseKey, text] of entries) {
      const verse = Number(verseKey)
      if (!Number.isSafeInteger(verse) || verse < 1 || String(verse) !== verseKey) {
        throw new Error(`${file}: versículo inválido: ${verseKey}`)
      }
      if (typeof text !== 'string') throw new Error(`${file}: versículo ${verse} não é texto`)
      verses.push({
        id_bible_version: versionId,
        id_bible_book: bookId,
        chapter,
        verse,
        text,
        id_language: version.id_language,
      })
    }
  }

  const missing = [...expected].filter((key) => !actual.has(key))
  if (missing.length > 0) {
    throw new Error(
      `snapshot bíblico incompleto: faltam ${missing.length} capítulo(s): ${missing.slice(0, 8).join(', ')}`,
    )
  }
  const num = (row: Row, key: string) => Number(row[key])
  verses.sort(
    (a, b) =>
      num(a, 'id_bible_version') - num(b, 'id_bible_version') ||
      num(a, 'id_bible_book') - num(b, 'id_bible_book') ||
      num(a, 'chapter') - num(b, 'chapter') ||
      num(a, 'verse') - num(b, 'verse'),
  )
  return { versions, books, verses, chapters: actual.size }
}

const bibleSeed = INCLUDE_BIBLE ? readBibleSeed() : null

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const dated = (row: Row) => ({
  ...row,
  created_at: sqlDate(row.created_at),
  updated_at: sqlDate(row.updated_at),
})

if (INCLUDE_BIBLE) {
  emitControl('bible_seed_begin', `DELETE FROM configs WHERE key = '${BIBLE_MARKER}';`)
}

if (BIBLE_ONLY) {
  emit(
    'bible_verse',
    ['id_bible_version', 'id_bible_book', 'chapter', 'verse', 'text', 'id_language'],
    bibleSeed?.verses ?? [],
    '\nON CONFLICT (id_bible_version, id_bible_book, chapter, verse) DO UPDATE SET ' +
      'text = excluded.text, id_language = excluded.id_language',
  )
  emitControl(
    'bible_seed_complete',
    `INSERT INTO configs (key, type, value) VALUES ('${BIBLE_MARKER}', 'number', '1') ` +
      "ON CONFLICT (key) DO UPDATE SET type = 'number', value = '1';",
  )
} else {
  emit(
    'languages',
    ['id_language', 'language', 'created_at', 'updated_at'],
    load<Row[]>('rest/pt_languages.json').map(dated),
  )

  /**
   * `file_name` e `size` passam a descrever o objeto que o acervo tem de fato. A
   * origem guarda o nome do arquivo dela (.mp3, .bmp); no bucket a faixa pode
   * estar em .opus ou ter ficado em .mp3, e só a listagem dele diz qual. A `url`
   * do retrato não serve para isso: ela não é refeita quando a mídia chega depois.
   */
  const bucket = load<Record<string, number>>('bucket-keys.json')
  const files = load<Row[]>('rest/pt_files.json').map((file) => {
    const dir = String(file.dir)
    const original = `${dir}/${file.file_name}`.slice(1)
    const normalized = normalizedMediaPath(original) ?? original
    const key = normalized in bucket ? normalized : original in bucket ? original : null
    if (key === null) throw new Error(`arquivo ${file.id_file}: ${original} não está no acervo`)
    return { ...dated(file), file_name: key.slice(dir.length), size: bucket[key] }
  })
  emit(
    'files',
    [
      'id_file',
      'name',
      'type',
      'size',
      'dir',
      'file_name',
      'image_position',
      'duration',
      'version',
      'created_at',
      'updated_at',
    ],
    files,
  )

  emit(
    'albums',
    ['id_album', 'name', 'id_file_image', 'color', 'id_language', 'created_at', 'updated_at'],
    both('albums').map(dated),
  )
  emit(
    'categories',
    ['id_category', 'name', 'slug', 'order', 'type', 'id_language', 'created_at', 'updated_at'],
    both('categories').map(dated),
  )
  const musics = both('musics')
  emit(
    'musics',
    [
      'id_music',
      'name',
      'id_file_image',
      'id_file_music',
      'id_file_instrumental_music',
      'id_language',
      'created_at',
      'updated_at',
    ],
    musics.map(dated),
  )
  /**
   * A lista de letras não traz as datas; o registro de cada música traz, junto
   * das letras dela. É de lá que saem created_at e updated_at.
   */
  const lyricDates = new Map<number, { created_at: unknown; updated_at: unknown }>()
  for (const music of musics) {
    const item = load<{ lyric?: Row[] }>(`rest/${music.id_language}_music_${music.id_music}.json`)
    for (const lyric of item.lyric ?? []) {
      lyricDates.set(Number(lyric.id_lyric), {
        created_at: lyric.created_at,
        updated_at: lyric.updated_at,
      })
    }
  }
  emit(
    'lyrics',
    [
      'id_lyric',
      'id_music',
      'lyric',
      'aux_lyric',
      'id_file_image',
      'time',
      'instrumental_time',
      'show_slide',
      'order',
      'id_language',
      'created_at',
      'updated_at',
    ],
    both('lyrics').map((lyric) => dated({ ...lyric, ...lyricDates.get(Number(lyric.id_lyric)) })),
  )
  emit(
    'albums_musics',
    ['id_album_music', 'id_album', 'id_music', 'track', 'id_language'],
    both('albums_musics'),
  )
  emit(
    'categories_albums',
    ['id_category_album', 'id_category', 'id_album', 'name', 'order', 'id_language'],
    both('categories_albums'),
  )

  /** Só o que o novo pipeline usa; os marcadores das rotinas da origem ficam para trás. */
  const CONFIG_TYPES: Record<string, string> = {
    version: 'number',
    version_number: 'number',
    latest_updated: 'datetime',
    datetime: 'datetime',
    date: 'date',
    time: 'time',
    pt_delphi_version: 'string',
    es_delphi_version: 'string',
  }
  const config = load<Row>('rest/pt_config.json')
  emit(
    'configs',
    ['key', 'type', 'value'],
    Object.entries(CONFIG_TYPES)
      .filter(([key]) => key in config)
      .map(([key, type]) => ({ key, type, value: String(config[key]) })),
  )

  const bibleVersions =
    bibleSeed?.versions ??
    LANGS.flatMap((lang) =>
      load<Row[]>(`json_db/${lang}_bible_version.json`).map((row) => ({
        ...row,
        id_language: lang,
      })),
    )
  const bibleBooks =
    bibleSeed?.books ??
    LANGS.flatMap((lang) =>
      load<Row[]>(`json_db/${lang}_bible_book.json`).map((row) => ({
        ...row,
        id_language: lang,
      })),
    )
  emit('bible_version', ['id_bible_version', 'name', 'abbreviation', 'id_language'], bibleVersions)
  emit(
    'bible_book',
    [
      'id_bible_book',
      'book_number',
      'name',
      'chapters',
      'testament',
      'keywords',
      'abbreviation',
      'color',
      'id_language',
    ],
    bibleBooks,
  )

  if (INCLUDE_BIBLE) {
    emit(
      'bible_verse',
      ['id_bible_version', 'id_bible_book', 'chapter', 'verse', 'text', 'id_language'],
      bibleSeed?.verses ?? [],
    )
  }

  /**
   * O retrato só traz o que a origem validou no YouTube, sem os ids internos.
   * Eles são recriados aqui, e a lista de playlists que cada canal acompanha é
   * deduzida das playlists que existem.
   */
  type Online = { channels: Row[]; playlists: Row[]; videos: Row[] }
  const channels: Row[] = []
  const playlists: Row[] = []
  const videos: Row[] = []
  for (const lang of LANGS) {
    const online = load<Online>(`rest/${lang}_collections_online.json`)
    const channelId = new Map<unknown, number>()
    const playlistId = new Map<unknown, number>()

    for (const channel of online.channels) {
      channelId.set(channel.channel_id, channels.length + 1)
      channels.push({
        ...channel,
        id_online_video_channel: channels.length + 1,
        status: 'validated',
        playlists: JSON.stringify(
          online.playlists
            .filter((p) => p.channel_id === channel.channel_id)
            .map((p) => p.playlist_id),
        ),
        id_language: lang,
      })
    }
    for (const playlist of online.playlists) {
      playlistId.set(playlist.playlist_id, playlists.length + 1)
      playlists.push({
        ...playlist,
        id_online_video_playlist: playlists.length + 1,
        id_online_video_channel: channelId.get(playlist.channel_id),
        status: 'validated',
        id_language: lang,
      })
    }
    for (const video of online.videos) {
      videos.push({
        ...video,
        id_online_video_playlist: playlistId.get(video.playlist_id),
        status: 'validated',
        id_language: lang,
      })
    }
  }
  emit(
    'online_videos_channels',
    [
      'id_online_video_channel',
      'channel_id',
      'title',
      'custom_url',
      'default_image',
      'default_image_base64',
      'status',
      'playlists',
      'id_language',
    ],
    channels,
  )
  emit(
    'online_videos_playlists',
    [
      'id_online_video_playlist',
      'id_online_video_channel',
      'playlist_id',
      'title',
      'default_image',
      'default_image_base64',
      'status',
      'id_language',
    ],
    playlists,
  )
  emit(
    'online_videos',
    [
      'id_online_video_playlist',
      'video_id',
      'title',
      'sequence',
      'default_image',
      'default_image_base64',
      'status',
      'id_language',
    ],
    videos,
  )

  if (INCLUDE_BIBLE) {
    emitControl(
      'bible_seed_complete',
      `INSERT INTO configs (key, type, value) VALUES ('${BIBLE_MARKER}', 'number', '1') ` +
        "ON CONFLICT (key) DO UPDATE SET type = 'number', value = '1';",
    )
  }
}

console.log(`\n${totalRows} linhas em ${written.length} arquivos, em ${OUT}/`)

// Os arquivos têm de ser aplicados na ordem; o plano só diz onde parar em cada dia.
const days: Array<{ files: string[]; writes: number }> = []
for (const file of written) {
  const today = days.at(-1)
  if (today && today.writes + file.writes <= DAILY_WRITES) {
    today.files.push(file.name)
    today.writes += file.writes
  } else {
    days.push({ files: [file.name], writes: file.writes })
  }
}
console.log(`\nNo plano gratuito (até ${DAILY_WRITES} escritas por dia, contando os índices):`)
for (const [i, day] of days.entries()) {
  const range = day.files.length > 1 ? `${day.files[0]} até ${day.files.at(-1)}` : day.files[0]
  console.log(`  dia ${i + 1}: ${range} — cerca de ${day.writes} escritas`)
}

export {}
