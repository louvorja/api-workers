/**
 * Publica o catálogo a partir do banco: o que o painel alterou no D1 vira os
 * JSON de /json_db, o manifesto, o pacote ZIP e a camada REST que os apps leem.
 *
 * Substitui o trio gate + ingest + ingest-rest, que copiava isso da API de
 * origem. Sem `--write` só mostra o que mudaria.
 *
 *   npx wrangler d1 export louvorja --remote --output=replica.sql
 *   node --env-file=.env --experimental-strip-types scripts/publish.ts --export=replica.sql [--write]
 *
 * Os capítulos da Bíblia e rest/metadata.json não passam por aqui: são
 * estáticos e ficam como estão no bucket.
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { generateCatalog } from './lib/catalog.ts'
import { localD1 } from './lib/d1-local.ts'
import { pool } from './lib/legacy.ts'
import {
  type Config,
  type ManifestEntry,
  nextConfig,
  type Plan,
  planJsonDb,
  planRest,
} from './lib/publication.ts'
import * as r2 from './lib/r2.ts'
import { generateRest } from './lib/rest.ts'

const args = new Map(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=') as [string, string]),
)
const EXPORT = args.get('export')
const WRITE = args.has('write')
const API = args.get('api') ?? 'https://api.louvorja.workers.dev'
const DATABASE = args.get('database') ?? 'louvorja'
const STATE_KEY = 'state/publish.json'
/** As chaves de `configs` que uma publicação reescreve, com o tipo de cada uma. */
const VERSION_KEYS: Record<string, string> = {
  version_number: 'number',
  version: 'number',
  latest_updated: 'datetime',
  date: 'date',
  time: 'time',
  datetime: 'datetime',
}
if (!EXPORT) throw new Error('informe --export=<arquivo do wrangler d1 export>')

const decoder = new TextDecoder()
const text = async (key: string) => {
  const body = await r2.get(key)
  return body === null ? null : decoder.decode(body)
}

// A réplica fica em memória: a nova versão é gravada nela antes de gerar, e o
// arquivo exportado não é tocado.
const db = new DatabaseSync(':memory:')
db.exec(readFileSync(EXPORT, 'utf8'))

const catalog = () => new Map(generateCatalog(db))
async function rest() {
  const out = new Map<string, string>()
  for await (const [key, json] of generateRest(localD1(db), API)) out.set(key, json)
  return out
}

console.log('Lendo o que está publicado...')
const manifest = JSON.parse((await text('meta/manifest.json')) ?? '[]') as ManifestEntry[]
const state = JSON.parse((await text(STATE_KEY)) ?? '{}') as Record<string, string>
const firstRun = Object.keys(state).length === 0

const workdir = mkdtempSync(join(tmpdir(), 'louvorja-publish-'))
const bundleDir = join(workdir, 'json')
mkdirSync(bundleDir)
const bundle = await r2.get('meta/bundle.zip')
if (bundle !== null) {
  writeFileSync(join(workdir, 'bundle.zip'), bundle)
  execFileSync('unzip', ['-qq', '-o', join(workdir, 'bundle.zip'), '-d', bundleDir])
}
const published = (table: string) => {
  const path = join(bundleDir, `${table}.json`)
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

// A versão só sobe quando algo além dela mesma mudou; `config` carrega a versão,
// então fica de fora da pergunta.
const draft = planJsonDb(catalog(), published, manifest)
const contentChanged =
  draft.added.length > 0 ||
  draft.removed.length > 0 ||
  draft.changed.some((table) => table !== 'config')

let config: Config | null = null
if (contentChanged) {
  const current: Config = {}
  for (const row of db.prepare('SELECT key, type, value FROM configs').all()) {
    current[String(row.key)] = row.type === 'number' ? Number(row.value) : String(row.value)
  }
  // Mesma regra da origem: a data da alteração mais recente no catálogo.
  const latest = db
    .prepare(
      'SELECT max(updated_at) AS latest FROM (' +
        ['files', 'albums', 'categories', 'musics', 'lyrics', 'albums_musics', 'categories_albums']
          .map((table) => `SELECT max(updated_at) AS updated_at FROM ${table}`)
          .join(' UNION ALL ') +
        ')',
    )
    .get()?.latest
  config = nextConfig(current, String(latest ?? current.latest_updated), new Date())

  const upsert = db.prepare(
    'INSERT INTO configs (key, type, value) VALUES (?, ?, ?) ' +
      'ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  )
  for (const [key, kind] of Object.entries(VERSION_KEYS)) {
    upsert.run(key, kind, String(config[key]))
  }
}

const jsonDb = contentChanged ? planJsonDb(catalog(), published, manifest) : draft
const restPlan = planRest(await rest(), state)

const sample = (list: string[]) =>
  list.length === 0 ? '' : ` — ${list.slice(0, 6).join(', ')}${list.length > 6 ? '…' : ''}`
function describe(title: string, plan: Plan) {
  console.log(`\n${title}`)
  console.log(`  alterados: ${plan.changed.length}${sample(plan.changed)}`)
  console.log(`  novos:     ${plan.added.length}${sample(plan.added)}`)
  console.log(`  removidos: ${plan.removed.length}${sample(plan.removed)}`)
}
describe('/json_db', jsonDb)
describe(
  firstRun ? 'camada REST (primeira publicação: tudo é enviado uma vez)' : 'camada REST',
  restPlan,
)
if (config) {
  console.log(
    `\nNova versão do catálogo: ${config.version_number} (${config.datetime}, horário de Brasília)`,
  )
} else {
  console.log('\nCatálogo sem alteração: a versão não muda.')
}

const nothing =
  jsonDb.puts.length === 0 &&
  jsonDb.deletes.length === 0 &&
  restPlan.puts.length === 0 &&
  restPlan.deletes.length === 0

if (!WRITE || nothing) {
  console.log(
    nothing ? '\nNada a publicar.' : '\nSimulação: nada foi gravado. Use --write para publicar.',
  )
  rmSync(workdir, { recursive: true, force: true })
  process.exit(0)
}

console.log('\nPublicando...')
const upload = (key: string, body: string | Uint8Array, type = 'application/json') =>
  r2.put(key, body, type)

await pool([...jsonDb.puts, ...restPlan.puts], 8, (put) => upload(put.key, put.body))
await pool([...jsonDb.deletes, ...restPlan.deletes], 8, (key) => r2.del(key))

if (jsonDb.puts.length > 0 || jsonDb.deletes.length > 0) {
  // O pacote sai do mesmo diretório que serviu de comparação, já com as trocas.
  for (const put of jsonDb.puts) writeFileSync(join(workdir, 'json', put.key.slice(8)), put.body)
  for (const key of jsonDb.deletes) {
    const path = join(workdir, 'json', key.slice(8))
    if (existsSync(path)) unlinkSync(path)
  }
  const zipPath = join(workdir, 'bundle-new.zip')
  execFileSync('zip', ['-qq', '-r', '-X', zipPath, '.'], { cwd: bundleDir })
  await upload('meta/bundle.zip', readFileSync(zipPath), 'application/zip')
  await upload('meta/manifest.json', JSON.stringify(jsonDb.manifest))
}

if (config) {
  // `db_version` é o que o app compara para saber se há catálogo novo.
  const params = JSON.parse((await text('meta/params.json')) ?? '{}') as Record<string, unknown>
  await upload('meta/params.json', JSON.stringify({ ...params, db_version: config.version_number }))

  // Por último: só depois de tudo no bucket a nova versão vira verdade no banco.
  const quote = (value: string | number) => `'${String(value).replace(/'/g, "''")}'`
  const sql = Object.entries(VERSION_KEYS)
    .map(
      ([key, kind]) =>
        `INSERT INTO configs (key, type, value) VALUES (${quote(key)}, ${quote(kind)}, ` +
        `${quote(config[key] as string | number)}) ` +
        'ON CONFLICT (key) DO UPDATE SET value = excluded.value;',
    )
    .join(' ')
  execFileSync('npx', ['wrangler', 'd1', 'execute', DATABASE, '--remote', '--command', sql], {
    stdio: 'inherit',
  })
}

await upload(STATE_KEY, JSON.stringify(restPlan.state))
rmSync(workdir, { recursive: true, force: true })

console.log(
  `\n${jsonDb.puts.length + restPlan.puts.length} objetos enviados, ` +
    `${jsonDb.deletes.length + restPlan.deletes.length} removidos.`,
)
