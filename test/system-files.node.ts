import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { exportLegacyDatabases } from '../scripts/export-legacy-sqlite.ts'
import {
  acknowledgeSystemFiles,
  canReuseSystemState,
  parseSystemState,
  prepareSystemFiles,
  resolveSystemSourcePin,
  SYSTEM_FILES,
  SYSTEM_STATE_KEY,
  SYSTEM_VERIFY_INTERVAL_MS,
  type SystemFile,
  sha256,
  syncSystemFiles,
  systemSourcePath,
  systemSourceUrl,
} from '../scripts/lib/system-files.ts'

const now = new Date('2026-10-13T15:00:00Z')
const commit = '34175ab3c0eb2a61621b411c4359b269092b736f'

function fileBytes(path: string): Buffer {
  const bytes = Buffer.alloc(128)
  if (/\.(exe|dll)$/.test(path)) {
    bytes.write('MZ')
    bytes.writeUInt32LE(64, 60)
    bytes.write('PE\0\0', 64)
  } else if (path.endsWith('.mp3')) bytes.write('ID3')
  else if (path.endsWith('.ttf')) bytes.writeUInt32BE(0x00010000)
  else if (path.endsWith('.ico')) {
    bytes.writeUInt32LE(0x00010000)
    bytes.writeUInt16LE(1, 4)
  } else bytes.write('<!doctype html><html><body>LouvorJA</body></html>')
  return bytes
}

function releaseFixture() {
  const installer = fileBytes('installer.exe')
  return {
    installer,
    release: {
      id: 379802871,
      tag_name: 'v26.11',
      draft: false,
      prerelease: false,
      assets: [
        { name: 'LoorJA_Instalador26.11.exe' },
        {
          id: 538074860,
          name: 'LouvorJA_Instalador26.11.exe',
          size: installer.length,
          digest: `sha256:${sha256(installer)}`,
          browser_download_url:
            'https://github.com/louvorja/desktop/releases/download/v26.11/LouvorJA_Instalador26.11.exe',
        },
      ],
    },
  }
}

async function preparedFixture(readSource = async (file: SystemFile) => fileBytes(file.path)) {
  const { installer, release } = releaseFixture()
  const pin = resolveSystemSourcePin(release, { sha: commit })
  return prepareSystemFiles(
    pin,
    installer,
    async (_body, paths) => new Map(paths.map((path) => [path, fileBytes(path)])),
    readSource,
  )
}

function storageFixture() {
  const objects = new Map<string, Uint8Array>()
  const writes: string[] = []
  let failAt = -1
  return {
    objects,
    writes,
    failAt(index: number) {
      failAt = index
    },
    async get(key: string) {
      return objects.get(key) ?? null
    },
    async put(key: string, body: Uint8Array | string) {
      writes.push(key)
      if (writes.length === failAt) throw new Error('falha simulada no R2')
      objects.set(key, typeof body === 'string' ? Buffer.from(body) : Uint8Array.from(body))
    },
  }
}

test('seleciona o instalador LouvorJA final e fixa as cinco fontes no mesmo commit', async () => {
  const { release, installer } = releaseFixture()
  const pin = resolveSystemSourcePin(release, { sha: commit })
  assert.equal(pin.asset_id, 538074860)
  const requests: string[] = []
  const prepared = await prepareSystemFiles(
    pin,
    installer,
    async (body, paths) => {
      assert.deepEqual(body, installer)
      assert.equal(paths.length, 11)
      return new Map(paths.map((path) => [path, fileBytes(path)]))
    },
    async (file, sha) => {
      assert.equal(sha, commit)
      requests.push(systemSourceUrl(file, sha))
      return fileBytes(file.path)
    },
  )
  assert.equal(prepared.files.length, 16)
  assert.equal(requests.length, 5)
  assert.ok(
    requests.every((url) =>
      url.startsWith(`https://raw.githubusercontent.com/louvorja/desktop/${commit}/`),
    ),
  )
  //assert.deepEqual(prepared.bodies.get('system/LouvorJA.exe'), fileBytes('app/LouvorJA.exe'))
  assert.equal(
    prepared.files.find((file) => file.key.endsWith('/index.html'))?.provenance.kind,
    'github-source',
  )
  assert.throws(
    () => resolveSystemSourcePin({ ...release, prerelease: true }, { sha: commit }),
    /release final/,
  )
  assert.throws(
    () => resolveSystemSourcePin({ ...release, draft: true }, { sha: commit }),
    /release final/,
  )
  assert.throws(
    () =>
      resolveSystemSourcePin(
        { ...release, assets: [...release.assets, release.assets[1]] },
        { sha: commit },
      ),
    /exatamente um/,
  )
  assert.throws(() => resolveSystemSourcePin(release, { sha: 'main' }), /SHA inválido/)
})

test('não aceita instalador divergente, arquivo ausente, PE inválido ou HTML truncado', async () => {
  const { release, installer } = releaseFixture()
  const pin = resolveSystemSourcePin(release, { sha: commit })
  const extract = async (_body: Uint8Array, paths: string[]) =>
    new Map(paths.map((path) => [path, fileBytes(path)]))
  await assert.rejects(
    prepareSystemFiles({ ...pin, asset_size: 999 }, installer, extract, async (file) =>
      fileBytes(file.path),
    ),
    /difere do release/,
  )
  await assert.rejects(
    prepareSystemFiles({ ...pin, asset_sha256: '0'.repeat(64) }, installer, extract, async (file) =>
      fileBytes(file.path),
    ),
    /difere do release/,
  )
  await assert.rejects(
    prepareSystemFiles(
      pin,
      installer,
      async () => new Map(),
      async (file) => fileBytes(file.path),
    ),
    /ausente no instalador/,
  )
  await assert.rejects(
    preparedFixture(async () => Buffer.alloc(128)),
    /assinatura inválida/,
  )
  await assert.rejects(
    preparedFixture(async (file) =>
      file.path.endsWith('index.html')
        ? Buffer.from('<html><body>conteúdo sem fechamento do HTML')
        : fileBytes(file.path),
    ),
    /assinatura inválida/,
  )
})

test('simulação não escreve; publicação preserva backups e grava estado depois dos 16 objetos', async () => {
  const prepared = await preparedFixture()
  const storage = storageFixture()
  storage.objects.set('meta/params.json', Buffer.from('{"db_version":185}'))
  const simulated = await syncSystemFiles(prepared, storage, { now })
  assert.equal(simulated.changed, true)
  assert.equal(storage.writes.length, 0)
  const published = await syncSystemFiles(prepared, storage, { now, write: true })
  assert.equal(published.changedKeys.length, 16)
  assert.deepEqual(storage.writes, [...prepared.files.map((file) => file.key), SYSTEM_STATE_KEY])
  assert.equal(
    Buffer.from(storage.objects.get('meta/params.json')!).toString(),
    '{"db_version":185}',
  )
  assert.ok(storage.writes.every((key) => key.startsWith('system/') || key === SYSTEM_STATE_KEY))
  assert.equal(parseSystemState(storage.objects.get(SYSTEM_STATE_KEY)!)?.pending_delphi_db, true)
})

test('hashes reais detectam corrupção de mesmo tamanho; conteúdo intacto não é republicado', async () => {
  const prepared = await preparedFixture()
  const storage = storageFixture()
  const initial = await syncSystemFiles(prepared, storage, { now, write: true })
  await acknowledgeSystemFiles(storage, initial.state.manifest_sha256, true)
  storage.writes.length = 0
  const same = await syncSystemFiles(prepared, storage, { now, write: true })
  assert.equal(same.changed, false)
  assert.deepEqual(storage.writes, [])
  const key = 'system/config/1minuto_escsb.mp3'
  storage.objects.get(key)![100] = 99
  const repaired = await syncSystemFiles(prepared, storage, { now, write: true })
  assert.deepEqual(repaired.changedKeys, [key])
  assert.deepEqual(storage.writes, [key, SYSTEM_STATE_KEY])
  assert.equal(repaired.changed, true)
})

test('falha parcial é retomada sem reenviar arquivos prontos e mantém DB pendente até ACK', async () => {
  const prepared = await preparedFixture()
  const storage = storageFixture()
  storage.failAt(3)
  await assert.rejects(syncSystemFiles(prepared, storage, { now, write: true }), /falha simulada/)
  assert.equal(storage.objects.has(SYSTEM_STATE_KEY), false)
  storage.failAt(-1)
  storage.writes.length = 0
  const resumed = await syncSystemFiles(prepared, storage, { now, write: true })
  assert.equal(resumed.changedKeys.length, 14)
  assert.equal(storage.writes.includes(prepared.files[0]!.key), false)
  const afterFailedDatabase = await syncSystemFiles(prepared, storage, { now, write: true })
  assert.deepEqual(afterFailedDatabase.changedKeys, [])
  assert.equal(afterFailedDatabase.changed, true)
  await assert.rejects(acknowledgeSystemFiles(storage, '0'.repeat(64), true), /manifesto mudou/)
  await acknowledgeSystemFiles(storage, resumed.state.manifest_sha256, true)
  assert.equal((await syncSystemFiles(prepared, storage, { now })).changed, false)
})

test('fast path exige fontes iguais, tamanhos íntegros, verificação recente e banco confirmado', async () => {
  const prepared = await preparedFixture()
  const storage = storageFixture()
  const initial = await syncSystemFiles(prepared, storage, { now, write: true })
  const sizes = new Map(prepared.files.map((file) => [file.key, file.size]))
  assert.equal(canReuseSystemState(initial.state, prepared.sources, sizes, now), false)
  await acknowledgeSystemFiles(storage, initial.state.manifest_sha256, true)
  const state = parseSystemState(storage.objects.get(SYSTEM_STATE_KEY)!)!
  assert.equal(canReuseSystemState(state, prepared.sources, sizes, now), true)
  assert.equal(canReuseSystemState(state, prepared.sources, sizes, now, true), false)
  assert.equal(
    canReuseSystemState(
      state,
      prepared.sources,
      sizes,
      new Date(now.getTime() + SYSTEM_VERIFY_INTERVAL_MS),
    ),
    false,
  )
  assert.equal(
    canReuseSystemState(state, { ...prepared.sources, source_commit: '0'.repeat(40) }, sizes, now),
    false,
  )
  sizes.set(prepared.files[0]!.key, 1)
  assert.equal(canReuseSystemState(state, prepared.sources, sizes, now), false)
})

test('falha ao gravar estado após os arquivos mantém a regeneração necessária no retry', async () => {
  const prepared = await preparedFixture()
  const storage = storageFixture()
  storage.failAt(17)
  await assert.rejects(syncSystemFiles(prepared, storage, { now, write: true }), /falha simulada/)
  assert.equal(storage.objects.size, 16)
  storage.failAt(-1)
  storage.writes.length = 0
  const resumed = await syncSystemFiles(prepared, storage, { now, write: true })
  assert.deepEqual(resumed.changedKeys, [])
  assert.deepEqual(storage.writes, [SYSTEM_STATE_KEY])
  assert.equal(resumed.changed, true)
})

test('commit novo sem mudança de bytes só atualiza proveniência; manifesto alterado rejeita ACK antigo', async () => {
  const prepared = await preparedFixture()
  const storage = storageFixture()
  const first = await syncSystemFiles(prepared, storage, { now, write: true })
  await acknowledgeSystemFiles(storage, first.state.manifest_sha256, true)
  const newer = structuredClone(prepared)
  newer.sources.source_commit = '0'.repeat(40)
  for (const file of newer.files)
    if (file.provenance.kind === 'github-source') {
      file.provenance.commit = newer.sources.source_commit
      file.provenance.url = file.provenance.url.replace(commit, newer.sources.source_commit)
    }
  storage.writes.length = 0
  const unchanged = await syncSystemFiles(newer, storage, { now, write: true })
  assert.equal(unchanged.changed, false)
  assert.deepEqual(storage.writes, [SYSTEM_STATE_KEY])
  const changed = await preparedFixture(async (file) =>
    file.path.endsWith('index.html')
      ? Buffer.from('<!doctype html><html><body>página nova maior</body></html>')
      : fileBytes(file.path),
  )
  await syncSystemFiles(changed, storage, { now, write: true })
  await assert.rejects(
    acknowledgeSystemFiles(storage, first.state.manifest_sha256, true),
    /manifesto mudou/,
  )
})

test('recusa allowlist, bytes e manifesto inválidos antes de qualquer escrita', async () => {
  const prepared = await preparedFixture()
  const storage = storageFixture()
  const missing = { ...prepared, files: prepared.files.slice(1) }
  await assert.rejects(syncSystemFiles(missing, storage, { now, write: true }), /estado.*inválido/)
  const body = prepared.bodies.get(prepared.files[0]!.key)!
  body[100] = 77
  await assert.rejects(syncSystemFiles(prepared, storage, { now, write: true }), /conteúdo difere/)
  assert.deepEqual(storage.writes, [])
})

test('allowlist mantém os 15 adicionais e exclui o executável dos bancos Delphi', (context) => {
  const root = mkdtempSync(join(tmpdir(), 'louvorja-system-list-'))
  context.after(() => rmSync(root, { recursive: true, force: true }))
  const exportSql = join(root, 'replica.sql')
  writeFileSync(
    exportSql,
    readFileSync('migrations/0001_schema.sql', 'utf8') +
      "\nINSERT INTO configs (key,type,value) VALUES ('version_number','number','185');" +
      "\nINSERT INTO languages (id_language, language) VALUES ('pt','Português'), ('es','Español');" +
      "\nINSERT INTO bible_version (id_bible_version,name,abbreviation,id_language) VALUES (1,'Bíblia','B','pt'),(2,'Biblia','B','es');" +
      "\nINSERT INTO bible_book (id_bible_book,book_number,name,chapters,testament,abbreviation,color,id_language) VALUES (1,1,'Gênesis',50,1,'Gn','#000000','pt'),(2,1,'Génesis',50,1,'Gn','#000000','es');" +
      "\nINSERT INTO bible_verse (id_bible_version,id_bible_book,chapter,verse,text,id_language) VALUES (1,1,1,1,'No princípio','pt'),(2,2,1,1,'En el principio','es');",
  )
  const results = exportLegacyDatabases({
    exportSql,
    outDir: join(root, 'out'),
    versionOverride: 185,
  })
  for (const result of results) {
    const db = new DatabaseSync(result.path)
    try {
      const rows = db
        .prepare('SELECT ID, URL_DOWNLOAD FROM ARQUIVOS_ADICIONAIS ORDER BY CAST(ID AS INTEGER)')
        .all()
      assert.deepEqual(
        rows.map((row) => [row.ID, row.URL_DOWNLOAD]),
        SYSTEM_FILES.filter((file) => file.path !== 'LouvorJA.exe').map((file) => [
          file.id,
          `system/${file.path}`,
        ]),
      )
      assert.equal(rows.length, 15)
      assert.equal(
        db
          .prepare(
            "SELECT count(*) total FROM ARQUIVOS_SISTEMA WHERE URL_DOWNLOAD = 'system/LouvorJA.exe'",
          )
          .get()?.total,
        0,
      )
      assert.equal(db.prepare('SELECT VERSAO_BD FROM VERSAO').get()!.VERSAO_BD, 185)
    } finally {
      db.close()
    }
  }
  assert.equal(SYSTEM_FILES.filter((file) => systemSourcePath(file).startsWith('app/')).length, 11)
})
