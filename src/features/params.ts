import { Hono } from 'hono'
import { COMMON_HEADERS, notFound } from '../lib/http.ts'
import type { App } from '../types.ts'

/** O instalador Delphi consome INI; o app Electron consome JSON. Mesmo conteúdo. */
function toIni(params: Record<string, string>): string {
  return `${Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')}\n`
}

export const params = new Hono<App>()

params.on(['GET', 'HEAD'], '/params', async (c) => {
  const object = await c.env.FILES.get('meta/params.json')
  if (object === null) return notFound(c)

  const data = await object.json<Record<string, string>>()
  const headers = new Headers(COMMON_HEADERS)
  headers.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400')

  if (c.req.query('type') === 'env') {
    headers.set('Content-Type', 'text/plain; charset=UTF-8')
    return new Response(toIni(data), { headers })
  }
  headers.set('Content-Type', 'application/json')
  return new Response(JSON.stringify(data), { headers })
})
