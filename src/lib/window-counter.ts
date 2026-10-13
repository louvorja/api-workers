import { DurableObject } from 'cloudflare:workers'

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

  async hit(limit: number, windowSeconds: number): Promise<{ allowed: boolean; count: number }> {
    const id = Math.floor(Date.now() / (windowSeconds * 1000))
    if (id !== this.windowId) {
      this.windowId = id
      this.count = 0
    }
    if (this.count >= limit) return { allowed: false, count: this.count }
    this.count += 1
    return { allowed: true, count: this.count }
  }
}

/** Falha aberta: se o objeto durável não responder, a rota segue sem limite. */
export async function countHit(
  namespace: DurableObjectNamespace<WindowCounter>,
  key: string,
  limit: number,
  windowSeconds = 60,
): Promise<{ allowed: boolean; count: number }> {
  try {
    const stub = namespace.get(namespace.idFromName(key))
    return await stub.hit(limit, windowSeconds)
  } catch (reason) {
    console.error('window_counter_failed', reason)
    return { allowed: true, count: 0 }
  }
}
