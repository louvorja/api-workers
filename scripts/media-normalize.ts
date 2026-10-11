/**
 * Completa os dois lados de cada arquivo de mídia novo do catálogo: guarda o
 * original no bucket dos originais e gera, em `files`, a versão que os apps
 * atuais baixam (Opus quando o MP3 passa de 128 kbps, JPEG no lugar de BMP).
 *
 * É o passo "Mídia nova" do cron que trazia os arquivos da API antiga
 * (scripts/sync-media.ts), agora lendo do nosso armazenamento. Ver
 * scripts/lib/media-plan.ts para os casos.
 *
 *   npx wrangler d1 export louvorja --remote --output=replica.sql
 *   npm run media:normalize -- --export=replica.sql            # só mostra o plano
 *   npm run media:normalize -- --export=replica.sql --write    # executa
 *
 * `--limit=N` (padrão 150) limita o trabalho de uma execução; o resto fica
 * para a próxima. Sempre grava media-normalize.sql e um relatório JSON.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { pool } from './lib/legacy.ts'
import {
  bmpToJpeg,
  isBmp,
  KEEP_SOURCE_UP_TO_KBPS,
  mp3Kbps,
  mp3ToOpus,
} from './lib/media-convert.ts'
import { type MediaRecord, type MediaWork, planMedia, withExtension } from './lib/media-plan.ts'
import * as r2 from './lib/r2.ts'

const run = promisify(execFile)
const args = new Map(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=') as [string, string]),
)
const EXPORT = args.get('export')
const WRITE = args.has('write')
const LIMIT = Number(args.get('limit') ?? 150)
const DATABASE = args.get('database') ?? 'louvorja'
const SQL_FILE = 'media-normalize.sql'
const REPORT_FILE = 'media-normalize-report.json'

const CONTENT_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  bmp: 'image/bmp',
}
const extensionOf = (key: string) => key.slice(key.lastIndexOf('.') + 1).toLowerCase()
const contentType = (key: string) => CONTENT_TYPES[extensionOf(key)] ?? 'application/octet-stream'
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`

function loadRecords(exportPath: string): MediaRecord[] {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(readFileSync(exportPath, 'utf8'))
    return db
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
}

if (!EXPORT) throw new Error('informe --export=<arquivo do wrangler d1 export>')

const records = loadRecords(EXPORT)
const files = new Set((await r2.mediaSizes()).keys())
const originals = new Set((await r2.listWithSizes('', r2.ORIGINALS_BUCKET)).keys())
const plan = planMedia(records, files, originals)
const work = LIMIT > 0 ? plan.work.slice(0, LIMIT) : plan.work

console.log(
  `${records.length} arquivos no catálogo | a completar: ${plan.work.length}` +
    (work.length < plan.work.length ? ` (${work.length} nesta execução)` : '') +
    ` | só versão convertida, sem original: ${plan.withoutOriginal.length}` +
    ` | sem arquivo nenhum: ${plan.missing.length}`,
)
for (const key of plan.missing.slice(0, 20)) console.log(`  sem arquivo: ${key}`)

type Done = { key: string; stored: string; kind: 'opus' | 'mp3' | 'jpeg' | 'raw'; bytes: number }
const done: Done[] = []
const failed: Array<{ key: string; error: string }> = []
const statements: string[] = []
const superseded: string[] = []

async function complete(item: MediaWork, workdir: string) {
  const sourceBucket = item.source === 'originals' ? r2.ORIGINALS_BUCKET : undefined
  const sourceKey = item.source === 'originals' ? item.originalKey : item.storedKey
  const body = await r2.get(sourceKey, sourceBucket)
  if (body === null || body.length === 0) throw new Error(`arquivo vazio ou ausente: ${sourceKey}`)

  if (item.copyOriginal) {
    await r2.put(item.originalKey, body, contentType(item.originalKey), r2.ORIGINALS_BUCKET)
  }

  const slash = item.originalKey.lastIndexOf('/')
  const dir = item.originalKey.slice(0, slash)
  const name = item.originalKey.slice(slash + 1)
  let fileName = name
  let stored: Uint8Array = body
  let kind: Done['kind'] = 'raw'

  if (item.type === 'music' && extensionOf(name) === 'mp3') {
    kind = 'mp3'
    if ((await mp3Kbps(body, workdir)) > KEEP_SOURCE_UP_TO_KBPS) {
      stored = (await mp3ToOpus(body, workdir)).body
      fileName = withExtension(name, 'opus')
      kind = 'opus'
    }
  } else if (isBmp(body)) {
    stored = bmpToJpeg(body)
    fileName = withExtension(name, 'jpg')
    kind = 'jpeg'
  }

  const storedKey = `${dir}/${fileName}`
  // O arquivo importado que já está em `files` com o nome final não é reenviado.
  if (!(item.source === 'files' && storedKey === item.storedKey)) {
    await r2.put(storedKey, stored, contentType(storedKey))
  }
  if (storedKey !== item.storedKey) {
    statements.push(
      `UPDATE files SET file_name = ${quote(fileName)} WHERE id_file = ${item.idFile};`,
    )
    // O original importado em `files` deu lugar à versão convertida.
    if (item.source === 'files') superseded.push(item.storedKey)
  }
  done.push({ key: item.originalKey, stored: storedKey, kind, bytes: stored.length })
  console.log(`  ${item.originalKey} → ${storedKey} (${kind})`)
}

if (!WRITE) {
  for (const item of work.slice(0, 20)) {
    console.log(`  a completar: ${item.originalKey} (a partir de ${item.source})`)
  }
  console.log('Simulação: nada foi enviado nem gravado (use --write).')
} else if (work.length > 0) {
  const workdir = mkdtempSync(join(tmpdir(), 'louvorja-media-'))
  try {
    await pool(work, 3, async (item) => {
      try {
        await complete(item, workdir)
      } catch (error) {
        failed.push({ key: item.originalKey, error: String((error as Error).message) })
        console.warn(`  FALHA ${item.originalKey}: ${(error as Error).message}`)
      }
    })
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
}

writeFileSync(SQL_FILE, statements.length > 0 ? `${statements.join('\n')}\n` : '')
if (WRITE && statements.length > 0) {
  await run('npx', [
    '--no-install',
    'wrangler',
    'd1',
    'execute',
    DATABASE,
    '--remote',
    '--yes',
    '--file',
    SQL_FILE,
  ])
  // Só depois de o banco apontar para a versão convertida.
  for (const key of superseded) await r2.del(key)
}

writeFileSync(
  REPORT_FILE,
  JSON.stringify(
    {
      written: WRITE,
      done,
      failed,
      pending: plan.work.length - done.length,
      withoutOriginal: plan.withoutOriginal,
      missing: plan.missing,
    },
    null,
    1,
  ),
)
if (WRITE) {
  console.log(
    `${done.length} completado(s), ${failed.length} falha(s), ` +
      `${plan.work.length - done.length} para a próxima execução.`,
  )
}
if (failed.length > 0) process.exitCode = 1
