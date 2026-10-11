import { Hono } from 'hono'
import { COMMON_HEADERS, notFound } from '../lib/http.ts'
import type { App } from '../types.ts'
import { FTP_HANDSHAKE_ORIGIN, ftpEnabled, ftpHandshakeUrl } from './ftp.ts'

/**
 * O instalador Delphi consome INI; o app Electron consome JSON. Mesmo conteúdo.
 * As quebras são CRLF porque é o que a origem emite e o que o parser Pascal
 * espera.
 */
function toIni(params: Record<string, unknown>): string {
  return `${Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join('\r\n')}\r\n`
}

export const params = new Hono<App>()
// É por aqui que o app descobre que há catálogo novo (`db_version`). Uma hora,
// como o manifesto: é o atraso máximo para perceber uma publicação.
const PARAMS_CACHE = 'public, max-age=3600, stale-while-revalidate=86400'

params.on(['GET', 'HEAD'], '/params', async (c) => {
  const object = await c.env.FILES.get('meta/params.json')
  if (object === null) return notFound(c)

  const data = await object.json<Record<string, unknown>>()
  // O Delphi só inicia a atualização se receber o endereço do aperto de mão do
  // FTP. A chave só existe enquanto houver um servidor de FTP configurado.
  if (ftpEnabled(c.env)) {
    data.conn_ftp = await ftpHandshakeUrl(FTP_HANDSHAKE_ORIGIN, c.env.JWT_SECRET)
  }
  const headers = new Headers(COMMON_HEADERS)
  headers.set('Cache-Control', PARAMS_CACHE)

  if (c.req.query('type') === 'env') {
    headers.set('Content-Type', 'text/plain; charset=UTF-8')
    return new Response(toIni(data), { headers })
  }
  headers.set('Content-Type', 'application/json')
  return new Response(JSON.stringify(data), { headers })
})
