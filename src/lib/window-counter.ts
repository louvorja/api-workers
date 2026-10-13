/**
 * Contador de janela fixa na memória do isolate.
 *
 * O binding `ratelimits` da Cloudflare não segura um teto baixo (medido em
 * produção: 200 pedidos em 89 s passaram por um limite de 60/min), e a Cache API
 * não guardou o contador (120 pedidos seguidos, nenhum bloqueado). A memória do
 * isolate persiste entre pedidos enquanto ele estiver quente, o que é o caso de
 * um robô sequencial na mesma localidade.
 *
 * Limites desta abordagem, de propósito: cada isolate tem a própria conta, então
 * o teto efetivo é o limite vezes os isolates ativos, e um isolate reciclado zera
 * a conta. Serve para frear varredura; não é medidor.
 */
const windows = new Map<string, { id: number; count: number }>()
const MAX_KEYS = 5_000

export async function countHit(
  key: string,
  limit: number,
  windowSeconds = 60,
): Promise<{ allowed: boolean; count: number }> {
  const id = Math.floor(Date.now() / (windowSeconds * 1000))
  if (windows.size > MAX_KEYS) {
    for (const [stored, entry] of windows) if (entry.id !== id) windows.delete(stored)
    if (windows.size > MAX_KEYS) windows.clear()
  }
  const entry = windows.get(key)
  const count = entry !== undefined && entry.id === id ? entry.count : 0
  if (count >= limit) return { allowed: false, count }
  windows.set(key, { id, count: count + 1 })
  return { allowed: true, count: count + 1 }
}
