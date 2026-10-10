/**
 * Gera, a partir do banco relacional, os JSON que os apps consomem em /json_db
 * — o que na origem era o DataBase::export_json() do Lumen.
 *
 * Recebe uma réplica local do D1 em SQLite e devolve cada tabela já serializada.
 * A ordem das chaves e das linhas é a dos arquivos publicados: enquanto o
 * conteúdo não muda, os bytes também não, e o hash do manifesto fica estável —
 * é ele que diz aos apps o que precisa ser baixado de novo.
 *
 * Duas diferenças são deliberadas. O texto de busca (`lyric`) das listas de
 * músicas sai inteiro: a origem o montava com group_concat, que o MySQL corta em
 * 1.024 bytes, e o fim das letras longas ficava fora da busca. E onde há empate
 * (faixas com o mesmo número, álbuns na mesma posição) o desempate é pelo id —
 * na origem a ordem desses casos era a que o MySQL calhasse de devolver.
 */
import type { DatabaseSync } from 'node:sqlite'
import { foldSql } from '../../src/lib/sql.ts'

type Row = Record<string, unknown>

export const BIBLE_SEED_COMPLETE_KEY = 'bible_seed_complete'

export type BiblePublicationState =
  | { source: 'bootstrap'; verses: number }
  | {
      source: 'd1'
      verses: number
      chapters: number
      expectedChapters: number
      versions: number
      books: number
    }

type BibleVersionCoverage = { id: number; language: string }
type BibleBookCoverage = { id: number; language: string; chapters: number }

const integer = (value: unknown, label: string, minimum = 0): number => {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${label} inválido: ${String(value)}`)
  }
  return parsed
}

/**
 * O seed bíblico pode levar vários dias no limite gratuito do D1. Enquanto o
 * último arquivo não gravar o marcador, a publicação mantém o retrato estático
 * que já está no R2. Depois do marcador, a cobertura completa é conferida antes
 * de o D1 virar a fonte dos capítulos.
 */
export function inspectBiblePublication(db: DatabaseSync): BiblePublicationState {
  const marker = db
    .prepare('SELECT value FROM configs WHERE key = ?')
    .get(BIBLE_SEED_COMPLETE_KEY) as Row | undefined
  const verseCount = integer(
    (db.prepare('SELECT count(*) AS total FROM bible_verse').get() as Row | undefined)?.total ?? 0,
    'total de versículos',
  )

  if (String(marker?.value ?? '') !== '1') {
    return { source: 'bootstrap', verses: verseCount }
  }
  if (verseCount === 0) {
    throw new Error(
      `${BIBLE_SEED_COMPLETE_KEY}=1, mas bible_verse está vazia; remova o marcador ou conclua o seed`,
    )
  }

  const versions = db
    .prepare('SELECT id_bible_version, id_language FROM bible_version ORDER BY id_bible_version')
    .all()
    .map((row) => ({
      id: integer(row.id_bible_version, 'id_bible_version', 1),
      language: String(row.id_language),
    })) as BibleVersionCoverage[]
  const books = db
    .prepare('SELECT id_bible_book, id_language, chapters FROM bible_book ORDER BY id_bible_book')
    .all()
    .map((row) => ({
      id: integer(row.id_bible_book, 'id_bible_book', 1),
      language: String(row.id_language),
      chapters: integer(row.chapters, 'bible_book.chapters', 1),
    })) as BibleBookCoverage[]

  if (versions.length === 0 || books.length === 0) {
    throw new Error(
      `${BIBLE_SEED_COMPLETE_KEY}=1 sem metadados completos de bible_version/bible_book`,
    )
  }

  const versionLanguages = new Set(versions.map((version) => version.language))
  const bookLanguages = new Set(books.map((book) => book.language))
  for (const language of new Set([...versionLanguages, ...bookLanguages])) {
    if (!versionLanguages.has(language) || !bookLanguages.has(language)) {
      throw new Error(`metadados bíblicos incompletos para o idioma ${language}`)
    }
  }

  const expected = new Set<string>()
  for (const version of versions) {
    for (const book of books) {
      if (book.language !== version.language) continue
      for (let chapter = 1; chapter <= book.chapters; chapter++) {
        expected.add(`${version.id}:${book.id}:${chapter}`)
      }
    }
  }
  if (expected.size === 0) throw new Error('nenhum capítulo bíblico esperado pelos metadados')

  const versionById = new Map(versions.map((version) => [version.id, version]))
  const bookById = new Map(books.map((book) => [book.id, book]))
  const actual = new Set<string>()
  let countedVerses = 0
  const chapterRows = db
    .prepare(
      'SELECT id_bible_version, id_bible_book, chapter, id_language, count(*) AS verses ' +
        'FROM bible_verse GROUP BY id_bible_version, id_bible_book, chapter, id_language ' +
        'ORDER BY id_bible_version, id_bible_book, chapter, id_language',
    )
    .all() as Row[]

  for (const row of chapterRows) {
    const versionId = integer(row.id_bible_version, 'bible_verse.id_bible_version', 1)
    const bookId = integer(row.id_bible_book, 'bible_verse.id_bible_book', 1)
    const chapter = integer(row.chapter, 'bible_verse.chapter', 1)
    const verses = integer(row.verses, 'versículos do capítulo', 1)
    const language = String(row.id_language)
    const version = versionById.get(versionId)
    const book = bookById.get(bookId)
    if (!version || !book) {
      throw new Error(`capítulo bíblico referencia versão/livro ausente: ${versionId}/${bookId}`)
    }
    if (version.language !== language || book.language !== language || chapter > book.chapters) {
      throw new Error(
        `capítulo bíblico fora dos metadados: ${versionId}/${bookId}/${chapter} (${language})`,
      )
    }
    const key = `${versionId}:${bookId}:${chapter}`
    if (actual.has(key)) throw new Error(`capítulo bíblico duplicado entre idiomas: ${key}`)
    actual.add(key)
    countedVerses += verses
  }

  if (countedVerses !== verseCount) {
    throw new Error(`contagem bíblica inconsistente: ${countedVerses} de ${verseCount} versículos`)
  }
  const missing = [...expected].filter((key) => !actual.has(key))
  const unexpected = [...actual].filter((key) => !expected.has(key))
  if (missing.length > 0 || unexpected.length > 0) {
    const sample = (items: string[]) => items.slice(0, 6).join(', ')
    throw new Error(
      `${BIBLE_SEED_COMPLETE_KEY}=1, mas a carga está incompleta: ` +
        `${missing.length} capítulo(s) ausente(s)${missing.length ? ` (${sample(missing)})` : ''}, ` +
        `${unexpected.length} inesperado(s)${unexpected.length ? ` (${sample(unexpected)})` : ''}`,
    )
  }

  return {
    source: 'd1',
    verses: verseCount,
    chapters: actual.size,
    expectedChapters: expected.size,
    versions: versions.length,
    books: books.length,
  }
}

const HAS_INSTRUMENTAL = 'iif(ifnull(m.id_file_instrumental_music, 0) > 0, 1, 0)'
const url = (alias: string) => `(${alias}.dir || '/' || ${alias}.file_name)`
const SEARCH_TEXT =
  "(SELECT group_concat(lyric, ' ') FROM " +
  '(SELECT lyric FROM lyrics WHERE lyrics.id_music = m.id_music ORDER BY "order"))'

export function* generateCatalog(db: DatabaseSync): Generator<[table: string, json: string]> {
  const all = (sql: string, ...params: Array<string | number>) =>
    db.prepare(sql).all(...params) as Row[]
  const languages = all('SELECT id_language FROM languages ORDER BY id_language DESC').map((r) =>
    String(r.id_language),
  )

  const config: Row = {}
  for (const row of all(
    "SELECT key, type, value FROM configs WHERE key IN ('version_number', 'version', 'datetime', 'latest_updated') ORDER BY key",
  )) {
    config[String(row.key)] = row.type === 'number' ? Number(row.value) : row.value
  }
  yield ['config', JSON.stringify(config)]

  const musicAlbums = db.prepare(
    'SELECT a.id_album, a.name, min(c."order") AS "order", c.type, am.id_music AS pivot_id_music, ' +
      'am.id_album AS pivot_id_album, am.track AS pivot_track ' +
      'FROM albums a JOIN albums_musics am ON a.id_album = am.id_album ' +
      'LEFT JOIN categories_albums ca ON ca.id_album = a.id_album ' +
      'LEFT JOIN categories c ON c.id_category = ca.id_category ' +
      "WHERE am.id_music = ? AND c.type IN ('hymnal', 'collection') " +
      'GROUP BY a.id_album, a.name, am.id_music, am.id_album, am.track, c.type ' +
      'ORDER BY "order", a.id_album',
  )

  for (const lang of languages) {
    const musics = all(
      `SELECT m.id_music, m.name, ${HAS_INSTRUMENTAL} AS has_instrumental_music, fm.duration AS duration, ` +
        `${SEARCH_TEXT} AS lyric, ` +
        "(SELECT group_concat(name, '|') FROM (SELECT DISTINCT a.name FROM albums a " +
        'JOIN albums_musics am ON am.id_album = a.id_album ' +
        'JOIN categories_albums ca ON ca.id_album = a.id_album ' +
        'JOIN categories c ON c.id_category = ca.id_category ' +
        // DISTINCT dentro do group_concat faz o MySQL devolver os nomes em ordem alfabética.
        `WHERE c.type IN ('hymnal', 'collection') AND am.id_music = m.id_music ORDER BY ${foldSql('a.name')})) AS albums_names ` +
        'FROM musics m LEFT JOIN files fm ON m.id_file_music = fm.id_file ' +
        'WHERE m.id_language = ? ORDER BY m.id_music',
      lang,
    )
    for (const music of musics) {
      music.albums = (musicAlbums.all(Number(music.id_music)) as Row[]).map((a) => ({
        id_album: a.id_album,
        name: a.name,
        order: a.order,
        type: a.type,
        pivot: { id_music: a.pivot_id_music, id_album: a.pivot_id_album, track: a.pivot_track },
      }))
    }
    yield [`${lang}_musics`, JSON.stringify(musics)]

    for (const category of all(
      "SELECT id_category, slug FROM categories WHERE type = 'hymnal' AND id_language = ? ORDER BY id_category",
      lang,
    )) {
      const hymns = all(
        `SELECT m.id_music, m.name, am.track, ${HAS_INSTRUMENTAL} AS has_instrumental_music, ` +
          `fm.duration AS duration, ${SEARCH_TEXT} AS lyric ` +
          'FROM musics m LEFT JOIN files fm ON m.id_file_music = fm.id_file ' +
          'JOIN albums_musics am ON am.id_music = m.id_music ' +
          'JOIN categories_albums ca ON ca.id_album = am.id_album ' +
          'JOIN categories c ON c.id_category = ca.id_category ' +
          'WHERE c.id_category = ? AND m.id_language = ? ORDER BY am.track, m.id_music',
        Number(category.id_category),
        lang,
      )
      yield [`${lang}_${category.slug}`, JSON.stringify(hymns)]
    }

    const categories = all(
      'SELECT id_category, name, slug, "order" FROM categories ' +
        'WHERE type = \'collection\' AND id_language = ? ORDER BY "order", id_category',
      lang,
    )
    for (const category of categories) {
      category.albums = all(
        `SELECT a.id_album, a.name, a.color, ${url('f')} AS url_image, ca.name AS subtitle, ca."order" ` +
          'FROM albums a JOIN categories_albums ca ON ca.id_album = a.id_album ' +
          'LEFT JOIN files f ON a.id_file_image = f.id_file ' +
          'WHERE ca.id_category = ? ORDER BY ca."order", a.id_album',
        Number(category.id_category),
      )
    }
    yield [`${lang}_categories`, JSON.stringify(categories)]

    yield [
      `${lang}_bible_version`,
      JSON.stringify(
        all(
          'SELECT id_bible_version, name, abbreviation FROM bible_version WHERE id_language = ? ORDER BY name',
          lang,
        ),
      ),
    ]
    yield [
      `${lang}_bible_book`,
      JSON.stringify(
        all(
          'SELECT id_bible_book, book_number, name, chapters, testament, keywords, abbreviation, color ' +
            'FROM bible_book WHERE id_language = ? ORDER BY book_number',
          lang,
        ),
      ),
    ]
  }

  const lyricsOf = db.prepare(
    `SELECT l.id_lyric, l.id_music, l.lyric, l.aux_lyric, ${url('f')} AS url_image, f.image_position, l.time, ` +
      "iif(l.instrumental_time = '00:00:00', l.time, l.instrumental_time) AS instrumental_time, " +
      'l.show_slide, l."order" ' +
      'FROM lyrics l LEFT JOIN files f ON l.id_file_image = f.id_file WHERE l.id_music = ? ORDER BY l."order"',
  )
  const albumsOf = db.prepare(
    `SELECT a.id_album, a.name, am.track, ${url('f')} AS url_image, min(c."order") AS "order" ` +
      'FROM albums a JOIN albums_musics am ON a.id_album = am.id_album ' +
      'LEFT JOIN files f ON a.id_file_image = f.id_file ' +
      'LEFT JOIN categories_albums ca ON ca.id_album = a.id_album ' +
      'LEFT JOIN categories c ON c.id_category = ca.id_category ' +
      "WHERE am.id_music = ? AND c.type IN ('hymnal', 'collection') " +
      'GROUP BY a.id_album, a.name, am.id_music, am.id_album, am.track ORDER BY "order", a.id_album',
  )
  for (const music of all(
    'SELECT m.id_music, m.name, fm.duration AS duration, fi2.duration AS instrumental_duration, ' +
      `${url('fi')} AS url_image, fi.image_position, ${url('fm')} AS url_music, ${url('fi2')} AS url_instrumental_music ` +
      'FROM musics m LEFT JOIN files fi ON m.id_file_image = fi.id_file ' +
      'LEFT JOIN files fm ON m.id_file_music = fm.id_file ' +
      'LEFT JOIN files fi2 ON m.id_file_instrumental_music = fi2.id_file ORDER BY m.id_music',
  )) {
    const id = Number(music.id_music)
    yield [
      `music_${id}`,
      JSON.stringify({ ...music, lyric: lyricsOf.all(id), albums: albumsOf.all(id) }),
    ]
  }

  const musicsOf = db.prepare(
    `SELECT m.id_music, m.name, ${HAS_INSTRUMENTAL} AS has_instrumental_music, fm.duration AS duration, am.track ` +
      'FROM musics m JOIN albums_musics am ON am.id_music = m.id_music ' +
      'LEFT JOIN files fm ON m.id_file_music = fm.id_file WHERE am.id_album = ? ORDER BY am.track, m.id_music',
  )
  for (const album of all(
    `SELECT a.id_album, a.name, a.color, ${url('f')} AS url_image, ` +
      "(SELECT group_concat(c.type || '.' || c.slug, '|') FROM categories c " +
      'JOIN categories_albums ca ON ca.id_category = c.id_category WHERE ca.id_album = a.id_album) AS categories ' +
      'FROM albums a LEFT JOIN files f ON a.id_file_image = f.id_file ORDER BY a.id_album',
  )) {
    // Categoria sem `type` some do group_concat; sem nenhuma, a origem publica [""].
    const categories = String(album.categories ?? '').split('|')
    yield [
      `album_${album.id_album}`,
      JSON.stringify({ ...album, categories, musics: musicsOf.all(Number(album.id_album)) }),
    ]
  }
}

/** Os capítulos da Bíblia: um objeto versículo -> texto por arquivo. */
export function* generateBible(db: DatabaseSync): Generator<[table: string, json: string]> {
  const rows = db
    .prepare(
      'SELECT id_bible_version, id_bible_book, chapter, verse, text FROM bible_verse ' +
        'ORDER BY id_bible_version, id_bible_book, chapter, verse',
    )
    .iterate() as IterableIterator<Row>

  let key = ''
  let chapter: Record<string, unknown> = {}
  for (const row of rows) {
    const current = `${row.id_bible_version}_${row.id_bible_book}_${row.chapter}`
    if (current !== key) {
      if (key) yield [`bible_${key}`, JSON.stringify(chapter)]
      key = current
      chapter = {}
    }
    chapter[String(row.verse)] = row.text
  }
  if (key) yield [`bible_${key}`, JSON.stringify(chapter)]
}
