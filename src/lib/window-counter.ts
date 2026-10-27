import { DurableObject } from 'cloudflare:workers'
import { type BibleAbuseState, bibleRetryAfter, recordBibleOutcome } from './bible-abuse.ts'

const ABUSE_KEY = 'bible-abuse-v1'

export type CounterResult = {
  allowed: boolean
  count: number
  retryAfter?: number
  reason?: 'invalid-bible-queries'
}

/**
 * Contador de janela fixa, um Durable Object por chave (IP).
 *
 * Os contadores que não passam por um único ponto não seguraram o teto em
 * produção: o binding `ratelimits` deixou 200 pedidos passarem por um limite de
 * 60/min, a Cache API não guardou a conta e a memória do isolate também não,
 * porque cada conexão nova cai numa máquina diferente da borda. O objeto durável
 * é único no mundo para cada chave e processa um pedido por vez, então a conta é
 * exata.
 */
export class WindowCounter extends DurableObject {
  private windowId = 0
  private count = 0

  async hit(limit: number, windowSeconds: number): Promise<CounterResult> {
    const abuse = await this.ctx.storage.get<BibleAbuseState>(ABUSE_KEY)
    const retryAfter = bibleRetryAfter(abuse, Date.now())
    if (retryAfter > 0) {
      return { allowed: false, count: this.count, retryAfter, reason: 'invalid-bible-queries' }
    }
    const id = Math.floor(Date.now() / (windowSeconds * 1000))
    if (id !== this.windowId) {
      this.windowId = id
      this.count = 0
    }
    if (this.count >= limit) return { allowed: false, count: this.count }
    this.count += 1
    return { allowed: true, count: this.count }
  }

  async recordResult(status: number): Promise<void> {
    const previous = await this.ctx.storage.get<BibleAbuseState>(ABUSE_KEY)
    const state = recordBibleOutcome(previous, status, Date.now())
    if (!state || state === previous) return
    await this.ctx.storage.put(ABUSE_KEY, state)
    await this.ctx.storage.setAlarm(state.expiresAt)
    if (state.blockedUntil > (previous?.blockedUntil ?? 0)) {
      console.warn('bible_invalid_queries_suspended', {
        retry_after: bibleRetryAfter(state, Date.now()),
      })
    }
  }

  async alarm(): Promise<void> {
    const state = await this.ctx.storage.get<BibleAbuseState>(ABUSE_KEY)
    if (!state) return
    if (state.expiresAt <= Date.now()) await this.ctx.storage.delete(ABUSE_KEY)
    else await this.ctx.storage.setAlarm(state.expiresAt)
  }
}

/** Falha aberta: se o objeto durável não responder, a rota segue sem limite. */
export async function countHit(
  namespace: DurableObjectNamespace<WindowCounter>,
  key: string,
  limit: number,
  windowSeconds = 60,
): Promise<CounterResult> {
  try {
    const stub = namespace.get(namespace.idFromName(key))
    return await stub.hit(limit, windowSeconds)
  } catch (reason) {
    console.error('window_counter_failed', reason)
    return { allowed: true, count: 0 }
  }
}

export async function recordBibleResult(
  namespace: DurableObjectNamespace<WindowCounter>,
  key: string,
  status: number,
): Promise<void> {
  try {
    await namespace.get(namespace.idFromName(key)).recordResult(status)
  } catch (reason) {
    console.error('bible_outcome_counter_failed', reason)
  }
}
