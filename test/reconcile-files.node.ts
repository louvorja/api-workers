import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildSqlBatches,
  type FileRow,
  type FileUpdate,
  formatDuration,
  hasReconcileIssues,
  loadFilesFromExport,
  parseFfprobeDuration,
  reconcileRows,
  renderSqlFile,
  renderUpdateSql,
  resolveObjectKey,
} from '../scripts/reconcile-files.ts'

const rows: FileRow[] = [
  {
    idFile: 1,
    type: 'music',
    size: 0,
    dir: '/musics/pt/',
    fileName: '/song.opus',
    duration: null,
  },
  {
    idFile: 2,
    type: 'image',
    size: 10,
    dir: '/images',
    fileName: '/cover.jpg',
    duration: null,
  },
  {
    idFile: 3,
    type: 'music',
    size: 9,
    dir: '/musics/es',
    fileName: '/missing.mp3',
    duration: '',
  },
  {
    idFile: 4,
    type: 'music',
    size: 3,
    dir: '/musics/pt',
    fileName: '/old.mp3',
    duration: '00:00:10',
  },
]

test('resolve chaves legadas sem permitir travessia ou subpastas no nome', () => {
  assert.equal(
    resolveObjectKey({ dir: '/musics/pt/', fileName: '/song.opus' }),
    'musics/pt/song.opus',
  )
  assert.throws(
    () => resolveObjectKey({ dir: '/musics/../private', fileName: '/song.opus' }),
    /segmento inseguro/,
  )
  assert.throws(
    () => resolveObjectKey({ dir: '/musics/pt', fileName: '/nested/song.opus' }),
    /somente o nome/,
  )
  assert.throws(
    () => resolveObjectKey({ dir: '/musics\\pt', fileName: 'song.opus' }),
    /separador inválido/,
  )
})

test('formata a duração do ffprobe truncando a fração sem limitar a 24 horas', () => {
  assert.equal(formatDuration(0), '00:00:00')
  assert.equal(formatDuration(3661.999), '01:01:01')
  assert.equal(formatDuration(90061.8), '25:01:01')
  assert.equal(parseFfprobeDuration('61.250000\n'), 61.25)
  assert.throws(() => parseFfprobeDuration('N/A\n'), /duração inválida/)
})

test('reconcilia divergências e mantém objetos ausentes fora dos UPDATEs', async () => {
  const listedPrefixes: string[] = []
  const downloaded: string[] = []
  const result = await reconcileRows(
    rows,
    { task: 'all', concurrency: 2 },
    {
      async listWithSizes(prefix = '') {
        listedPrefixes.push(prefix)
        if (prefix === 'images/') return new Map([['images/cover.jpg', 10]])
        return new Map<string, number>([
          ['musics/pt/song.opus', 123],
          ['musics/pt/old.mp3', 5],
        ])
      },
      async get(key) {
        downloaded.push(key)
        return key.endsWith('missing.mp3') ? null : new Uint8Array([1, 2, 3])
      },
      async prepareDuration() {},
      async probeDuration(_body, key) {
        assert.equal(key, 'musics/pt/song.opus')
        return 61.9
      },
    },
  )

  assert.deepEqual(listedPrefixes.sort(), ['images/', 'musics/'])
  assert.deepEqual(downloaded.sort(), ['musics/es/missing.mp3', 'musics/pt/song.opus'])
  assert.deepEqual(
    result.updates.map(({ idFile, field, before, after }) => ({ idFile, field, before, after })),
    [
      { idFile: 1, field: 'duration', before: null, after: '00:01:01' },
      { idFile: 1, field: 'size', before: 0, after: 123 },
      { idFile: 4, field: 'size', before: 3, after: 5 },
    ],
  )
  assert.deepEqual(
    result.missing.map(({ task, idFile, key }) => ({ task, idFile, key })),
    [
      { task: 'duration', idFile: 3, key: 'musics/es/missing.mp3' },
      { task: 'size', idFile: 3, key: 'musics/es/missing.mp3' },
    ],
  )
  assert.equal(
    result.updates.some((update) => update.idFile === 3),
    false,
  )
  assert.equal(result.failures.length, 0)
  assert.deepEqual(result.size, {
    inspected: 4,
    eligible: 4,
    checked: 3,
    unchanged: 1,
    updates: 2,
    missing: 1,
    failures: 0,
  })
  assert.deepEqual(result.duration, {
    inspected: 3,
    eligible: 2,
    checked: 1,
    unchanged: 0,
    updates: 1,
    missing: 1,
    failures: 0,
  })
  assert.equal(hasReconcileIssues(result), true)
})

test('falha de listagem não é confundida com tamanho zero nem objeto ausente', async () => {
  const result = await reconcileRows(
    [rows[0] as FileRow],
    { task: 'size' },
    {
      async listWithSizes() {
        throw new Error('R2 indisponível')
      },
      async get() {
        throw new Error('não deve baixar na tarefa size')
      },
      async probeDuration() {
        throw new Error('não deve executar ffprobe na tarefa size')
      },
    },
  )

  assert.equal(result.updates.length, 0)
  assert.equal(result.missing.length, 0)
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0]?.stage, 'list')
  assert.equal(hasReconcileIssues(result), true)
})

test('--force analisa durações preenchidas, mas não gera UPDATE sem mudança', async () => {
  let probes = 0
  const result = await reconcileRows(
    [rows[3] as FileRow],
    { task: 'duration', force: true },
    {
      async listWithSizes() {
        throw new Error('a tarefa duration não deve listar o bucket')
      },
      async get() {
        return new Uint8Array([1])
      },
      async probeDuration() {
        probes++
        return 10.8
      },
    },
  )

  assert.equal(probes, 1)
  assert.equal(result.updates.length, 0)
  assert.equal(result.duration?.unchanged, 1)
})

test('gera lotes limitados com condições otimistas e strings escapadas', () => {
  const updates: FileUpdate[] = [
    {
      idFile: 7,
      key: "musics/pt/o'hino.opus",
      dir: "/musics/pt/o'hinos",
      fileName: "/o'hino.opus",
      field: 'size',
      before: 0,
      after: 456,
    },
    {
      idFile: 7,
      key: "musics/pt/o'hino.opus",
      dir: "/musics/pt/o'hinos",
      fileName: "/o'hino.opus",
      field: 'duration',
      before: null,
      after: '00:02:03',
    },
    {
      idFile: 8,
      key: 'images/a.jpg',
      dir: '/images',
      fileName: '/a.jpg',
      field: 'size',
      before: 1,
      after: 2,
    },
  ]

  const first = renderUpdateSql(updates[0] as FileUpdate)
  assert.match(first, /SET "size" = 456/)
  assert.match(first, /"dir" = '\/musics\/pt\/o''hinos'/)
  assert.match(first, /AND "size" = 0;/)
  const duration = renderUpdateSql(updates[1] as FileUpdate)
  assert.match(duration, /"duration" IS NULL;/)
  assert.match(duration, /CURRENT_TIMESTAMP/)

  const batches = buildSqlBatches(updates, 2)
  assert.deepEqual(
    batches.map((batch) => batch.updates),
    [2, 1],
  )
  assert.match(renderSqlFile(batches), /Lote 1\/2/)
  assert.equal(renderSqlFile([]), '-- Nenhuma atualização necessária.\n')
})

test('carrega a tabela files diretamente de um export do D1', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'louvorja-reconcile-export-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const exportPath = join(root, 'replica.sql')
  writeFileSync(
    exportPath,
    `
      CREATE TABLE files (
        id_file INTEGER PRIMARY KEY,
        type TEXT NOT NULL,
        size INTEGER NOT NULL,
        dir TEXT NOT NULL,
        file_name TEXT NOT NULL,
        duration TEXT,
        updated_at TEXT
      );
      INSERT INTO files VALUES
        (2, 'image', 20, '/images', '/b.jpg', NULL, NULL),
        (1, 'music', 10, '/musics/pt', '/a.opus', '', NULL);
    `,
  )

  assert.deepEqual(loadFilesFromExport(exportPath), [
    {
      idFile: 1,
      type: 'music',
      size: 10,
      dir: '/musics/pt',
      fileName: '/a.opus',
      duration: '',
    },
    {
      idFile: 2,
      type: 'image',
      size: 20,
      dir: '/images',
      fileName: '/b.jpg',
      duration: null,
    },
  ])
})
