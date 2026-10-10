/**
 * Compara o que o banco geraria com o que está publicado, sem gravar nada.
 *
 * É a prova de fidelidade da migração: cada tabela de /json_db e cada objeto da
 * camada REST é gerado a partir da réplica e confrontado byte a byte com o que
 * está no bucket. O que não bate é classificado pelo motivo; se sobrar alguma
 * diferença sem explicação, o script sai com erro.
 *
 *   node --experimental-strip-types scripts/catalog-diff.ts --db=<réplica SQLite do D1> \
 *     [--json-db=<dir com os .json de meta/bundle.zip>] [--rest=<dir com os .json de rest/>] \
 *     [--bible] [--api=https://api.louvorja.workers.dev]
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { generateBible, generateCatalog } from './lib/catalog.ts'
import { localD1 } from './lib/d1-local.ts'
import { generateRest } from './lib/rest.ts'

const args = new Map(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=') as [string, string]),
)
const DB = args.get('db')
const JSON_DB = args.get('json-db')
const REST = args.get('rest')
const API = args.get('api') ?? 'https://api.louvorja.workers.dev'
if (!DB || (!JSON_DB && !REST)) {
  throw new Error('informe --db=<sqlite> e ao menos um de --json-db=<dir> ou --rest=<dir>')
}

const db = new DatabaseSync(DB, { readOnly: true })

type Json = unknown
type Rows = Array<Record<string, Json>>

/** Diferenças que não são divergência de conteúdo, e por quê. */
const REASONS = {
  busca: 'texto de busca completo, sem o corte de 1.024 bytes',
  empate: 'mesmas linhas; onde a origem empata, a ordem passa a ser pelo id',
  url: 'o publicado aponta a extensão errada; o gerado aponta o arquivo que existe',
  tamanho: 'tamanho do arquivo corrigido para o do acervo',
  config: 'só as chaves de configuração que continuam existindo',
} as const
type Reason = keyof typeof REASONS

const isObject = (value: Json): value is Record<string, Json> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const num = (row: Record<string, Json>, key: string) => Number(row[key] ?? 0)

/** Aplica as equivalências escolhidas, para ver se o que sobra é igual. */
function normalize(value: Json, reasons: Set<Reason>, table: string, key = ''): Json {
  if (Array.isArray(value)) {
    const items = value.map((item) => normalize(item, reasons, table))
    if (reasons.has('empate') && items.every(isObject)) {
      const rows = items as Rows
      const byPosition = key === 'albums' || (key === '' && /_category.*_albums$/.test(table))
      if (byPosition) {
        rows.sort(
          (a, b) => num(a, 'order') - num(b, 'order') || num(a, 'id_album') - num(b, 'id_album'),
        )
      }
      if (key === 'musics') {
        rows.sort(
          (a, b) => num(a, 'track') - num(b, 'track') || num(a, 'id_music') - num(b, 'id_music'),
        )
      }
    }
    return items
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, normalize(v, reasons, table, k)]),
    )
  }
  if (typeof value === 'string') {
    if (reasons.has('url') && key.startsWith('url')) return value.replace(/\.(mp3|opus)$/, '')
    if (reasons.has('empate') && key === 'albums_names') return value.split('|').sort().join('|')
    // Nas listas de /json_db, `lyric` é o texto de busca; o prefixo é checado à parte.
    if (reasons.has('busca') && key === 'lyric') return ''
  }
  if (reasons.has('tamanho') && key === 'size') return 0
  return value
}

/** O texto novo precisa continuar o antigo: o corte do MySQL é em bytes e pode partir um caractere. */
function searchTextOnlyGrew(before: Json, after: Json): number | null {
  if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) return null
  let grew = 0
  for (const [i, old] of before.entries()) {
    const oldText = isObject(old) ? old.lyric : undefined
    const now = after[i]
    const newText = isObject(now) ? now.lyric : undefined
    if (oldText === newText) continue
    if (typeof oldText !== 'string' || typeof newText !== 'string') return null
    const prefix = Buffer.from(oldText).subarray(0, 1021)
    if (!Buffer.from(newText).subarray(0, prefix.length).equals(prefix)) return null
    grew++
  }
  return grew
}

/** Todas as combinações de motivos, das menores para as maiores. */
function combinations(reasons: Reason[]): Reason[][] {
  const all: Reason[][] = []
  for (let mask = 1; mask < 1 << reasons.length; mask++) {
    all.push(reasons.filter((_, i) => mask & (1 << i)))
  }
  return all.sort((a, b) => a.length - b.length)
}

type Tally = {
  identical: number
  explained: Map<string, string[]>
  changed: string[]
  added: string[]
  recovered: number
  seen: Set<string>
}
const tally = (): Tally => ({
  identical: 0,
  explained: new Map(),
  changed: [],
  added: [],
  recovered: 0,
  seen: new Set(),
})

function compare(t: Tally, dir: string, table: string, json: string, reasons: Reason[]) {
  t.seen.add(table)
  const path = join(dir, `${table}.json`)
  if (!existsSync(path)) {
    t.added.push(table)
    return
  }
  const published = readFileSync(path, 'utf8')
  if (published === json) {
    t.identical++
    return
  }

  let before = JSON.parse(published) as Json
  const after = JSON.parse(json) as Json
  let base: Reason[] = []
  if (reasons.includes('config') && /_config$/.test(table) && isObject(before) && isObject(after)) {
    // Comparadas só as chaves que o gerado tem; as demais eram marcadores da origem.
    const source = before
    before = Object.fromEntries(Object.keys(after).map((k) => [k, source[k]]))
    base = ['config']
  }

  for (const combination of [[], ...combinations(reasons.filter((r) => r !== 'config'))]) {
    const set = new Set<Reason>(combination)
    const same =
      JSON.stringify(normalize(before, set, table)) === JSON.stringify(normalize(after, set, table))
    if (!same) continue
    if (set.has('busca')) {
      const grew = searchTextOnlyGrew(before, after)
      if (grew === null) continue
      t.recovered += grew
    }
    const label = [...base, ...combination].join(' + ')
    t.explained.set(label, [...(t.explained.get(label) ?? []), table])
    return
  }
  t.changed.push(table)
}

const sample = (list: string[]) =>
  list.length === 0 ? '' : ` — ${list.slice(0, 5).join(', ')}${list.length > 5 ? '…' : ''}`

function report(title: string, t: Tally, dir: string, ignore: (table: string) => boolean): boolean {
  const removed = readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -5))
    .filter((table) => !t.seen.has(table) && !ignore(table))

  console.log(`\n${title}: ${t.seen.size} gerados`)
  console.log(`  idênticos byte a byte:        ${t.identical}`)
  for (const [label, tables] of t.explained) {
    console.log(`  ${label.padEnd(29)} ${String(tables.length).padStart(5)}${sample(tables)}`)
  }
  if (t.recovered > 0) console.log(`    (${t.recovered} entradas recuperam o fim da letra)`)
  console.log(`  com diferença sem explicação: ${t.changed.length}${sample(t.changed)}`)
  console.log(`  novos:                        ${t.added.length}${sample(t.added)}`)
  console.log(`  publicados e não gerados:     ${removed.length}${sample(removed)}`)
  return t.changed.length === 0 && t.added.length === 0 && removed.length === 0
}

let ok = true
const used = new Set<string>()
const note = (t: Tally) => {
  for (const label of t.explained.keys()) for (const r of label.split(' + ')) used.add(r)
}

if (JSON_DB) {
  const t = tally()
  for (const [table, json] of generateCatalog(db)) {
    compare(t, JSON_DB, table, json, ['busca', 'empate'])
  }
  if (args.has('bible')) {
    for (const [table, json] of generateBible(db)) compare(t, JSON_DB, table, json, [])
  }
  // Sem --bible os capítulos não são gerados: são estáticos e seguem como estão.
  const ignore = (table: string) => !args.has('bible') && /^bible_\d/.test(table)
  ok = report('/json_db', t, JSON_DB, ignore) && ok
  note(t)
}

if (REST) {
  const t = tally()
  for await (const [key, json] of generateRest(localD1(db), API)) {
    compare(t, REST, key, json, ['empate', 'url', 'tamanho', 'config'])
  }
  // metadata é a estatística da Bíblia: estática, não é regerada.
  ok = report('camada REST', t, REST, (table) => table === 'metadata') && ok
  note(t)
}

if (used.size > 0) {
  console.log('\nmotivos:')
  for (const reason of used) console.log(`  ${reason}: ${REASONS[reason as Reason]}`)
}
if (!ok) process.exitCode = 1
