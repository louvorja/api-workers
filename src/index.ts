import { Hono } from 'hono'
import { admin } from './features/admin.ts'
import { auth } from './features/auth.ts'
import { db } from './features/db.ts'
import { files } from './features/files.ts'
import { jsonDb } from './features/json-db.ts'
import { legacy } from './features/legacy.ts'
import { params } from './features/params.ts'
import { rest } from './features/rest.ts'
import { requireSecret } from './lib/auth/session.ts'
import { COMMON_HEADERS, isPrivatePath, notFound, PRIVATE_HEADERS } from './lib/http.ts'
import type { App } from './types.ts'

const app = new Hono<App>()

app.use('*', async (c, next) => {
  await next()
  const headers = isPrivatePath(c.req.path) ? PRIVATE_HEADERS : COMMON_HEADERS
  for (const [k, v] of Object.entries(headers)) c.header(k, v)
})

app.options('*', (c) => c.body(null, 204))

app.get('/', (c) => {
  c.header('Cache-Control', 'public, max-age=300')
  return c.json({
    name: 'api-louvorja',
    endpoints: [
      '/json_db/:key',
      '/db/manifest',
      '/db/:key',
      '/file/*',
      '/params',
      '/version_log',
      '/onlinevideos',
      '/health',
      '/version',
      '/metadata',
      '/{lang}/{musics,albums,categories,hymnal,lyrics,files,languages}',
      '/openapi.json',
    ],
    db_version: c.env.DB_VERSION,
  })
})

app.route('/', jsonDb)
app.route('/', db)
app.route('/', files)
app.route('/', params)
app.route('/', legacy)
// Antes do rest: /auth/me e /admin/musics casariam com /:lang/:collection.
app.use('/auth/*', requireSecret)
app.use('/admin/*', requireSecret)
app.route('/', auth)
app.route('/', admin)
// Por último: a rota genérica /:lang/:collection casaria com /json_db, /db e
// /file se viesse antes das rotas específicas.
app.route('/', rest)

app.notFound(notFound)

app.onError((err, c) => {
  console.error('unhandled', err)
  c.header('Cache-Control', 'no-store')
  return c.json({ error: 'Erro interno' }, 500)
})

export default app
