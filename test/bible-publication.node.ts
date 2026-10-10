import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { generateBible, inspectBiblePublication } from '../scripts/lib/catalog.ts'
import { type ManifestEntry, md5, planJsonDb } from '../scripts/lib/publication.ts'

function bibleDb(options: { marker?: boolean; chapters?: number; loaded?: number } = {}) {
  const db = new DatabaseSync(':memory:')
  db.exec(`
    CREATE TABLE configs (key TEXT PRIMARY KEY, type TEXT NOT NULL, value TEXT);
    CREATE TABLE bible_version (
      id_bible_version INTEGER PRIMARY KEY, id_language TEXT NOT NULL
    );
    CREATE TABLE bible_book (
      id_bible_book INTEGER PRIMARY KEY, chapters INTEGER NOT NULL, id_language TEXT NOT NULL
    );
    CREATE TABLE bible_verse (
      id_bible_verse INTEGER PRIMARY KEY AUTOINCREMENT,
      id_bible_version INTEGER NOT NULL,
      id_bible_book INTEGER NOT NULL,
      chapter INTEGER NOT NULL,
      verse INTEGER NOT NULL,
      text TEXT NOT NULL,
      id_language TEXT NOT NULL,
      UNIQUE (id_bible_version, id_bible_book, chapter, verse)
    );
    INSERT INTO bible_version (id_bible_version, id_language) VALUES (1, 'pt');
    INSERT INTO bible_book (id_bible_book, chapters, id_language)
      VALUES (1, ${options.chapters ?? 1}, 'pt');
  `)
  for (let chapter = 1; chapter <= (options.loaded ?? 1); chapter++) {
    db.prepare(
      'INSERT INTO bible_verse ' +
        '(id_bible_version, id_bible_book, chapter, verse, text, id_language) ' +
        "VALUES (1, 1, ?, 1, ?, 'pt')",
    ).run(chapter, chapter === 1 ? 'No começo' : `Capítulo ${chapter}`)
  }
  if (options.marker) {
    db.exec("INSERT INTO configs (key, type, value) VALUES ('bible_seed_complete', 'number', '1')")
  }
  return db
}

const entry = (table: string, hash: string): ManifestEntry => ({
  file: `${table}.json`,
  table,
  path: `/db/${table}`,
  hash,
})

test('mudança de versículo no D1 altera o JSON e o hash publicados', () => {
  const db = bibleDb({ marker: true })
  try {
    const state = inspectBiblePublication(db)
    assert.equal(state.source, 'd1')
    const generated = new Map(generateBible(db))
    assert.equal(generated.get('bible_1_1_1'), '{"1":"No começo"}')

    const old = '{"1":"No princípio"}'
    const plan = planJsonDb(generated, () => old, [entry('bible_1_1_1', md5(old))], {
      preserveBible: false,
    })
    assert.deepEqual(plan.changed, ['bible_1_1_1'])
    assert.deepEqual(plan.puts, [{ key: 'json_db/bible_1_1_1.json', body: '{"1":"No começo"}' }])
    assert.equal(plan.manifest[0]?.hash, md5('{"1":"No começo"}'))
  } finally {
    db.close()
  }
})

test('D1 vazio ou parcial sem marcador preserva os capítulos publicados', () => {
  for (const loaded of [0, 1]) {
    const db = bibleDb({ chapters: 2, loaded })
    try {
      assert.deepEqual(inspectBiblePublication(db), {
        source: 'bootstrap',
        verses: loaded,
      })
      const old = '{"1":"capítulo estático"}'
      const manifest = [entry('bible_1_1_1', md5(old))]
      const plan = planJsonDb(new Map(), () => old, manifest, { preserveBible: true })
      assert.deepEqual(plan.deletes, [])
      assert.deepEqual(plan.removed, [])
      assert.deepEqual(plan.manifest, manifest)
    } finally {
      db.close()
    }
  }
})

test('marcador não aceita carga parcial', () => {
  const db = bibleDb({ marker: true, chapters: 2, loaded: 1 })
  try {
    assert.throws(() => inspectBiblePublication(db), /carga está incompleta/)
  } finally {
    db.close()
  }
})

test('--bible-only gera chunks retomáveis e ativa o marcador somente no último arquivo', () => {
  const root = mkdtempSync(join(tmpdir(), 'louvorja-bible-publication-'))
  const snapshot = join(root, 'snapshot')
  const out = join(root, 'seed')
  mkdirSync(join(snapshot, 'json_db'), { recursive: true })
  mkdirSync(join(snapshot, 'bible'), { recursive: true })

  const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value))
  json(join(snapshot, 'json_db', 'pt_bible_version.json'), [
    { id_bible_version: 1, name: 'Versão PT', abbreviation: 'PT' },
  ])
  json(join(snapshot, 'json_db', 'es_bible_version.json'), [
    { id_bible_version: 2, name: 'Versión ES', abbreviation: 'ES' },
  ])
  json(join(snapshot, 'json_db', 'pt_bible_book.json'), [
    {
      id_bible_book: 1,
      book_number: 1,
      name: 'Livro',
      chapters: 1,
      testament: 1,
      keywords: '',
      abbreviation: 'Lv',
      color: '#000',
    },
  ])
  json(join(snapshot, 'json_db', 'es_bible_book.json'), [
    {
      id_bible_book: 2,
      book_number: 1,
      name: 'Libro',
      chapters: 1,
      testament: 1,
      keywords: '',
      abbreviation: 'Lb',
      color: '#000',
    },
  ])
  json(join(snapshot, 'bible', 'bible_1_1_1.json'), { 1: "No princípio d'Ele" })
  json(join(snapshot, 'bible', 'bible_2_2_1.json'), { 1: 'En el principio' })

  try {
    execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        resolve('scripts/seed-d1.ts'),
        `--snapshot=${snapshot}`,
        `--out=${out}`,
        '--bible-only',
      ],
      { cwd: resolve('.'), stdio: 'pipe' },
    )
    const files = readdirSync(out).sort()
    assert.deepEqual(files, [
      '01_bible_seed_begin.sql',
      '02_bible_verse.sql',
      '03_bible_seed_complete.sql',
    ])

    const db = new DatabaseSync(':memory:')
    try {
      db.exec(`
        CREATE TABLE configs (key TEXT PRIMARY KEY, type TEXT NOT NULL, value TEXT);
        CREATE TABLE bible_version (
          id_bible_version INTEGER PRIMARY KEY, id_language TEXT NOT NULL
        );
        CREATE TABLE bible_book (
          id_bible_book INTEGER PRIMARY KEY, chapters INTEGER NOT NULL, id_language TEXT NOT NULL
        );
        CREATE TABLE bible_verse (
          id_bible_verse INTEGER PRIMARY KEY AUTOINCREMENT,
          id_bible_version INTEGER NOT NULL,
          id_bible_book INTEGER NOT NULL,
          chapter INTEGER NOT NULL,
          verse INTEGER NOT NULL,
          text TEXT NOT NULL,
          id_language TEXT NOT NULL,
          UNIQUE (id_bible_version, id_bible_book, chapter, verse)
        );
        INSERT INTO bible_version (id_bible_version, id_language) VALUES (1, 'pt'), (2, 'es');
        INSERT INTO bible_book (id_bible_book, chapters, id_language)
          VALUES (1, 1, 'pt'), (2, 1, 'es');
      `)
      db.exec(readFileSync(join(out, files[0] as string), 'utf8'))
      db.exec(readFileSync(join(out, files[1] as string), 'utf8'))
      db.exec(readFileSync(join(out, files[1] as string), 'utf8'))
      assert.deepEqual(inspectBiblePublication(db), { source: 'bootstrap', verses: 2 })

      db.exec(readFileSync(join(out, files[2] as string), 'utf8'))
      const complete = inspectBiblePublication(db)
      assert.equal(complete.source, 'd1')
      assert.equal(complete.verses, 2)
      assert.equal(complete.chapters, 2)
      assert.equal(
        db.prepare("SELECT text FROM bible_verse WHERE id_language = 'pt'").get()?.text,
        "No princípio d'Ele",
      )
    } finally {
      db.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
