import { Hono } from 'hono'
import { COMMON_HEADERS, notFound } from '../lib/http.ts'
import { serveObject } from '../lib/r2.ts'
import { openapi } from '../openapi.ts'
import type { App } from '../types.ts'

export const legacy = new Hono<App>()

const passthrough: Array<[path: string, key: string]> = [
  ['/version_log', 'meta/version_log.html'],
  ['/onlinevideos', 'meta/onlinevideos.txt'],
]

legacy.get('/openapi.json', () => {
  const headers = new Headers(COMMON_HEADERS)
  headers.set('Content-Type', 'application/json')
  headers.set('Cache-Control', 'public, max-age=3600')
  return new Response(JSON.stringify(openapi), { headers })
})

// Swagger UI pelo CDN: a alternativa é embutir ~1MB de JS no bundle do Worker.
legacy.get('/documentation', () => {
  const headers = new Headers(COMMON_HEADERS)
  headers.set('Content-Type', 'text/html; charset=UTF-8')
  headers.set('Cache-Control', 'public, max-age=3600')
  return new Response(
    `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>LouvorJA API</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css">
</head><body><div id="ui"></div>
<script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>SwaggerUIBundle({url:'/openapi.json',dom_id:'#ui',deepLinking:true})</script>
</body></html>`,
    { headers },
  )
})

for (const [path, key] of passthrough) {
  legacy.on(['GET', 'HEAD'], path, async (c) => {
    const res = await serveObject(
      c.env.FILES,
      key,
      c.req.raw,
      'public, max-age=3600, stale-while-revalidate=86400',
    )
    return res ?? notFound(c)
  })
}

/**
 * O handshake FTP saiu do ar: o desktop passou a baixar mídia por HTTPS em
 * /file (electron/main/download/index.js). O endpoint responde explicitamente
 * em vez de sumir, para que um cliente antigo receba um erro legível.
 */
legacy.get('/ftp', (c) => {
  c.header('Cache-Control', 'no-store')
  return c.json(
    { error: 'FTP descontinuado', details: 'Baixe as mídias por HTTPS em /file/<caminho>' },
    410,
  )
})
