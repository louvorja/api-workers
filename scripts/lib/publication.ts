/**
 * Decide o que uma publicação precisa gravar, sem gravar nada.
 *
 * Recebe o que o banco gera e o que está publicado, e devolve a lista de
 * objetos a enviar e a apagar. Separado da execução para poder ser testado e
 * para o modo de simulação mostrar exatamente o que o modo real faria.
 */
import { createHash } from 'node:crypto'

export const md5 = (text: string) => createHash('md5').update(text).digest('hex')

export type ManifestEntry = { file: string; table: string; path: string; hash: string }
export type Put = { key: string; body: string }

export type Plan = {
  puts: Put[]
  deletes: string[]
  changed: string[]
  added: string[]
  removed: string[]
}

export const isBibleTable = (table: string) => /^bible_\d/.test(table)

export interface JsonDbPlanOptions {
  /** Mantém capítulos publicados que não vieram no mapa gerado durante o bootstrap do D1. */
  preserveBible?: boolean
}

/**
 * /json_db: uma tabela só é regravada quando os bytes mudam. O hash do
 * manifesto é o que diz aos apps o que baixar de novo — por isso quem não mudou
 * mantém o hash que já tinha, mesmo ele tendo sido calculado pela origem.
 */
export function planJsonDb(
  generated: Map<string, string>,
  published: (table: string) => string | null,
  manifest: ManifestEntry[],
  options: JsonDbPlanOptions = {},
): Plan & { manifest: ManifestEntry[]; manifestChanged: boolean } {
  const plan: Plan = { puts: [], deletes: [], changed: [], added: [], removed: [] }
  const known = new Set(manifest.map((entry) => entry.table))
  const hashes = new Map([...generated].map(([table, json]) => [table, md5(json)]))
  const preserveBible = options.preserveBible ?? true

  for (const [table, json] of generated) {
    const current = published(table)
    if (current === json) continue
    plan.puts.push({ key: `json_db/${table}.json`, body: json })
    if (current === null && !known.has(table)) plan.added.push(table)
    else plan.changed.push(table)
  }

  const next: ManifestEntry[] = []
  const included = new Set<string>()
  for (const entry of manifest) {
    if (!generated.has(entry.table)) {
      if (preserveBible && isBibleTable(entry.table)) {
        if (!included.has(entry.table)) {
          included.add(entry.table)
          next.push(entry)
        }
        continue
      }
      plan.removed.push(entry.table)
      plan.deletes.push(`json_db/${entry.table}.json`)
      continue
    }
    if (included.has(entry.table)) continue
    included.add(entry.table)
    next.push({
      file: `${entry.table}.json`,
      table: entry.table,
      path: `/db/${entry.table}`,
      hash: hashes.get(entry.table) as string,
    })
  }

  // Também repara manifesto ausente depois de uma falha entre o upload do ZIP
  // e o do manifesto: o conteúdo já publicado não precisa ser reenviado.
  for (const table of generated.keys()) {
    if (included.has(table)) continue
    included.add(table)
    next.push({
      file: `${table}.json`,
      table,
      path: `/db/${table}`,
      hash: hashes.get(table) as string,
    })
  }

  return {
    ...plan,
    manifest: next,
    manifestChanged: JSON.stringify(next) !== JSON.stringify(manifest),
  }
}

/**
 * Camada REST: ninguém lê hash dela, então o estado guardado é só o MD5 do que
 * foi publicado por último, para não reenviar 2.600 objetos a cada execução.
 */
export function planRest(
  generated: Map<string, string>,
  state: Record<string, string>,
): Plan & { state: Record<string, string> } {
  const plan: Plan = { puts: [], deletes: [], changed: [], added: [], removed: [] }
  const next: Record<string, string> = {}

  for (const [key, json] of generated) {
    const hash = md5(json)
    next[key] = hash
    if (state[key] === hash) continue
    plan.puts.push({ key: `rest/${key}.json`, body: json })
    if (key in state) plan.changed.push(key)
    else plan.added.push(key)
  }
  for (const key of Object.keys(state)) {
    if (generated.has(key)) continue
    plan.removed.push(key)
    plan.deletes.push(`rest/${key}.json`)
  }

  return { ...plan, state: next }
}

export type Config = Record<string, string | number>

/** Onde a publicação anota até que ponto da auditoria o que está no ar reflete. */
export const PUBLISHED_LOG_KEY = 'state/published-log.json'

/**
 * `head` é o maior id da tabela de auditoria; `stored`, o conteúdo da marca no
 * bucket. Marca ausente ou ilegível conta como alteração: na dúvida, publica.
 */
export function publishedLogChanged(head: number, stored: string | null): boolean {
  if (stored === null) return true
  try {
    const published = (JSON.parse(stored) as { id_log?: unknown }).id_log
    return typeof published !== 'number' || published !== head
  } catch {
    return true
  }
}

/** Converte o `updated_at` UTC do catálogo para o número comparado pelo Delphi/PHP. */
export function updatedAtVersion(updatedAtUtc: string): number {
  const value = updatedAtUtc.trim()
  const iso = /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value.replace(' ', 'T')}Z`
  const milliseconds = Date.parse(iso)
  if (!Number.isFinite(milliseconds)) throw new Error(`updated_at inválido: ${updatedAtUtc}`)
  return Math.floor(milliseconds / 1000)
}

export function catalogVersionChanged(
  currentVersion: string | number | undefined,
  latestUpdatedUtc: string,
): boolean {
  return Number(currentVersion) !== updatedAtVersion(latestUpdatedUtc)
}

/**
 * O servidor de origem roda no fuso de São Paulo, e é nele que `configs` guarda
 * data e hora. O Brasil não tem horário de verão desde 2019: são sempre 3 horas.
 */
const SAO_PAULO_OFFSET_MS = 3 * 60 * 60 * 1000
const saoPaulo = (instant: Date) =>
  new Date(instant.getTime() - SAO_PAULO_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ')

/**
 * Nova versão do catálogo, como o Configs::refresh() da origem a calculava: o
 * número sobe em um e `version` é o instante da alteração mais recente.
 * `latestUpdatedUtc` vem das tabelas, que no D1 guardam as datas em UTC.
 */
export function nextConfig(current: Config, latestUpdatedUtc: string, now: Date): Config {
  const version = updatedAtVersion(latestUpdatedUtc)
  const latest = new Date(version * 1000)
  const stamp = saoPaulo(now)
  return {
    ...current,
    version_number: Number(current.version_number ?? 0) + 1,
    version,
    latest_updated: saoPaulo(latest),
    date: stamp.slice(0, 10),
    time: stamp.slice(11),
    datetime: stamp,
  }
}
