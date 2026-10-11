import { type Context, Hono } from 'hono'
import { COMMON_HEADERS } from '../lib/http.ts'
import { openapi } from '../openapi.ts'
import type { App } from '../types.ts'

export const legacy = new Hono<App>()

const VERSION_RE = /^\d+\.\d+(?:\.\d+)*$/

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

async function versionLog(c: Context<App>) {
  const object = await c.env.FILES.get('meta/params.json')
  const params = object === null ? {} : await object.json<Record<string, unknown>>()
  const requestedLang = String(c.req.query('lang') ?? 'pt').toLowerCase()
  const lang = requestedLang === 'es' ? 'es' : 'pt'
  const requested = c.req.query('version') ?? c.req.query('versao')
  const configured = params[`${lang}_version`]
  const version = String(requested ?? configured ?? '')
  const validVersion = VERSION_RE.test(version)
  const softwareVersion = validVersion ? version.split('.').slice(0, 2).join('.') : ''

  let body = `Não foi possivel encontrar informações sobre a versão ${version || 'informada'}!`
  if (softwareVersion) {
    try {
      const response = await fetch(
        `https://api.github.com/repos/louvorja/desktop/releases/tags/v${softwareVersion}`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'louvorja-api-workers',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: AbortSignal.timeout(5_000),
        },
      )
      if (response.ok) {
        const release = await response.json<{ body?: unknown }>()
        if (typeof release.body === 'string') body = release.body
      } else if (response.status !== 404) {
        throw new Error(`GitHub respondeu ${response.status}`)
      }
    } catch (reason) {
      console.error('version_log_fetch_failed', reason)
      const fallback = await c.env.FILES.get('meta/version_log.html')
      if (fallback !== null) {
        const headers = new Headers(COMMON_HEADERS)
        headers.set('Content-Type', 'text/html; charset=UTF-8')
        headers.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600')
        return new Response(c.req.method === 'HEAD' ? null : fallback.body, { headers })
      }
    }
  }

  const headers = new Headers(COMMON_HEADERS)
  headers.set('Content-Type', 'text/html; charset=UTF-8')
  headers.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600')
  const notes = escapeHtml(body).replaceAll('\n', '<br>')
  const html =
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<style>body{padding:20px;font-family:Arial,sans-serif;color:#666}</style>' +
    `</head><body><h1>${escapeHtml(version)}</h1>${notes}</body></html>`
  return new Response(c.req.method === 'HEAD' ? null : html, { headers })
}

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

legacy.on(['GET', 'HEAD'], '/version_log', versionLog)
