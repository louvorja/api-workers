const BASE = process.env.LEGACY_API_URL ?? 'https://api.louvorja.com.br'
const TOKEN = process.env.LEGACY_API_TOKEN ?? ''

/**
 * A origem limita requisições por janela de 60s e anuncia o saldo em
 * x-ratelimit-remaining. Quando o saldo fica baixo o cliente dorme até o reset,
 * em vez de tomar 429 e ter que reprocessar a fila inteira.
 */
let pauseUntil = 0

/**
 * Espaçamento mínimo GLOBAL entre requisições.
 *
 * Reagir ao x-ratelimit-remaining não basta: o saldo só é lido depois da
 * resposta, então N workers disparam juntos antes de qualquer um saber que o
 * saldo acabou. Uma corrida com concorrência 8 tomou 214 respostas 429 e 137
 * timeouts em 2.000 requisições; com espaçamento e concorrência 3, 351
 * requisições passaram sem uma única falha. O relógio é compartilhado — cada
 * chamada reserva a próxima fatia antes de sair.
 */
const MIN_INTERVAL_MS = Number(process.env.LEGACY_MIN_INTERVAL_MS ?? 250)
let nextSlot = 0

/**
 * Teto de requisições por execução. A origem corta em 5.000 por janela; estourar
 * não degrada, derruba o lote inteiro em 429. Melhor parar sabendo onde parou.
 */
const MAX_REQUESTS = Number(process.env.LEGACY_MAX_REQUESTS ?? 0)
let feitas = 0

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function throttle() {
  if (MAX_REQUESTS > 0 && ++feitas > MAX_REQUESTS) {
    throw new Error(`teto de ${MAX_REQUESTS} requisições à origem atingido nesta execução`)
  }
  const agora = Date.now()
  const slot = Math.max(nextSlot, agora)
  nextSlot = slot + MIN_INTERVAL_MS
  const espera = Math.max(slot - agora, pauseUntil - agora)
  if (espera > 0) await sleep(espera)
}

/** Quantas requisições esta execução já gastou. */
export const requisicoesFeitas = () => feitas

function observe(res: Response) {
  const remaining = Number(res.headers.get('x-ratelimit-remaining'))
  const reset = Number(res.headers.get('x-ratelimit-reset'))
  if (Number.isFinite(remaining) && remaining < 20 && Number.isFinite(reset)) {
    pauseUntil = Math.max(pauseUntil, reset * 1000 + 1000)
  }
}

export type Fetched = { status: number; body: Uint8Array; contentType: string }

export async function fetchLegacy(path: string, attempt = 0): Promise<Fetched> {
  await throttle()

  const res = await fetch(`${BASE}${path}`, {
    headers: TOKEN ? { 'Api-Token': TOKEN } : {},
    signal: AbortSignal.timeout(60_000),
  }).catch((e: Error) => e)

  if (res instanceof Error || res.status === 429 || res.status >= 500) {
    if (attempt >= 5) {
      throw new Error(`${path}: ${res instanceof Error ? res.message : `HTTP ${res.status}`}`)
    }
    if (!(res instanceof Error)) observe(res)
    await sleep(2 ** attempt * 1000)
    return fetchLegacy(path, attempt + 1)
  }

  observe(res)
  return {
    status: res.status,
    body: new Uint8Array(await res.arrayBuffer()),
    contentType: res.headers.get('content-type') ?? 'application/octet-stream',
  }
}

export async function fetchJson<T>(key: string): Promise<T | null> {
  const res = await fetchLegacy(`/json_db/${key}`)
  if (res.status === 404) return null
  if (res.status !== 200) throw new Error(`json_db/${key} -> HTTP ${res.status}`)
  return JSON.parse(new TextDecoder().decode(res.body)) as T
}

/** Executa `work` sobre `items` com no máximo `limit` requisições em voo. */
export async function pool<T>(
  items: T[],
  limit: number,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      await work(items[i] as T, i)
    }
  })
  await Promise.all(runners)
}
