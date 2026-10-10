import { foldSql, foldText, toIso } from '../sql.ts'

/**
 * Coluna de uma listagem, na ordem do `select` do controller de origem. `key` é
 * o nome que sai no JSON e o que o cliente usa para filtrar e ordenar; `expr`,
 * a expressão SQL por trás dele.
 */
export type Column = { key: string; expr: string; text?: boolean; filter?: boolean }

export type ListSpec = {
  columns: Column[]
  from: string
  /** Desempate estável da ordenação — o MySQL devolvia na ordem da chave. */
  tiebreak: string
  distinct?: boolean
}

export type Where = { sql: string; params: unknown[] }
type ChainedWhere = Where & { bool: 'AND' | 'OR' }

/**
 * Porte de Data::whereExplode. O valor do filtro pode vir prefixado:
 * `like:*x*`, `orlike:*x*`, `or:5`. Qualquer outro prefixo não é operador e o
 * texto inteiro vira o valor da igualdade.
 */
function explode(text: string): { like: boolean; or: boolean; value: unknown } {
  const coerce = (v: string): unknown => (v === 'true' ? 1 : v === 'false' ? 0 : v)
  const colon = text.indexOf(':')
  if (colon === -1) return { like: false, or: false, value: coerce(text) }

  const op = text.slice(0, colon)
  const rest = text.slice(colon + 1)
  if (op === 'like' || op === 'orlike') {
    return { like: true, or: op === 'orlike', value: rest.replaceAll('*', '%') }
  }
  if (op === 'or') return { like: false, or: true, value: coerce(rest) }
  return { like: false, or: false, value: coerce(text) }
}

/**
 * A origem monta a cláusula como uma corrente plana, na ordem das colunas, e o
 * AND/OR de cada elo vem do prefixo do valor. A precedência resultante é a do
 * SQL — reproduzir a corrente elo a elo é o que mantém o mesmo resultado.
 */
function buildWhere(spec: ListSpec, query: URLSearchParams, pre: Where[]): Where {
  const chain: ChainedWhere[] = pre.map((w) => ({ ...w, bool: 'AND' }))

  for (const column of spec.columns) {
    if (column.filter === false) continue
    const raw = query.get(column.key)
    if (raw === null) continue

    const { like, or, value } = explode(raw)
    chain.push(
      like
        ? {
            bool: or ? 'OR' : 'AND',
            sql: `${foldSql(column.expr)} LIKE ?`,
            params: [foldText(String(value))],
          }
        : { bool: or ? 'OR' : 'AND', sql: `${column.expr} = ?`, params: [value] },
    )
  }

  if (chain.length === 0) return { sql: '', params: [] }
  return {
    sql: `WHERE ${chain.map((w, i) => (i === 0 ? w.sql : `${w.bool} ${w.sql}`)).join(' ')}`,
    params: chain.flatMap((w) => w.params),
  }
}

function buildOrder(spec: ListSpec, query: URLSearchParams): string {
  const parts: string[] = []
  for (const item of (query.get('sort_by') ?? '').split(',')) {
    const [name, direction] = item.split('.')
    const column = spec.columns.find((c) => c.key === name)
    if (!column) continue
    const expr = column.text ? foldSql(column.expr) : column.expr
    parts.push(`${expr} ${direction === 'desc' ? 'DESC' : 'ASC'}`)
  }
  parts.push(spec.tiebreak)
  return `ORDER BY ${parts.join(', ')}`
}

/**
 * Tamanho da página como a origem o resolve: sem `limit` (ou com zero) vale o
 * padrão do Eloquent, 15; negativo é o "traga tudo" do painel, que a origem
 * limita a 9.999 linhas.
 */
export const DEFAULT_PER_PAGE = 15
export const MAX_PER_PAGE = 9999

function perPageOf(query: URLSearchParams): number {
  const limit = Math.trunc(Number(query.get('limit')))
  if (!Number.isFinite(limit) || limit === 0) return DEFAULT_PER_PAGE
  return limit < 0 ? MAX_PER_PAGE : limit
}

function pageOf(query: URLSearchParams): number {
  const page = Number(query.get('page'))
  return Number.isInteger(page) && page >= 1 ? page : 1
}

/** Janela de páginas do UrlWindow do Laravel, com três de cada lado da atual. */
export function pageWindow(current: number, last: number): Array<number | null> {
  const range = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i)
  const onEachSide = 3
  const window = onEachSide + 4

  if (last < onEachSide * 2 + 8) return range(1, last)
  if (current <= window) return [...range(1, window + onEachSide), null, last - 1, last]
  if (current > last - window) {
    return [1, 2, null, ...range(last - (window + onEachSide - 1), last)]
  }
  return [1, 2, null, ...range(current - onEachSide, current + onEachSide), null, last - 1, last]
}

export type Paginated = Record<string, unknown> & { data: Record<string, unknown>[]; total: number }

/** Envelope do LengthAwarePaginator, campo a campo. */
function envelope(
  rows: Record<string, unknown>[],
  total: number,
  perPage: number,
  page: number,
  path: string,
): Paginated {
  const lastPage = Math.max(1, Math.ceil(total / perPage))
  const at = (p: number) => `${path}?page=${p}`
  const from = rows.length > 0 ? (page - 1) * perPage + 1 : null

  return {
    current_page: page,
    data: rows,
    first_page_url: at(1),
    from,
    last_page: lastPage,
    last_page_url: at(lastPage),
    links: [
      { url: page > 1 ? at(page - 1) : null, label: '&laquo; Previous', active: false },
      ...pageWindow(Math.min(page, lastPage), lastPage).map((p) =>
        p === null
          ? { url: null, label: '...', active: false }
          : { url: at(p), label: String(p), active: p === page },
      ),
      { url: page < lastPage ? at(page + 1) : null, label: 'Next &raquo;', active: false },
    ],
    next_page_url: page < lastPage ? at(page + 1) : null,
    path,
    per_page: perPage,
    prev_page_url: page > 1 ? at(page - 1) : null,
    to: from === null ? null : from + rows.length - 1,
    total,
  }
}

export function presentRow(row: Record<string, unknown>): Record<string, unknown> {
  if ('created_at' in row) row.created_at = toIso(row.created_at)
  if ('updated_at' in row) row.updated_at = toIso(row.updated_at)
  return row
}

/** Porte de Data::data: filtra, ordena e pagina uma listagem. */
export async function paginate(
  db: D1Database,
  spec: ListSpec,
  url: URL,
  pre: Where[] = [],
  present: (row: Record<string, unknown>) => Record<string, unknown> = presentRow,
): Promise<Paginated> {
  const query = url.searchParams
  const where = buildWhere(spec, query, pre)
  const perPage = perPageOf(query)
  const page = pageOf(query)
  const select = spec.columns.map((c) => `${c.expr} AS "${c.key}"`).join(', ')

  const [count, list] = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT count(*) AS total FROM ${spec.from} ${where.sql}`).bind(...where.params),
    db
      .prepare(
        `SELECT ${spec.distinct ? 'DISTINCT ' : ''}${select} FROM ${spec.from} ${where.sql} ` +
          `${buildOrder(spec, query)} LIMIT ? OFFSET ?`,
      )
      .bind(...where.params, perPage, (page - 1) * perPage),
  ])

  const total = Number(count?.results[0]?.total ?? 0)
  const rows = (list?.results ?? []).map(present)
  return envelope(rows, total, perPage, page, `${url.origin}${url.pathname}`)
}
