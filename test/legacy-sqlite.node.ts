import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  exportLegacyDatabases,
  LEGACY_TABLES,
  LEGACY_VIEWS,
} from '../scripts/export-legacy-sqlite.ts'

type Row = Record<string, unknown>

const schema = [
  readFileSync(resolve('migrations/0001_schema.sql'), 'utf8'),
  readFileSync(resolve('migrations/0002_row_counts.sql'), 'utf8'),
].join('\n')

function fixtureSql(includeBibleVerses = true): string {
  const verses = includeBibleVerses
    ? `
      INSERT INTO bible_verse
        (id_bible_verse, id_bible_version, id_bible_book, chapter, verse, text, id_language)
      VALUES
        (1, 1, 1, 1, 1, 'No princípio', 'pt'),
        (2, 2, 67, 1, 1, 'En el principio', 'es');
    `
    : ''

  return `${schema}
    INSERT INTO languages (id_language, language) VALUES ('pt', 'Português'), ('es', 'Español');

    INSERT INTO files
      (id_file, name, type, size, dir, file_name, image_position, version)
    VALUES
      (1, 'capa-pt.bmp', 'cover', 101, '/covers', 'capa-pt.jpg', NULL, 1),
      (2, 'faixa-pt.mp3', 'music', 102, '01234567890Album PT', 'faixa-pt.opus', NULL, 1),
      (3, 'playback-pt.mp3', 'music', 103, '01234567890Album PT', 'playback-pt.mp3', NULL, 1),
      (4, 'fundo-pt.bmp', 'image', 104, '/images', 'fundo-pt.jpg', 3, 1),
      (5, 'capa-es.bmp', 'cover', 105, '/covers', 'capa-es.jpg', NULL, 1),
      (6, 'faixa-es.mp3', 'music', 106, '01234567890Album ES', 'faixa-es.opus', NULL, 1),
      (7, 'playback-es.mp3', 'music', 107, '01234567890Album ES', 'playback-es.mp3', NULL, 1),
      (8, 'fundo-es.bmp', 'image', 108, '/images', 'fundo-es.jpg', 4, 1);

    INSERT INTO albums (id_album, name, id_file_image, color, id_language)
    VALUES (1, 'Álbum PT', 1, '#112233', 'pt'), (2, 'Álbum ES', 5, '#445566', 'es');

    INSERT INTO categories (id_category, name, slug, "order", type, id_language)
    VALUES
      (1, 'Hinário', 'hymnal', 1, 'album', 'pt'),
      (2, 'Himnario', 'hymnal', 1, 'album', 'es');

    INSERT INTO musics
      (id_music, name, id_file_image, id_file_music, id_file_instrumental_music, id_language)
    VALUES
      (1, 'Ação', 4, 2, 3, 'pt'),
      (2, 'Canción', 8, 6, 7, 'es');

    INSERT INTO lyrics
      (id_lyric, id_music, lyric, aux_lyric, id_file_image, time, instrumental_time,
       show_slide, "order", id_language)
    VALUES
      (1, 1, 'Graça', 'Grace', 4, '00:00:05', '00:00:00', 1, 1, 'pt'),
      (2, 2, 'Canción', NULL, 8, '00:00:06', '00:00:07', 1, 1, 'es');

    INSERT INTO albums_musics (id_album_music, id_album, id_music, track, id_language)
    VALUES (1, 1, 1, 1, 'pt'), (2, 2, 2, 1, 'es');

    INSERT INTO categories_albums
      (id_category_album, id_category, id_album, name, "order", id_language)
    VALUES (1, 1, 1, '', 1, 'pt'), (2, 2, 2, '', 1, 'es');

    INSERT INTO configs (key, type, value) VALUES ('version_number', 'number', '186');

    INSERT INTO bible_version (id_bible_version, name, abbreviation, id_language)
    VALUES (1, 'Nova Tradução', 'NTLH', 'pt'), (2, 'Nueva Versión', 'NVI', 'es');

    INSERT INTO bible_book
      (id_bible_book, book_number, name, chapters, testament, keywords, abbreviation,
       color, id_language)
    VALUES
      (1, 1, 'Gênesis', 50, 1, 'genesis', 'Gn', '#112233', 'pt'),
      (67, 1, 'Génesis', 50, 1, 'genesis', 'Gn', '#112233', 'es');

    ${verses}

    INSERT INTO online_videos_channels
      (id_online_video_channel, channel_id, title, custom_url, default_image,
       default_image_base64, status, playlists, id_language)
    VALUES
      (1, 'canal-pt', 'Canal PT', '@pt', 'canal-pt.jpg', 'base64-pt', 'validated', '[]', 'pt'),
      (2, 'canal-es', 'Canal ES', '@es', 'canal-es.jpg', 'base64-es', 'validated', '[]', 'es');

    INSERT INTO online_videos_playlists
      (id_online_video_playlist, id_online_video_channel, playlist_id, title,
       default_image, default_image_base64, status, id_language)
    VALUES
      (1, 1, 'playlist-pt', 'Playlist PT', 'playlist-pt.jpg', 'base64-pt', 'validated', 'pt'),
      (2, 2, 'playlist-es', 'Playlist ES', 'playlist-es.jpg', 'base64-es', 'validated', 'es');

    INSERT INTO online_videos
      (id_online_video, id_online_video_playlist, video_id, title, sequence,
       default_image, default_image_base64, status, id_language)
    VALUES
      (1, 1, 'video-pt', 'Vídeo PT', 1, 'video-pt.jpg', 'base64-pt', 'validated', 'pt'),
      (2, 2, 'video-es', 'Vídeo ES', 1, 'video-es.jpg', 'base64-es', 'validated', 'es');
  `
}

function writeExport(root: string, name: string, includeBibleVerses = true): string {
  const path = join(root, name)
  writeFileSync(path, fixtureSql(includeBibleVerses))
  return path
}

function names(db: DatabaseSync, object: string): string[] {
  return db
    .prepare(`PRAGMA table_info("${object}")`)
    .all()
    .map((record) => String((record as Row).name))
}

test('gera os objetos Delphi, os campos essenciais e um banco por idioma', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'louvorja-legacy-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const outDir = join(root, 'out')

  const results = exportLegacyDatabases({
    exportSql: writeExport(root, 'replica.sql'),
    outDir,
  })

  assert.deepEqual(
    results.map((result) => result.path),
    [join(outDir, 'pt_database.db'), join(outDir, 'es_database.db')],
  )
  assert.deepEqual(
    results.map((result) => result.bibleSource),
    ['d1', 'd1'],
  )
  assert.deepEqual(
    results.map((result) => result.audio),
    ['legacy', 'legacy'],
  )

  const db = new DatabaseSync(join(outDir, 'pt_database.db'), { readOnly: true })
  context.after(() => db.close())

  const legacy = new Map(
    (
      db
        .prepare(
          "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name",
        )
        .all() as Row[]
    ).map((record) => [String(record.name), String(record.type)]),
  )
  for (const table of LEGACY_TABLES) assert.equal(legacy.get(table), 'table', table)
  for (const view of LEGACY_VIEWS) assert.equal(legacy.get(view), 'view', view)

  assert.deepEqual(names(db, 'VERSAO'), ['ID', 'VERSAO_BD'])
  assert.deepEqual(names(db, 'ALBUM'), ['ID', 'NOME', 'IMAGEM', 'PERMITE_DESATIVAR'])
  assert.deepEqual(names(db, 'BIBLIA'), [
    'ID',
    'VERSAO',
    'LIVRO',
    'CAPITULO',
    'VERSICULO',
    'PASSAGEM',
  ])
  assert.deepEqual(names(db, 'MUSICAS_SLIDE'), [
    'TIPO',
    'MUSICA_ID',
    'LETRA_ID',
    'URL_MUSICA',
    'URL_MUSICA_PB',
    'LETRA',
    'LETRA_UCASE',
    'ORDEM',
    'IMAGEM',
    'IMAGEM_POSICAO',
    'TEMPO',
    'TEMPO_PB',
    'FUNDO_LETRA',
    'TAMANHO_LETRA',
    'COR_LETRA',
    'LETRA_AUX',
    'TAMANHO_LETRA_AUX',
    'COR_LETRA_AUX',
  ])
  assert.deepEqual(names(db, 'LISTA_MUSICAS_TODAS'), [
    'ID',
    'ID_ALBUM',
    'NOME_ALBUM',
    'NOME_ALBUM_COM',
    'FAIXA',
    'NOME',
    'NOME_COM',
    'TIPO_HASD',
    'TIPO_JA',
    'TIPO_BAIXADA',
    'TIPO_WEB',
    'TIPO_PERSO',
    'TIPO',
    'URL_ALBUM',
    'ALBUM',
    'URL',
    'URL_INSTRUMENTAL',
    'IDIOMA',
    'LETRA',
    'NOME_SEMAC',
    'LETRA_SEMAC',
    'NOME_ALBUM_COM_SEMAC',
  ])

  assert.deepEqual({ ...db.prepare('SELECT * FROM VERSAO').get() }, { ID: 1, VERSAO_BD: 186 })
  assert.deepEqual(
    db
      .prepare('SELECT ID, PASSAGEM FROM BIBLIA')
      .all()
      .map((record) => ({ ...record })),
    [{ ID: 1, PASSAGEM: 'No princípio' }],
  )
  assert.equal(db.prepare('SELECT NOME_SEMAC FROM HINARIO_ADVENTISTA').get()?.NOME_SEMAC, 'acao')
  assert.deepEqual(
    { ...db.prepare('SELECT URL, URL_INSTRUMENTAL, IMAGEM FROM MUSICAS').get() },
    {
      URL: 'faixa-pt.mp3',
      URL_INSTRUMENTAL: 'playback-pt.mp3',
      IMAGEM: 'fundo-pt.bmp',
    },
  )
  assert.equal(db.prepare('SELECT IMAGEM FROM ALBUM').get()?.IMAGEM, 'capa-pt.bmp')
  assert.deepEqual(
    { ...db.prepare('SELECT URL, URL_INSTRUMENTAL FROM HINARIO_ADVENTISTA').get() },
    { URL: 'faixa-pt.mp3', URL_INSTRUMENTAL: 'playback-pt.mp3' },
  )
  assert.equal(
    db.prepare("SELECT URL_MUSICA FROM MUSICAS_SLIDE WHERE TIPO = 'CAPA'").get()?.URL_MUSICA,
    'Album PT/faixa-pt.mp3',
  )
  assert.equal(db.prepare('SELECT count(*) AS total FROM files').get()?.total, 8)
  assert.deepEqual(
    db
      .prepare('SELECT id_language FROM languages')
      .all()
      .map((record) => ({ ...record })),
    [{ id_language: 'pt' }],
  )
  assert.equal(db.prepare('SELECT count(*) AS total FROM musics').get()?.total, 1)
  assert.equal(db.prepare('SELECT count(*) AS total FROM ONL_VIDEOS').get()?.total, 1)
  assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok')

  for (const systemTable of [
    'configs',
    'users',
    'logs',
    'download_logs',
    'jwt_blacklist',
    'row_counts',
  ]) {
    assert.equal(legacy.has(systemTable), false, systemTable)
  }
})

test('modo stored usa áudio físico e preserva imagens BMP', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'louvorja-legacy-stored-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const [result] = exportLegacyDatabases({
    exportSql: writeExport(root, 'replica.sql'),
    outDir: join(root, 'stored-ftp-root'),
    languages: ['pt'],
    audio: 'stored',
    versionOverride: 187,
    legacyFileSizes: new Map([['images/fundo-pt.jpg', 9_003]]),
  })

  assert.ok(result)
  assert.equal(result.audio, 'stored')
  assert.equal(result.version, 187)
  const db = new DatabaseSync(result.path, { readOnly: true })
  context.after(() => db.close())

  assert.deepEqual(
    { ...db.prepare('SELECT URL, URL_INSTRUMENTAL, IMAGEM FROM MUSICAS').get() },
    {
      URL: 'faixa-pt.opus',
      URL_INSTRUMENTAL: 'playback-pt.mp3',
      IMAGEM: 'fundo-pt.bmp',
    },
  )
  assert.deepEqual(
    { ...db.prepare('SELECT URL, URL_INSTRUMENTAL FROM HINARIO_ADVENTISTA').get() },
    { URL: 'faixa-pt.opus', URL_INSTRUMENTAL: 'playback-pt.mp3' },
  )
  assert.deepEqual(
    {
      ...db
        .prepare("SELECT URL_MUSICA, URL_MUSICA_PB, IMAGEM FROM MUSICAS_SLIDE WHERE TIPO = 'CAPA'")
        .get(),
    },
    {
      URL_MUSICA: 'Album PT/faixa-pt.opus',
      URL_MUSICA_PB: 'Album PT/playback-pt.mp3',
      IMAGEM: 'fundo-pt.bmp',
    },
  )
  assert.deepEqual({ ...db.prepare('SELECT * FROM VERSAO').get() }, { ID: 1, VERSAO_BD: 187 })
  assert.deepEqual(
    db
      .prepare(
        "SELECT TIPO, ARQUIVO FROM ARQUIVOS_SISTEMA WHERE TIPO IN ('MUSICA', 'MUSICA_PB') ORDER BY TIPO",
      )
      .all()
      .map((record) => ({ ...record })),
    [
      { TIPO: 'MUSICA', ARQUIVO: 'faixa-pt.opus' },
      { TIPO: 'MUSICA_PB', ARQUIVO: 'playback-pt.mp3' },
    ],
  )
  assert.equal(db.prepare('SELECT IMAGEM FROM ALBUM').get()?.IMAGEM, 'capa-pt.bmp')
  assert.equal(db.prepare('SELECT IMAGEM FROM MUSICAS_LETRA').get()?.IMAGEM, 'fundo-pt.bmp')
  assert.equal(db.prepare('SELECT TAMANHO_IMAGEM FROM MUSICAS').get()?.TAMANHO_IMAGEM, 9_003)
})

test('modo legacy grava no SQLite o tamanho real do MP3 materializado', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'louvorja-legacy-size-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const [result] = exportLegacyDatabases({
    exportSql: writeExport(root, 'replica.sql'),
    outDir: join(root, 'legacy'),
    languages: ['pt'],
    legacyFileSizes: new Map([
      ['01234567890Album PT/faixa-pt.opus', 9_001],
      ['01234567890Album PT/playback-pt.mp3', 9_002],
    ]),
  })

  assert.ok(result)
  const db = new DatabaseSync(result.path, { readOnly: true })
  context.after(() => db.close())
  assert.deepEqual(
    db
      .prepare(
        "SELECT TIPO, TAMANHO FROM ARQUIVOS_SISTEMA WHERE TIPO IN ('MUSICA', 'MUSICA_PB') ORDER BY TIPO",
      )
      .all()
      .map((record) => ({ ...record })),
    [
      { TIPO: 'MUSICA', TAMANHO: 9_001 },
      { TIPO: 'MUSICA_PB', TAMANHO: 9_002 },
    ],
  )
})

test('preserva a Bíblia do banco anterior quando o export D1 não traz versículos', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'louvorja-legacy-preserve-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const outDir = join(root, 'out')

  exportLegacyDatabases({
    exportSql: writeExport(root, 'with-bible.sql'),
    outDir,
    languages: ['pt'],
  })
  const [result] = exportLegacyDatabases({
    exportSql: writeExport(root, 'without-bible.sql', false),
    outDir,
    languages: ['pt'],
  })

  assert.ok(result)
  assert.equal(result.bibleSource, join(outDir, 'pt_database.db'))
  assert.equal(result.bibleVerses, 1)
  const db = new DatabaseSync(result.path, { readOnly: true })
  context.after(() => db.close())
  assert.equal(db.prepare('SELECT PASSAGEM FROM BIBLIA').get()?.PASSAGEM, 'No princípio')
})

test('recusa a primeira geração sem Bíblia e explica a fonte exigida', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'louvorja-legacy-no-bible-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const outDir = join(root, 'out')

  assert.throws(
    () =>
      exportLegacyDatabases({
        exportSql: writeExport(root, 'without-bible.sql', false),
        outDir,
        languages: ['pt'],
      }),
    /inclua a Bíblia no seed D1 ou informe --bible-source/,
  )
  assert.equal(existsSync(join(outDir, 'pt_database.db')), false)
})
