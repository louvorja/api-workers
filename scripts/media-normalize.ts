/** Sincroniza mídia e backup preservando o formato recebido; não transcodifica áudio. */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { pool } from './lib/legacy.ts'
import { type MediaRecord, planMedia } from './lib/media-plan.ts'
import { assertMediaBytes, removeDuplicateAudio, syncMediaCopy } from './lib/media-sync.ts'
import * as r2 from './lib/r2.ts'

const args = new Map(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=') as [string, string]),
)
const EXPORT = args.get('export')
const WRITE = args.has('write')
const LIMIT = Number(args.get('limit') ?? 150)
const DATABASE = args.get('database') ?? 'louvorja'
const SQL_FILE = 'media-normalize.sql'
const REPORT_FILE = 'media-normalize-report.json'
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`

if (!EXPORT) throw new Error('informe --export=<arquivo do wrangler d1 export>')
if (!Number.isSafeInteger(LIMIT) || LIMIT < 0) throw new Error('--limit deve ser inteiro >= 0')

const db = new DatabaseSync(':memory:')
let records: MediaRecord[]
try {
  db.exec(readFileSync(EXPORT, 'utf8'))
  records = db
    .prepare('SELECT id_file, type, dir, name, file_name FROM files ORDER BY id_file')
    .all()
    .map((row) => ({
      idFile: Number(row.id_file),
      type: String(row.type),
      dir: String(row.dir),
      name: String(row.name),
      fileName: String(row.file_name),
    }))
} finally {
  db.close()
}

const [currentSizes, originalSizes] = await Promise.all([
  r2.mediaSizes(),
  r2.listWithSizes('', r2.ORIGINALS_BUCKET),
])
const files = new Set(currentSizes.keys())
const originals = new Set(originalSizes.keys())
const plan = planMedia(records, files, originals)
let duplicates = plan.duplicates
const work = LIMIT > 0 ? plan.work.slice(0, LIMIT) : plan.work
const done: string[] = []
const failed: Array<{ key: string; error: string }> = []
const statements: string[] = []
const removed: string[] = []
const storage = {
  get: (key: string, bucket: 'files' | 'originals') =>
    r2.get(key, bucket === 'originals' ? r2.ORIGINALS_BUCKET : undefined),
  put: (key: string, body: Uint8Array, type: string, bucket: 'files' | 'originals') =>
    r2.put(key, body, type, bucket === 'originals' ? r2.ORIGINALS_BUCKET : undefined),
  del: (key: string) => r2.del(key),
}

console.log(
  `${records.length} arquivos | ${plan.work.length} cópias | ${plan.repairs.length} nomes a reparar | ` +
    `${plan.duplicates.length} MP3 duplicados | ${plan.missing.length} ausentes`,
)

if (WRITE) {
  await pool(work, 3, async (item) => {
    try {
      await syncMediaCopy(item, storage)
      const inventory = item.target === 'files' ? files : originals
      inventory.add(item.key)
      done.push(`${item.target}/${item.key}`)
    } catch (error) {
      failed.push({ key: item.key, error: String((error as Error).message) })
    }
  })
  for (const repair of plan.repairs) {
    if (!files.has(repair.key)) continue
    const body = await r2.get(repair.key)
    assertMediaBytes(repair.key, body)
    statements.push(
      `UPDATE files SET file_name = ${quote(repair.fileName)} WHERE id_file = ${repair.idFile} ` +
        `AND file_name = ${quote(repair.previousFileName)};`,
    )
  }
}

writeFileSync(SQL_FILE, statements.length ? `${statements.join('\n')}\n` : '')
if (WRITE && statements.length) {
  execFileSync(
    'npx',
    [
      '--no-install',
      'wrangler',
      'd1',
      'execute',
      DATABASE,
      '--remote',
      '--yes',
      '--file',
      SQL_FILE,
    ],
    { stdio: 'inherit' },
  )
}

if (WRITE && failed.length === 0) {
  duplicates = planMedia(records, files, originals).duplicates
  for (const item of duplicates) {
    await removeDuplicateAudio(item, storage)
    removed.push(item.key)
  }
}

const pending = plan.work.length - done.length
writeFileSync(
  REPORT_FILE,
  JSON.stringify(
    {
      written: WRITE,
      done,
      failed,
      pending,
      removed,
      planned: plan.work,
      duplicates,
      repairs: plan.repairs,
      withoutOriginal: plan.withoutOriginal,
      missing: plan.missing,
    },
    null,
    1,
  ),
)
if (!WRITE) console.log('Simulação: nada foi enviado nem gravado (use --write).')
else if (failed.length || pending || plan.missing.length) {
  console.error('Sincronização incompleta; a publicação deve aguardar a próxima execução.')
  process.exitCode = 1
}
