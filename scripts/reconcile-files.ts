/**
 * Reconcilia `files.size` e `files.duration` com os objetos que existem no R2.
 * A execução é uma simulação por padrão: sempre grava o SQL e um relatório
 * JSON, mas só altera o D1 remoto quando `--write` é informado.
 *
 *   npm run files:reconcile -- --export=replica.sql --task=all
 *   npm run files:reconcile -- --export=replica.sql --task=duration --write
 *
 * A duração depende de `ffprobe` no PATH. Objetos ausentes nunca viram tamanho
 * zero; ficam registrados como ausentes e fazem o processo terminar com erro.
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import * as r2 from './lib/r2.ts'

const execFileAsync = promisify(execFile)

export type ReconcileTask = 'size' | 'duration' | 'all'
export type UpdateField = 'size' | 'duration'
export type IssueStage = 'input' | 'list' | 'download' | 'ffprobe' | 'write'

export interface FileRow {
  idFile: number
  type: string
  size: number
  dir: string
  fileName: string
  duration: string | null
}

export interface FileUpdate {
  idFile: number
  key: string
  dir: string
  fileName: string
  field: UpdateField
  before: number | string | null
  after: number | string
}

export interface ReconcileIssue {
  task: 'size' | 'duration' | 'write' | 'input'
  stage: IssueStage
  reason: string
  idFile?: number
  key?: string
  prefix?: string
  batch?: number
}

export interface TaskStats {
  inspected: number
  eligible: number
  checked: number
  unchanged: number
  updates: number
  missing: number
  failures: number
}

export interface ReconcileResult {
  size: TaskStats | null
  duration: TaskStats | null
  updates: FileUpdate[]
  missing: ReconcileIssue[]
  failures: ReconcileIssue[]
}

export interface SqlBatch {
  number: number
  updates: number
  sql: string
}

export interface ReconcileDependencies {
  listWithSizes(prefix?: string): Promise<Map<string, number>>
  get(key: string): Promise<Uint8Array | null>
  prepareDuration?(): Promise<void>
  probeDuration(body: Uint8Array, key: string): Promise<number>
}

export interface ReconcileOptions {
  task: ReconcileTask
  force?: boolean
  concurrency?: number
}

export interface ReconcileReport {
  schemaVersion: 1
  generatedAt: string
  mode: 'dry-run' | 'write'
  task: ReconcileTask
  force: boolean
  export: string
  database: string
  result: ReconcileResult
  sql: {
    path: string
    batchSize: number
    batches: number
    statements: number
  }
  write: {
    requested: boolean
    submittedBatches: number
  }
  status: 'ok' | 'issues'
}

interface CliOptions {
  exportPath: string
  task: ReconcileTask
  force: boolean
  write: boolean
  database: string
  sqlPath: string
  reportPath: string
  batchSize: number
  concurrency: number
}

const REQUIRED_COLUMNS = ['id_file', 'type', 'size', 'dir', 'file_name', 'duration', 'updated_at']

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function positiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} deve ser um inteiro positivo`)
  }
  return parsed
}

function parseTask(value: string | undefined): ReconcileTask {
  const task = value ?? 'all'
  if (task !== 'size' && task !== 'duration' && task !== 'all') {
    throw new Error(`task inválida: ${task}; use size, duration ou all`)
  }
  return task
}

function parseArgs(argv: readonly string[]): CliOptions | null {
  const values = new Map<string, string>()
  const flags = new Set<string>()
  const allowedValues = new Set([
    'export',
    'task',
    'database',
    'sql',
    'report',
    'batch-size',
    'concurrency',
  ])
  const allowedFlags = new Set(['write', 'force', 'help'])

  for (const argument of argv) {
    if (!argument.startsWith('--')) throw new Error(`argumento inválido: ${argument}`)
    const body = argument.slice(2)
    const separator = body.indexOf('=')
    const name = separator === -1 ? body : body.slice(0, separator)
    const value = separator === -1 ? undefined : body.slice(separator + 1)
    if (allowedFlags.has(name)) {
      if (value !== undefined) throw new Error(`--${name} não recebe valor`)
      if (flags.has(name)) throw new Error(`--${name} foi informado mais de uma vez`)
      flags.add(name)
      continue
    }
    if (!allowedValues.has(name) || value === undefined || value === '') {
      throw new Error(`opção inválida: ${argument}`)
    }
    if (values.has(name)) throw new Error(`--${name} foi informado mais de uma vez`)
    values.set(name, value)
  }

  if (flags.has('help')) return null
  const exportPath = values.get('export')
  if (!exportPath) throw new Error('informe --export=<replica.sql>')
  return {
    exportPath: resolve(exportPath),
    task: parseTask(values.get('task')),
    force: flags.has('force'),
    write: flags.has('write'),
    database: values.get('database') ?? 'louvorja',
    sqlPath: resolve(values.get('sql') ?? 'reconcile-files.sql'),
    reportPath: resolve(values.get('report') ?? 'reconcile-files-report.json'),
    batchSize: positiveInteger(values.get('batch-size'), 'batch-size', 100),
    concurrency: positiveInteger(values.get('concurrency'), 'concurrency', 4),
  }
}

function printHelp() {
  console.log(`Uso:
  npm run files:reconcile -- --export=replica.sql [opções]

Opções:
  --task=size|duration|all  Rotina a executar (padrão: all)
  --force                   Reanalisa a duração de todos os arquivos music
  --write                   Executa os lotes no D1 remoto; sem isso é dry-run
  --database=nome           Banco do Wrangler (padrão: louvorja)
  --sql=caminho             SQL gerado (padrão: reconcile-files.sql)
  --report=caminho          Relatório JSON (padrão: reconcile-files-report.json)
  --batch-size=100          Máximo de UPDATEs por chamada ao Wrangler
  --concurrency=4           Downloads/ffprobe simultâneos
  --help                    Mostra esta ajuda

Ambiente R2: R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID e R2_SECRET_ACCESS_KEY.
A tarefa duration requer ffprobe no PATH.`)
}

/** Converte o par legado `dir`/`file_name` em uma chave relativa segura do R2. */
export function resolveObjectKey(row: Pick<FileRow, 'dir' | 'fileName'>): string {
  const invalid = /[\0-\x1f\x7f\\]/
  if (invalid.test(row.dir)) throw new Error('dir contém caractere ou separador inválido')
  if (invalid.test(row.fileName)) {
    throw new Error('file_name contém caractere ou separador inválido')
  }

  const directory = row.dir.replace(/^\/+|\/+$/g, '')
  const fileName = row.fileName.replace(/^\/+|\/+$/g, '')
  if (!directory) throw new Error('dir vazio')
  if (!fileName) throw new Error('file_name vazio')
  if (fileName.includes('/')) throw new Error('file_name deve conter somente o nome do objeto')

  const segments = [...directory.split('/'), fileName]
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('dir/file_name contém segmento inseguro')
  }
  return segments.join('/')
}

/** Mantém a semântica do PHP/getID3: descarta a fração de segundo. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error('duração inválida')
  const whole = Math.floor(seconds)
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const remainder = whole % 60
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, '0')).join(':')
}

export function parseFfprobeDuration(stdout: string): number {
  const value = Number(stdout.trim())
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`ffprobe devolveu duração inválida: ${JSON.stringify(stdout.trim())}`)
  }
  return value
}

function emptyStats(inspected: number, eligible: number): TaskStats {
  return { inspected, eligible, checked: 0, unchanged: 0, updates: 0, missing: 0, failures: 0 }
}

function keyFailure(task: 'size' | 'duration', row: FileRow, error: unknown): ReconcileIssue {
  return {
    task,
    stage: 'input',
    idFile: row.idFile,
    reason: `dir/file_name inválido: ${errorMessage(error)}`,
  }
}

function validateRow(row: FileRow): string | null {
  if (!Number.isSafeInteger(row.idFile) || row.idFile < 1)
    return 'id_file deve ser inteiro positivo'
  if (!Number.isSafeInteger(row.size)) return 'size deve ser inteiro'
  if (typeof row.type !== 'string') return 'type deve ser texto'
  if (typeof row.dir !== 'string') return 'dir deve ser texto'
  if (typeof row.fileName !== 'string') return 'file_name deve ser texto'
  if (row.duration !== null && typeof row.duration !== 'string') {
    return 'duration deve ser texto ou null'
  }
  return null
}

function prefixFor(key: string): string {
  const separator = key.indexOf('/')
  return separator === -1 ? '' : `${key.slice(0, separator)}/`
}

async function concurrent<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      await work(items[index] as T)
    }
  })
  await Promise.all(runners)
}

function sortedIssues(issues: ReconcileIssue[]): ReconcileIssue[] {
  return issues.sort(
    (a, b) =>
      a.task.localeCompare(b.task) ||
      (a.idFile ?? 0) - (b.idFile ?? 0) ||
      (a.key ?? a.prefix ?? '').localeCompare(b.key ?? b.prefix ?? ''),
  )
}

/**
 * Núcleo injetável da reconciliação. Rede e ffprobe entram por dependências;
 * seleção, comparação e plano de atualização ficam determinísticos.
 */
export async function reconcileRows(
  rows: readonly FileRow[],
  options: ReconcileOptions,
  dependencies: ReconcileDependencies,
): Promise<ReconcileResult> {
  const task = parseTask(options.task)
  const concurrency = options.concurrency ?? 4
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error('concurrency deve ser um inteiro positivo')
  }

  const updates: FileUpdate[] = []
  const missing: ReconcileIssue[] = []
  const failures: ReconcileIssue[] = []
  const validationFailures = new Map<number, string>()
  for (const row of rows) {
    const failure = validateRow(row)
    if (failure) validationFailures.set(row.idFile, failure)
  }

  let size: TaskStats | null = null
  if (task === 'size' || task === 'all') {
    size = emptyStats(rows.length, rows.length)
    const keyed: Array<{ row: FileRow; key: string; prefix: string }> = []
    for (const row of rows) {
      const validationFailure = validationFailures.get(row.idFile)
      if (validationFailure) {
        failures.push({
          task: 'size',
          stage: 'input',
          idFile: row.idFile,
          reason: validationFailure,
        })
        size.failures++
        continue
      }
      try {
        const key = resolveObjectKey(row)
        keyed.push({ row, key, prefix: prefixFor(key) })
      } catch (error) {
        failures.push(keyFailure('size', row, error))
        size.failures++
      }
    }

    const requestedPrefixes = new Set(keyed.map((item) => item.prefix))
    const prefixes = requestedPrefixes.has('') ? [''] : [...requestedPrefixes].sort()
    const listed = new Map<string, number>()
    const failedPrefixes = new Set<string>()
    await Promise.all(
      prefixes.map(async (prefix) => {
        try {
          for (const [key, bytes] of await dependencies.listWithSizes(prefix))
            listed.set(key, bytes)
        } catch (error) {
          failedPrefixes.add(prefix)
          failures.push({
            task: 'size',
            stage: 'list',
            prefix,
            reason: `não foi possível listar o prefixo ${JSON.stringify(prefix)}: ${errorMessage(error)}`,
          })
          size!.failures++
        }
      }),
    )

    for (const { row, key, prefix } of keyed) {
      if (failedPrefixes.has(prefix)) continue
      if (!listed.has(key)) {
        missing.push({
          task: 'size',
          stage: 'list',
          idFile: row.idFile,
          key,
          reason: 'objeto ausente no R2; o tamanho não foi alterado',
        })
        size.missing++
        continue
      }
      const bytes = listed.get(key) as number
      if (!Number.isSafeInteger(bytes) || bytes < 0) {
        failures.push({
          task: 'size',
          stage: 'list',
          idFile: row.idFile,
          key,
          reason: `tamanho inválido devolvido pelo R2: ${String(bytes)}`,
        })
        size.failures++
        continue
      }
      size.checked++
      if (row.size === bytes) {
        size.unchanged++
        continue
      }
      updates.push({
        idFile: row.idFile,
        key,
        dir: row.dir,
        fileName: row.fileName,
        field: 'size',
        before: row.size,
        after: bytes,
      })
      size.updates++
    }
  }

  let duration: TaskStats | null = null
  if (task === 'duration' || task === 'all') {
    const musicRows = rows.filter((row) => row.type === 'music')
    const candidates = musicRows.filter(
      (row) => options.force || row.duration === null || row.duration.trim() === '',
    )
    duration = emptyStats(musicRows.length, candidates.length)

    let prepared = true
    if (candidates.length > 0 && dependencies.prepareDuration) {
      try {
        await dependencies.prepareDuration()
      } catch (error) {
        prepared = false
        failures.push({
          task: 'duration',
          stage: 'ffprobe',
          reason: `ffprobe indisponível: ${errorMessage(error)}`,
        })
        duration.failures++
      }
    }

    if (prepared) {
      await concurrent(candidates, concurrency, async (row) => {
        const validationFailure = validationFailures.get(row.idFile)
        if (validationFailure) {
          failures.push({
            task: 'duration',
            stage: 'input',
            idFile: row.idFile,
            reason: validationFailure,
          })
          duration!.failures++
          return
        }

        let key: string
        try {
          key = resolveObjectKey(row)
        } catch (error) {
          failures.push(keyFailure('duration', row, error))
          duration!.failures++
          return
        }

        let body: Uint8Array | null
        try {
          body = await dependencies.get(key)
        } catch (error) {
          failures.push({
            task: 'duration',
            stage: 'download',
            idFile: row.idFile,
            key,
            reason: `download falhou: ${errorMessage(error)}`,
          })
          duration!.failures++
          return
        }
        if (body === null) {
          missing.push({
            task: 'duration',
            stage: 'download',
            idFile: row.idFile,
            key,
            reason: 'objeto ausente no R2; a duração não foi alterada',
          })
          duration!.missing++
          return
        }

        try {
          const formatted = formatDuration(await dependencies.probeDuration(body, key))
          duration!.checked++
          if (row.duration === formatted) {
            duration!.unchanged++
            return
          }
          updates.push({
            idFile: row.idFile,
            key,
            dir: row.dir,
            fileName: row.fileName,
            field: 'duration',
            before: row.duration,
            after: formatted,
          })
          duration!.updates++
        } catch (error) {
          failures.push({
            task: 'duration',
            stage: 'ffprobe',
            idFile: row.idFile,
            key,
            reason: `ffprobe falhou: ${errorMessage(error)}`,
          })
          duration!.failures++
        }
      })
    }
  }

  updates.sort((a, b) => a.idFile - b.idFile || a.field.localeCompare(b.field))
  return {
    size,
    duration,
    updates,
    missing: sortedIssues(missing),
    failures: sortedIssues(failures),
  }
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

/** UPDATE idempotente e protegido pelos valores vistos no export. */
export function renderUpdateSql(update: FileUpdate): string {
  if (!Number.isSafeInteger(update.idFile) || update.idFile < 1) {
    throw new Error('UPDATE com id_file inválido')
  }
  const identity =
    `"id_file" = ${update.idFile} AND "dir" = ${sqlString(update.dir)} ` +
    `AND "file_name" = ${sqlString(update.fileName)}`
  if (update.field === 'size') {
    if (
      typeof update.before !== 'number' ||
      !Number.isSafeInteger(update.before) ||
      typeof update.after !== 'number' ||
      !Number.isSafeInteger(update.after) ||
      update.after < 0
    ) {
      throw new Error(`UPDATE de size inválido para files ${update.idFile}`)
    }
    return (
      `UPDATE "files" SET "size" = ${update.after}, "updated_at" = CURRENT_TIMESTAMP ` +
      `WHERE ${identity} AND "size" = ${update.before};`
    )
  }
  if (typeof update.after !== 'string' || !/^\d{2,}:\d{2}:\d{2}$/.test(update.after)) {
    throw new Error(`UPDATE de duration inválido para files ${update.idFile}`)
  }
  const previous =
    update.before === null
      ? '"duration" IS NULL'
      : `"duration" = ${sqlString(String(update.before))}`
  return (
    `UPDATE "files" SET "duration" = ${sqlString(String(update.after))}, ` +
    `"updated_at" = CURRENT_TIMESTAMP WHERE ${identity} AND ${previous};`
  )
}

export function buildSqlBatches(updates: readonly FileUpdate[], batchSize = 100): SqlBatch[] {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error('batchSize deve ser um inteiro positivo')
  }
  const batches: SqlBatch[] = []
  for (let offset = 0; offset < updates.length; offset += batchSize) {
    const slice = updates.slice(offset, offset + batchSize)
    batches.push({
      number: batches.length + 1,
      updates: slice.length,
      sql: `${slice.map(renderUpdateSql).join('\n')}\n`,
    })
  }
  return batches
}

export function renderSqlFile(batches: readonly SqlBatch[]): string {
  if (batches.length === 0) return '-- Nenhuma atualização necessária.\n'
  return batches
    .map(
      (batch) =>
        `-- Lote ${batch.number}/${batches.length}: ${batch.updates} atualização(ões)\n${batch.sql}`,
    )
    .join('\n')
}

/** Carrega somente a tabela `files`; o arquivo exportado nunca é modificado. */
export function loadFilesFromExport(exportPath: string): FileRow[] {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(readFileSync(exportPath, 'utf8'))
    const table = db
      .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'files'")
      .get()
    if (!table) throw new Error('export D1 sem a tabela files')
    const columns = new Set(
      db
        .prepare('PRAGMA table_info("files")')
        .all()
        .map((row) => String(row.name)),
    )
    const missing = REQUIRED_COLUMNS.filter((column) => !columns.has(column))
    if (missing.length > 0)
      throw new Error(`tabela files sem colunas obrigatórias: ${missing.join(', ')}`)

    const ids = new Set<number>()
    return db
      .prepare('SELECT id_file, type, size, dir, file_name, duration FROM files ORDER BY id_file')
      .all()
      .map((raw) => {
        const idFile = Number(raw.id_file)
        if (!Number.isSafeInteger(idFile) || idFile < 1) {
          throw new Error(`files.id_file inválido: ${String(raw.id_file)}`)
        }
        if (ids.has(idFile)) throw new Error(`files.id_file duplicado: ${idFile}`)
        ids.add(idFile)
        if (typeof raw.type !== 'string') throw new Error(`files ${idFile}: type inválido`)
        if (!Number.isSafeInteger(raw.size)) throw new Error(`files ${idFile}: size inválido`)
        if (typeof raw.dir !== 'string') throw new Error(`files ${idFile}: dir inválido`)
        if (typeof raw.file_name !== 'string')
          throw new Error(`files ${idFile}: file_name inválido`)
        if (raw.duration !== null && typeof raw.duration !== 'string') {
          throw new Error(`files ${idFile}: duration inválida`)
        }
        return {
          idFile,
          type: raw.type,
          size: Number(raw.size),
          dir: raw.dir,
          fileName: raw.file_name,
          duration: raw.duration,
        }
      })
  } finally {
    db.close()
  }
}

async function runCommand(command: string, args: readonly string[]) {
  const result = await execFileAsync(command, [...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  return { stdout: String(result.stdout), stderr: String(result.stderr) }
}

async function ensureFfprobe() {
  await runCommand('ffprobe', ['-version'])
}

async function probeTemporaryFile(body: Uint8Array, key: string, workdir: string): Promise<number> {
  const candidateExtension = extname(key)
  const extension = /^\.[a-zA-Z0-9]{1,8}$/.test(candidateExtension) ? candidateExtension : '.media'
  const path = join(workdir, `${randomUUID()}${extension}`)
  try {
    writeFileSync(path, body)
    const { stdout } = await runCommand('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      path,
    ])
    return parseFfprobeDuration(stdout)
  } finally {
    rmSync(path, { force: true })
  }
}

async function submitBatches(
  batches: readonly SqlBatch[],
  database: string,
  failures: ReconcileIssue[],
): Promise<number> {
  if (batches.length === 0) return 0
  const directory = mkdtempSync(join(tmpdir(), 'louvorja-reconcile-d1-'))
  let submitted = 0
  try {
    for (const batch of batches) {
      const path = join(directory, `batch-${String(batch.number).padStart(4, '0')}.sql`)
      writeFileSync(path, batch.sql)
      try {
        await runCommand('npx', [
          '--no-install',
          'wrangler',
          'd1',
          'execute',
          database,
          '--remote',
          '--yes',
          '--file',
          path,
        ])
        submitted++
      } catch (error) {
        failures.push({
          task: 'write',
          stage: 'write',
          batch: batch.number,
          reason: `lote ${batch.number} falhou: ${errorMessage(error)}`,
        })
        break
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
  return submitted
}

function emptyResult(issue?: ReconcileIssue): ReconcileResult {
  return { size: null, duration: null, updates: [], missing: [], failures: issue ? [issue] : [] }
}

export function hasReconcileIssues(result: Pick<ReconcileResult, 'missing' | 'failures'>): boolean {
  return result.missing.length > 0 || result.failures.length > 0
}

function writeReport(path: string, report: ReconcileReport) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`)
}

async function cli() {
  const options = parseArgs(process.argv.slice(2))
  if (options === null) {
    printHelp()
    return
  }

  let result = emptyResult()
  let batches: SqlBatch[] = []
  let submittedBatches = 0
  const workdir = mkdtempSync(join(tmpdir(), 'louvorja-reconcile-media-'))
  try {
    const rows = loadFilesFromExport(options.exportPath)
    result = await reconcileRows(
      rows,
      { task: options.task, force: options.force, concurrency: options.concurrency },
      {
        listWithSizes: r2.listWithSizes,
        get: r2.get,
        prepareDuration: ensureFfprobe,
        probeDuration: (body, key) => probeTemporaryFile(body, key, workdir),
      },
    )
    batches = buildSqlBatches(result.updates, options.batchSize)
    mkdirSync(dirname(options.sqlPath), { recursive: true })
    writeFileSync(options.sqlPath, renderSqlFile(batches))
    if (options.write) {
      submittedBatches = await submitBatches(batches, options.database, result.failures)
    }
  } catch (error) {
    result.failures.push({
      task: 'input',
      stage: 'input',
      reason: errorMessage(error),
    })
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }

  result.failures = sortedIssues(result.failures)
  const status = hasReconcileIssues(result) ? 'issues' : 'ok'
  const report: ReconcileReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: options.write ? 'write' : 'dry-run',
    task: options.task,
    force: options.force,
    export: options.exportPath,
    database: options.database,
    result,
    sql: {
      path: options.sqlPath,
      batchSize: options.batchSize,
      batches: batches.length,
      statements: result.updates.length,
    },
    write: { requested: options.write, submittedBatches },
    status,
  }
  writeReport(options.reportPath, report)

  console.log(
    `${options.write ? 'Escrita' : 'Simulação'}: ${result.updates.length} UPDATE(s) em ` +
      `${batches.length} lote(s).`,
  )
  console.log(`SQL: ${options.sqlPath}`)
  console.log(`Relatório: ${options.reportPath}`)
  if (status === 'issues') {
    console.error(
      `Concluído com ${result.missing.length} ausente(s) e ${result.failures.length} falha(s).`,
    )
    process.exitCode = 1
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) {
  cli().catch((error) => {
    console.error(errorMessage(error))
    process.exitCode = 1
  })
}
