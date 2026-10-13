/**
 * Contador de janela fixa guardado no cache da borda (Cache API).
 *
 * O binding `ratelimits` da Cloudflare é aproximado demais para um teto baixo:
 * medido em produção, 200 pedidos em 89 s passaram por um limite de 60/min. Este
 * contador é por localidade (PoP), o que basta para um robô sequencial, que bate
 * sempre na mesma. Pedidos simultâneos podem passar juntos: ele freia quem
 * espera a resposta antes do próximo pedido, não uma rajada paralela.
 */
export async function countHit(
  key: string,
  limit: number,
  windowSeconds = 60,
): Promise<{ allowed: boolean; count: number }> {
  const cache = caches.default
  const windowId = Math.floor(Date.now() / (windowSeconds * 1000))
  const request = new Request(
    `https://window-counter.invalid/${encodeURIComponent(key)}/${windowId}`,
  )
  const stored = await cache.match(request)
  const count = stored === undefined ? 0 : Number(await stored.text())
  if (count >= limit) return { allowed: false, count }
  await cache.put(
    request,
    new Response(String(count + 1), {
      headers: { 'Cache-Control': `public, max-age=${windowSeconds}` },
    }),
  )
  return { allowed: true, count: count + 1 }
}
