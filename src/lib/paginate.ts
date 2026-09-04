/**
 * Envelope de paginação do Laravel, que é o formato que a API de origem
 * devolve nas rotas REST. Replicado campo a campo, inclusive a lista `links`
 * com as reticências — clientes que renderizam paginação dependem dela.
 */
export function paginate(rows: unknown[], url: URL, perPage = 15) {
  const total = rows.length
  const lastPage = Math.max(1, Math.ceil(total / perPage))
  const current = Math.min(Math.max(1, Number(url.searchParams.get('page')) || 1), lastPage)

  const base = `${url.origin}${url.pathname}`
  const at = (p: number) => `${base}?page=${p}`
  const data = rows.slice((current - 1) * perPage, current * perPage)

  // O Laravel mostra as 10 primeiras páginas, reticências, e as 2 últimas.
  const numbers: Array<number | null> = []
  if (lastPage <= 13) {
    for (let p = 1; p <= lastPage; p++) numbers.push(p)
  } else {
    for (let p = 1; p <= 10; p++) numbers.push(p)
    numbers.push(null, lastPage - 1, lastPage)
  }

  return {
    current_page: current,
    data,
    first_page_url: at(1),
    from: total === 0 ? null : (current - 1) * perPage + 1,
    last_page: lastPage,
    last_page_url: at(lastPage),
    links: [
      { url: current > 1 ? at(current - 1) : null, label: '&laquo; Previous', active: false },
      ...numbers.map((p) =>
        p === null
          ? { url: null, label: '...', active: false }
          : { url: at(p), label: String(p), active: p === current },
      ),
      { url: current < lastPage ? at(current + 1) : null, label: 'Next &raquo;', active: false },
    ],
    next_page_url: current < lastPage ? at(current + 1) : null,
    path: base,
    per_page: perPage,
    prev_page_url: current > 1 ? at(current - 1) : null,
    to: total === 0 ? null : Math.min(current * perPage, total),
    total,
  }
}
