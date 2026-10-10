/** Data e hora em UTC no formato que a origem grava: 'YYYY-MM-DD HH:MM:SS'. */
export function sqlNow(date = new Date()): string {
  return date.toISOString().slice(0, 19).replace('T', ' ')
}

/** Como o Eloquent serializa created_at/updated_at: ISO-8601 com microssegundos. */
export function toIso(value: unknown): unknown {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}.000000Z`
    : value
}

export function quote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`
}

/**
 * O MySQL da origem usa colação utf8mb4_unicode_ci: busca e ordenação ignoram
 * caixa e acento ("coracao" acha "Coração"). O SQLite só ignora caixa em ASCII
 * e não tem função para tirar acento, então as duas pontas da comparação
 * passam pela mesma tabela de troca.
 */
const FOLD: Array<[from: string, to: string]> = [
  ['áàâãäÁÀÂÃÄ', 'a'],
  ['éèêëÉÈÊË', 'e'],
  ['íìîïÍÌÎÏ', 'i'],
  ['óòôõöÓÒÔÕÖ', 'o'],
  ['úùûüÚÙÛÜ', 'u'],
  ['çÇ', 'c'],
  ['ñÑ', 'n'],
]

export function foldSql(expr: string): string {
  let sql = expr
  for (const [chars, to] of FOLD) {
    for (const ch of chars) sql = `replace(${sql}, '${ch}', '${to}')`
  }
  return `lower(${sql})`
}

export function foldText(text: string): string {
  let out = text
  for (const [chars, to] of FOLD) {
    for (const ch of chars) out = out.replaceAll(ch, to)
  }
  return out.toLowerCase()
}
