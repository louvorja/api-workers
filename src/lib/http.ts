import type { Context } from 'hono'

/**
 * Cabeçalhos que a API legada devolve em toda resposta.
 *
 * `Access-Control-Allow-Credentials: true` existia no original junto de
 * `Allow-Origin: *`. A combinação é rejeitada por todo navegador, então o
 * header nunca teve efeito — foi removido em vez de replicado.
 */
export const COMMON_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-Robots-Tag': 'noindex',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Api-Token',
  'Access-Control-Max-Age': '86400',
}

/**
 * /auth, /admin e /tasks recebem operações do painel, que roda em outra origem:
 * o preflight precisa liberar todos os métodos usados ali. E nada nesses
 * prefixos pode ir para o cache — a resposta depende de quem está autenticado.
 */
export const PRIVATE_HEADERS: Record<string, string> = {
  ...COMMON_HEADERS,
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS, PUT, DELETE',
  'Cache-Control': 'no-store',
}

export const isPrivatePath = (path: string) =>
  path.startsWith('/auth/') ||
  path === '/admin' ||
  path.startsWith('/admin/') ||
  path === '/tasks' ||
  path.startsWith('/tasks/')

/**
 * 404 no formato da API legada, sem vazar o caminho interno como o original
 * fazia. `no-store` é essencial: 404 é heuristicamente cacheável pela RFC 9111,
 * e guardar um na borda envenenaria a chave enquanto o acervo ainda é ingerido.
 */
export function notFound(c: Context): Response {
  c.header('Cache-Control', 'no-store')
  return c.json({ error: 'Arquivo não encontrado!' }, 404)
}
