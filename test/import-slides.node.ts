import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  createImportPlan,
  executeImportPlan,
  loadLocalQueue,
  normalizeSafeRelativePath,
  parseSlidePackage,
  type QueueSource,
} from '../scripts/import-slides.ts'

const repository = resolve(import.meta.dirname, '..')

function cp1252(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'latin1'))
}

function opusBytes(): Uint8Array {
  return new Uint8Array([
    0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0, 0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64,
  ])
}

function makeExport(directory: string): string {
  const path = join(directory, 'replica.sql')
  const schema = readFileSync(join(repository, 'migrations/0001_schema.sql'), 'utf8')
  const journal = readFileSync(join(repository, 'migrations/0003_slide_imports.sql'), 'utf8')
  writeFileSync(
    path,
    schema +
      '\n' +
      journal +
      '\n' +
      "INSERT INTO languages (id_language, language) VALUES ('pt', 'Português');\n" +
      "INSERT INTO configs (key, type, value) VALUES ('version_number', 'number', '185');\n",
  )
  return path
}

function makeSlja(directory: string, malicious = false): string {
  const source = join(directory, malicious ? 'malicious' : 'valid')
  mkdirSync(join(source, 'audio'), { recursive: true })
  mkdirSync(join(source, 'imagens'), { recursive: true })
  const ini = [
    '[Geral]',
    'slides=2',
    'nome=Bênção do Céu',
    'url_musica=audio\\faixa.opus',
    '',
    '[Slide:1]',
    'tipo=CAPA',
    'letra=Bênção do Céu',
    'imagem=imagens\\fundo.jpg',
    '',
    '[Slide:2]',
    'tipo=LETRA',
    'letra=primeira linha|segunda linha',
    'letra_aux=first line',
    'tempo_hms=00:01:02',
  ].join('\r\n')
  writeFileSync(join(source, 'slides.lja'), cp1252(ini))
  writeFileSync(join(source, 'audio/faixa.opus'), opusBytes())
  writeFileSync(join(source, 'imagens/fundo.jpg'), new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))
  const archive = join(directory, malicious ? 'malicious.slja' : 'bencao.slja')
  execFileSync('zip', ['-q', '-r', archive, 'slides.lja', 'audio', 'imagens'], { cwd: source })
  if (malicious) {
    writeFileSync(join(directory, 'escape.txt'), 'escape')
    execFileSync('zip', ['-q', archive, '../escape.txt'], { cwd: source })
  }
  return archive
}

function queueSource(path: string, archived: { count: number }): QueueSource {
  const sourceName = path.split('/').at(-1) as string
  return {
    kind: 'local',
    sourceKey: 'local:' + sourceName,
    sourceName,
    archiveTarget: 'archive/' + sourceName,
    body: new Uint8Array(readFileSync(path)),
    async readSibling() {
      return null
    },
    async archive() {
      archived.count++
    },
  }
}

test('importa ZIP Delphi CP1252, preserva Opus e gera SQL idempotente', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'louvorja-import-slides-test-'))
  try {
    const archived = { count: 0 }
    const source = queueSource(makeSlja(directory), archived)
    const parsed = await parseSlidePackage(source)
    assert.equal(parsed.title, 'Bênção do Céu')
    assert.equal(parsed.audio?.extension, '.opus')
    assert.equal(parsed.audio?.contentType, 'audio/ogg')
    assert.equal(parsed.slides[1]?.lyric, 'Primeira linha\nsegunda linha')
    assert.equal(parsed.slides[1]?.auxLyric, 'First line')
    assert.equal(parsed.slides[1]?.time, '00:01:02')
    assert.equal(parsed.slides[1]?.image?.r2Key, parsed.coverImage?.r2Key)

    const exportPath = makeExport(directory)
    const plan = createImportPlan([parsed], exportPath, '2026-10-10T20:00:00.000Z')
    assert.equal(plan.newPackages.length, 1)
    assert.equal(plan.media.length, 2)
    assert.match(plan.sql, /INSERT INTO slide_imports/)
    assert.match(plan.sql, /\.opus/)
    assert.doesNotMatch(plan.sql, /\b(?:BEGIN|COMMIT)\b/)

    const database = new DatabaseSync(':memory:')
    database.exec(readFileSync(exportPath, 'utf8'))
    database.exec(plan.sql)
    database.exec(plan.sql)
    assert.equal(database.prepare('SELECT count(*) AS total FROM musics').get()?.total, 1)
    assert.equal(database.prepare('SELECT count(*) AS total FROM lyrics').get()?.total, 1)
    assert.equal(database.prepare('SELECT count(*) AS total FROM files').get()?.total, 2)
    const row = database
      .prepare(
        'SELECT m.name, f.name AS legacy_name, f.dir, f.file_name, l.lyric, l.aux_lyric, l.time FROM musics m JOIN files f ON f.id_file=m.id_file_music JOIN lyrics l ON l.id_music=m.id_music',
      )
      .get()
    assert.equal(row?.name, 'Bênção do Céu')
    assert.match(String(row?.file_name), /^[a-f0-9]{64}\.opus$/)
    assert.equal(row?.legacy_name, row?.file_name)
    assert.equal(
      database.prepare('SELECT count(*) total FROM files WHERE name <> file_name').get()?.total,
      0,
    )
    assert.equal(row?.dir, '/musics/pt/imports')
    assert.equal(row?.lyric, 'Primeira linha\nsegunda linha')
    assert.equal(row?.aux_lyric, 'First line')
    assert.equal(row?.time, '00:01:02')
    database.close()

    const writes: string[] = []
    let sqlExecutions = 0
    const dryRun = await executeImportPlan(
      plan,
      { write: false, database: 'louvorja', sqlPath: join(directory, 'import.sql') },
      {
        objectStore: {
          async get() {
            throw new Error('dry-run não deve consultar destino de mídia')
          },
          async put() {
            throw new Error('dry-run não deve escrever mídia')
          },
        },
        async executeSql() {
          throw new Error('dry-run não deve executar D1')
        },
      },
    )
    assert.deepEqual(dryRun, { uploaded: 0, reused: 0, sqlExecuted: false, archived: 0 })
    assert.equal(archived.count, 0)

    const stored = new Map<string, Uint8Array>()
    const applied = await executeImportPlan(
      plan,
      { write: true, database: 'louvorja', sqlPath: join(directory, 'import.sql') },
      {
        objectStore: {
          async get(key) {
            return stored.get(key) ?? null
          },
          async put(key, body) {
            writes.push(key)
            stored.set(key, body)
          },
        },
        async executeSql() {
          sqlExecutions++
        },
      },
    )
    assert.equal(writes.length, 2)
    assert.equal(sqlExecutions, 1)
    assert.equal(archived.count, 1)
    assert.deepEqual(applied, { uploaded: 2, reused: 0, sqlExecuted: true, archived: 1 })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('aceita .lja solto com MP3 e imagem ao lado sem sair da pasta da fila', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'louvorja-import-lja-test-'))
  try {
    mkdirSync(join(directory, 'audio'))
    mkdirSync(join(directory, 'imagens'))
    writeFileSync(join(directory, 'audio/hino.mp3'), new Uint8Array([0x49, 0x44, 0x33, 1]))
    writeFileSync(join(directory, 'imagens/capa.bmp'), new Uint8Array([0x42, 0x4d, 1, 2]))
    writeFileSync(
      join(directory, 'hino.lja'),
      cp1252(
        [
          '[Geral]',
          'slides=2',
          'url_musica=audio\\hino.mp3',
          '[Slide:1]',
          'tipo=CAPA',
          'letra=Hino Antigo',
          'imagem=imagens\\capa.bmp',
          '[Slide:2]',
          'tipo=LETRA',
          'letra=estrofe',
          'tempo=1764000',
        ].join('\r\n'),
      ),
    )
    const [source] = loadLocalQueue(directory, join(directory, 'imported'))
    assert.ok(source)
    const parsed = await parseSlidePackage(source)
    assert.equal(parsed.audio?.extension, '.mp3')
    assert.equal(parsed.coverImage?.extension, '.bmp')
    assert.equal(parsed.slides[1]?.time, '00:00:10')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('recusa áudio e imagem renomeados antes de planejar gravações em R2/D1', async (context) => {
  const ini = cp1252(
    [
      '[Geral]',
      'slides=1',
      'url_musica=audio/faixa.opus',
      '[Slide:1]',
      'tipo=CAPA',
      'letra=Arquivo inválido',
      'imagem=imagens/fundo.png',
    ].join('\r\n'),
  )
  const source = (media: ReadonlyMap<string, Uint8Array>): QueueSource => ({
    kind: 'local',
    sourceKey: 'local:invalido.lja',
    sourceName: 'invalido.lja',
    archiveTarget: 'archive/invalido.lja',
    body: ini,
    async readSibling(reference) {
      return media.get(reference) ?? null
    },
    async archive() {
      context.assert.fail('pacote inválido não pode ser arquivado')
    },
  })
  const validPng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  await assert.rejects(
    () =>
      parseSlidePackage(
        source(
          new Map([
            ['audio/faixa.opus', new Uint8Array(Buffer.from('não é Opus'))],
            ['imagens/fundo.png', validPng],
          ]),
        ),
      ),
    /áudio .*\.opus não contém assinatura Ogg\/Opus/,
  )

  const mp3Ini = new Uint8Array(
    Buffer.from(new TextDecoder('windows-1252').decode(ini).replace('.opus', '.mp3'), 'latin1'),
  )
  const mp3Source = source(
    new Map([
      ['audio/faixa.mp3', new Uint8Array(Buffer.from('não é MP3'))],
      ['imagens/fundo.png', validPng],
    ]),
  )
  mp3Source.body = mp3Ini
  await assert.rejects(
    () => parseSlidePackage(mp3Source),
    /áudio .*\.mp3 não contém assinatura MP3/,
  )

  await assert.rejects(
    () =>
      parseSlidePackage(
        source(
          new Map([
            ['audio/faixa.opus', opusBytes()],
            ['imagens/fundo.png', new Uint8Array(Buffer.from('não é PNG'))],
          ]),
        ),
      ),
    /imagem .*\.png não contém assinatura PNG/,
  )
})

test('recusa nomes absolutos, traversal e ZIP com entrada fora da raiz', async () => {
  for (const path of ['../segredo', 'audio/../../segredo', '/etc/passwd', 'C:\\Windows\\x']) {
    assert.throws(() => normalizeSafeRelativePath(path))
  }
  assert.equal(normalizeSafeRelativePath('audio\\faixa.opus'), 'audio/faixa.opus')

  const directory = mkdtempSync(join(tmpdir(), 'louvorja-import-malicious-test-'))
  try {
    const source = queueSource(makeSlja(directory, true), { count: 0 })
    await assert.rejects(() => parseSlidePackage(source), /caminho relativo inseguro|ZIP inválido/)
    assert.equal(readFileSync(join(directory, 'escape.txt'), 'utf8'), 'escape')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('recusa troca de conteúdo sob a mesma chave já importada', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'louvorja-import-conflict-test-'))
  try {
    const source = queueSource(makeSlja(directory), { count: 0 })
    const parsed = await parseSlidePackage(source)
    const exportPath = makeExport(directory)
    const initial = createImportPlan([parsed], exportPath)

    const database = new DatabaseSync(':memory:')
    database.exec(readFileSync(exportPath, 'utf8'))
    database.exec(initial.sql)
    const journal = database
      .prepare(
        'SELECT source_key, source_sha256, source_kind, source_name, id_music, imported_at FROM slide_imports',
      )
      .get()
    assert.ok(journal)
    const conflictedExport = join(directory, 'conflicted.sql')
    writeFileSync(
      conflictedExport,
      readFileSync(exportPath, 'utf8') +
        '\n' +
        'INSERT INTO musics (id_music, name, id_language) VALUES (' +
        Number(journal.id_music) +
        ", 'Anterior', 'pt');\n" +
        'INSERT INTO slide_imports (source_key, source_sha256, source_kind, source_name, id_music, imported_at) VALUES (' +
        "'" +
        String(journal.source_key).replaceAll("'", "''") +
        "', '" +
        '0'.repeat(64) +
        "', 'local', 'anterior.slja', " +
        Number(journal.id_music) +
        ", '2026-10-10 00:00:00');\n",
    )
    database.close()
    assert.throws(
      () => createImportPlan([parsed], conflictedExport),
      /já foi importada com outro conteúdo/,
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
