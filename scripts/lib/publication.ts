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

/** Os capítulos da Bíblia são estáticos: a publicação nunca os gera nem apaga. */
const isBible = (table: string) => /^bible_\d/.test(table)

/**
 * /json_db: uma tabela só é regravada quando os bytes mudam. O hash do
 * manifesto é o que diz aos apps o que baixar de novo — por isso quem não mudou
 * mantém o hash que já tinha, mesmo ele tendo sido calculado pela origem.
 */
export function planJsonDb(
  generated: Map<string, string>,
  published: (table: string) => string | null,
  manifest: ManifestEntry[],
): Plan & { manifest: ManifestEntry[] } {
  const plan: Plan = { puts: [], deletes: [], changed: [], added: [], removed: [] }
  const known = new Set(manifest.map((entry) => entry.table))
  const hashes = new Map<string, string>()

  for (const [table, json] of generated) {
    const current = published(table)
    if (current === json) continue
    plan.puts.push({ key: `json_db/${table}.json`, body: json })
    hashes.set(table, md5(json))
    if (current === null && !known.has(table)) plan.added.push(table)
    else plan.changed.push(table)
  }

  const next: ManifestEntry[] = []
  for (const entry of manifest) {
    if (!isBible(entry.table) && !generated.has(entry.table)) {
      plan.removed.push(entry.table)
      plan.deletes.push(`json_db/${entry.table}.json`)
      continue
    }
    next.push({ ...entry, hash: hashes.get(entry.table) ?? entry.hash })
  }
  for (const table of plan.added) {
    next.push({
      file: `${table}.json`,
      table,
      path: `/db/${table}`,
      hash: hashes.get(table) as string,
    })
  }
  // Tabela que mudou e, por alguma falha anterior, não estava no manifesto.
  for (const table of plan.changed) {
    if (!known.has(table)) {
      next.push({
        file: `${table}.json`,
        table,
        path: `/db/${table}`,
        hash: hashes.get(table) as string,
      })
    }
  }

  return { ...plan, manifest: next }
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
  const latest = new Date(`${latestUpdatedUtc.replace(' ', 'T')}Z`)
  const stamp = saoPaulo(now)
  return {
    ...current,
    version_number: Number(current.version_number ?? 0) + 1,
    version: Math.floor(latest.getTime() / 1000),
    latest_updated: saoPaulo(latest),
    date: stamp.slice(0, 10),
    time: stamp.slice(11),
    datetime: stamp,
  }
}
