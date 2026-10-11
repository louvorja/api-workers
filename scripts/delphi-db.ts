/**
 * Gera os bancos SQLite do LouvorJA Delphi a partir do D1 e os publica no
 * armazenamento dos originais, de onde o programa os baixa por HTTPS.
 *
 * Quem fazia isso era o PHP, a partir do MySQL, toda vez que o catálogo
 * mudava. Aqui o gatilho é o mesmo: a versão do catálogo (`version_number`)
 * passou da versão do último banco publicado.
 *
 *   npx wrangler d1 export louvorja --remote --output=replica.sql
 *   npm run delphi:db -- --export=replica.sql            # simula
 *   npm run delphi:db -- --export=replica.sql --write    # publica
 *   npm run delphi:db -- --export=replica.sql --force    # regera mesmo sem versão nova
 *
 * A Bíblia não está no D1: os versículos são preservados do banco anterior,
 * que por isso é baixado antes de gerar o novo.
 *
 * O `db_version` de /params não é tocado. Ele é lido pelo Delphi que atualiza
 * por FTP, e o banco do FTP não sai daqui: subir esse número faria essas
 * instalações tentarem atualizar a cada abertura. O Delphi que atualiza por
 * HTTPS compara `https_db_version`, publicado aqui só depois de o banco novo
 * estar no ar.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ORIGINALS_URL } from '../src/lib/media-urls.ts'
import { exportLegacyDatabases } from './export-legacy-sqlite.ts'
import * as r2 from './lib/r2.ts'

const args = new Map(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=') as [string, string]),
)
const EXPORT = args.get('export')
const WRITE = args.has('write')
const FORCE = args.has('force')
const LANGUAGES = ['pt', 'es'] as const
const PARAMS_KEY = 'meta/params.json'
const REPORT_FILE = 'delphi-db-report.json'
/** O PHP gravava os carimbos no horário de Brasília; o D1 guarda UTC. */
const TIMESTAMP_OFFSET_HOURS = -3
/** Visões que o Delphi consulta: não podem encolher de uma versão para a outra sem motivo. */
const GUARDED_VIEWS = ['MUSICAS', 'LISTA_MUSICAS', 'ALBUM', 'BIBLIA', 'ARQUIVOS_SISTEMA'] as const

const dbKey = (language: string) => `config/${language}_database.db`
const dbUrl = (language: string) => `${ORIGINALS_URL}/${dbKey(language)}`

function count(path: string, object: string): number {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const row = db.prepare(`SELECT count(*) AS total FROM "${object}"`).get() as { total: number }
    return Number(row.total)
  } finally {
    db.close()
  }
}

function embeddedVersion(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const row = db.prepare('SELECT VERSAO_BD AS version FROM VERSAO').get() as { version: number }
    return Number(row.version)
  } finally {
    db.close()
  }
}

/** `version_number` gravado no export do D1. */
function exportedVersion(exportPath: string): number {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(readFileSync(exportPath, 'utf8'))
    const row = db.prepare("SELECT value FROM configs WHERE key = 'version_number'").get() as
      | { value: unknown }
      | undefined
    return Number(row?.value ?? 0)
  } finally {
    db.close()
  }
}

if (!EXPORT) throw new Error('informe --export=<arquivo do wrangler d1 export>')

const paramsText = await r2.get(PARAMS_KEY)
if (paramsText === null) throw new Error(`${PARAMS_KEY} não existe no bucket`)
const params = JSON.parse(new TextDecoder().decode(paramsText)) as Record<string, unknown>
const published = Number(params.https_db_version ?? 0)

// A publicação grava a versão nova no `config` publicado antes de gravá-la no
// D1, e o export usado aqui foi tirado antes disso: a versão que vale é a maior.
const configText = await r2.get('json_db/config.json')
const catalogVersion =
  configText === null
    ? 0
    : Number(
        (JSON.parse(new TextDecoder().decode(configText)) as { version_number?: unknown })
          .version_number ?? 0,
      )

const targetVersion = Math.max(catalogVersion, exportedVersion(EXPORT))
// Sem versão nova não há o que gerar: evita baixar o banco anterior à toa.
if (targetVersion <= published && !FORCE) {
  console.log(
    `versão publicada por HTTPS: ${published}; versão do catálogo: ${targetVersion}. ` +
      'O banco publicado já está na versão do catálogo: nada a fazer.',
  )
  writeFileSync(
    REPORT_FILE,
    JSON.stringify({ version: targetVersion, published, written: false, skipped: true }, null, 1),
  )
  process.exit(0)
}

const workdir = mkdtempSync(join(tmpdir(), 'louvorja-delphi-db-'))
try {
  // 1. Banco anterior: fonte da Bíblia e referência para a conferência.
  const previousDir = join(workdir, 'anterior')
  const outDir = join(workdir, 'novo')
  mkdirSync(previousDir)
  mkdirSync(outDir)
  for (const language of LANGUAGES) {
    const body = await r2.get(dbKey(language), r2.ORIGINALS_BUCKET)
    if (body === null) {
      throw new Error(
        `${dbKey(language)} não existe em ${r2.ORIGINALS_BUCKET}: sem o banco anterior não há ` +
          'de onde preservar a Bíblia',
      )
    }
    writeFileSync(join(previousDir, `${language}_database.db`), body)
  }

  // 2. O Delphi baixa os originais e confere o tamanho deles.
  const originals = await r2.listWithSizes('', r2.ORIGINALS_BUCKET)

  // 3. Gera.
  const results = exportLegacyDatabases({
    exportSql: EXPORT,
    outDir,
    bibleSource: previousDir,
    audio: 'legacy',
    originalFiles: originals,
    timestampOffsetHours: TIMESTAMP_OFFSET_HOURS,
    versionOverride: targetVersion,
  })
  const version = results[0]?.version ?? 0
  const missingOriginals = results[0]?.missingOriginals ?? []

  // 4. Confere antes de pôr no ar.
  const report = results.map((result) => {
    const previous = join(previousDir, `${result.language}_database.db`)
    if (embeddedVersion(result.path) !== version) {
      throw new Error(`banco ${result.language} saiu com a versão errada`)
    }
    const views = Object.fromEntries(
      GUARDED_VIEWS.map((view) => {
        const before = count(previous, view)
        const after = count(result.path, view)
        if (after === 0 || after < before * 0.9) {
          throw new Error(
            `banco ${result.language}: ${view} caiu de ${before} para ${after} linhas; ` +
              'publicação do banco do Delphi cancelada',
          )
        }
        return [view, { before, after }]
      }),
    )
    const body = readFileSync(result.path)
    return {
      language: result.language,
      version,
      bytes: statSync(result.path).size,
      sha256: createHash('sha256').update(body).digest('hex'),
      bible_verses: result.bibleVerses,
      views,
      url: dbUrl(result.language),
    }
  })

  for (const item of report) {
    const megabytes = (item.bytes / 1e6).toFixed(1)
    console.log(`${item.language}: versão ${item.version}, ${megabytes} MB, ${item.url}`)
  }
  console.log(
    `versão publicada por HTTPS: ${published || 'nenhuma'}; versão do catálogo: ${version}`,
  )
  if (missingOriginals.length > 0) {
    console.log(
      `ATENÇÃO: ${missingOriginals.length} arquivo(s) do catálogo sem original em ` +
        `${r2.ORIGINALS_BUCKET}; o Delphi não vai conseguir baixá-los:`,
    )
    for (const key of missingOriginals.slice(0, 20)) console.log(`  ${key}`)
  }
  writeFileSync(
    REPORT_FILE,
    JSON.stringify(
      { version, published, written: false, missingOriginals, databases: report },
      null,
      1,
    ),
  )

  if (!WRITE) {
    console.log('Simulação: nada foi enviado (use --write).')
  } else {
    for (const result of results) {
      await r2.put(
        dbKey(result.language),
        readFileSync(result.path),
        'application/vnd.sqlite3',
        r2.ORIGINALS_BUCKET,
      )
    }
    // A versão só é anunciada depois de os dois bancos estarem no ar.
    const fresh = JSON.parse(
      new TextDecoder().decode((await r2.get(PARAMS_KEY)) ?? paramsText),
    ) as Record<string, unknown>
    await r2.put(
      PARAMS_KEY,
      JSON.stringify({
        ...fresh,
        https_files: ORIGINALS_URL,
        https_db_pt: dbUrl('pt'),
        https_db_es: dbUrl('es'),
        https_db_version: version,
      }),
      'application/json',
    )
    writeFileSync(
      REPORT_FILE,
      JSON.stringify(
        { version, published, written: true, missingOriginals, databases: report },
        null,
        1,
      ),
    )
    console.log(`Publicado: bancos na versão ${version} e https_db_version atualizado.`)
  }
} finally {
  rmSync(workdir, { recursive: true, force: true })
}
