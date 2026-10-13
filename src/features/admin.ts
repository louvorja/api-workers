import { type Context, Hono, type MiddlewareHandler } from 'hono'
import { type Action, logStatement, notifyTelegram } from '../lib/admin/audit.ts'
import {
  type Column,
  type ListSpec,
  paginate,
  presentRow,
  type Where,
} from '../lib/admin/listing.ts'
import { readMediaUpload, storeMediaUpload, UploadError } from '../lib/admin/upload.ts'
import { type Body, filled, Validator, validationError } from '../lib/admin/validation.ts'
import { hashPassword } from '../lib/auth/password.ts'
import { readBody, requireAuth } from '../lib/auth/session.ts'
import { presentUser, type UserRow } from '../lib/auth/users.ts'
import { FILES_URL } from '../lib/media-urls.ts'
import { quote, sqlNow } from '../lib/sql.ts'
import type { App } from '../types.ts'

type Row = Record<string, unknown>
type Ctx = Context<App>

const NOT_FOUND = { error: 'Registro não encontrado!' }
const CREATED = 'Registro cadastrado com sucesso!'
const UPDATED = 'Registro alterado com sucesso!'
const DELETED = 'Registro excluído com sucesso!'

/** Usa o objeto publicado; `name` preserva o nome original para cadastro. */
export const fileUrl = (base: string, alias: string) =>
  `(${quote(base)} || ${alias}.dir || '/' || ${alias}.file_name)`

export const MUSIC_FILES =
  'LEFT JOIN files AS files_image ON musics.id_file_image = files_image.id_file ' +
  'LEFT JOIN files AS files_music ON musics.id_file_music = files_music.id_file ' +
  'LEFT JOIN files AS files_instrumental_music ' +
  'ON musics.id_file_instrumental_music = files_instrumental_music.id_file'

export const musicFileColumns = (base: string): Column[] => [
  { key: 'id_file_image', expr: 'musics.id_file_image' },
  { key: 'url_image', expr: fileUrl(base, 'files_image'), text: true, joined: true },
  { key: 'image_version', expr: 'files_image.version', joined: true },
  { key: 'id_file_music', expr: 'musics.id_file_music' },
  { key: 'url_music', expr: fileUrl(base, 'files_music'), text: true, joined: true },
  { key: 'music_version', expr: 'files_music.version', joined: true },
  { key: 'id_file_instrumental_music', expr: 'musics.id_file_instrumental_music' },
  {
    key: 'url_instrumental_music',
    expr: fileUrl(base, 'files_instrumental_music'),
    text: true,
    joined: true,
  },
  { key: 'instrumental_music_version', expr: 'files_instrumental_music.version', joined: true },
]

const selectOf = (columns: Column[]) => columns.map((c) => `${c.expr} AS "${c.key}"`).join(', ')

const find = (db: D1Database, table: string, pk: string, id: unknown) =>
  db.prepare(`SELECT * FROM ${table} WHERE ${pk} = ?`).bind(id).first<Row>()

// --------------------------------------------------------------- recursos

type Listing = { spec: ListSpec; pre: Where[] }

export type Resource = {
  path: string
  table: string
  pk: string
  fillable: string[]
  list: (base: string, query: URLSearchParams) => Listing
  show: (db: D1Database, base: string, id: string) => Promise<Row | null>
  /** MusicController@show devolve `{ data: null }` em vez de 404. */
  nullWhenMissing?: boolean
  validate: (v: Validator, body: Body, id: string | null) => Promise<void>
  defaults?: (body: Body) => Body
  /** Apagados junto, sem auditoria própria — a origem fazia isso por query direta. */
  cascade?: (db: D1Database, id: string) => D1PreparedStatement[]
}

const languageFilter = (column: string, query: URLSearchParams): Where[] => {
  const lang = query.get('id_language')
  return lang ? [{ sql: `${column} = ?`, params: [lang] }] : []
}

async function requireLanguage(v: Validator) {
  if (v.required('id_language')) {
    v.string('id_language')
    await v.exists('id_language', 'languages', 'id_language')
  }
}

const categories: Resource = {
  path: 'categories',
  table: 'categories',
  pk: 'id_category',
  fillable: ['name', 'slug', 'order', 'type', 'id_language'],
  list: (_base, query) => ({
    spec: {
      columns: [
        { key: 'id_category', expr: 'id_category' },
        { key: 'name', expr: 'name', text: true },
        { key: 'slug', expr: 'slug', text: true },
        { key: 'order', expr: '"order"' },
        { key: 'type', expr: 'type', text: true },
        { key: 'id_language', expr: 'id_language', text: true },
        { key: 'created_at', expr: 'created_at', filter: false },
        { key: 'updated_at', expr: 'updated_at', filter: false },
      ],
      from: 'categories',
      tiebreak: 'id_category ASC',
    },
    pre: languageFilter('id_language', query),
  }),
  show: (db, _base, id) => find(db, 'categories', 'id_category', id),
  validate: async (v, body, id) => {
    if (v.required('name')) v.string('name')
    if (v.required('slug')) {
      v.string('slug')
      await v.unique('slug', 'categories', 'slug', {
        ignore: { key: 'id_category', id },
        where: { column: 'id_language', value: body.id_language },
      })
    }
    await requireLanguage(v)
  },
  defaults: (body) => (filled(body, 'order') ? {} : { order: 0 }),
}

const categoriesAlbums: Resource = {
  path: 'categories_albums',
  table: 'categories_albums',
  pk: 'id_category_album',
  fillable: ['id_category', 'id_album', 'name', 'order', 'id_language'],
  list: (_base, query) => ({
    spec: {
      columns: [
        { key: 'id_category_album', expr: 'categories_albums.id_category_album' },
        { key: 'id_category', expr: 'categories_albums.id_category' },
        { key: 'category_name', expr: 'categories.name', text: true, joined: true },
        { key: 'id_album', expr: 'categories_albums.id_album' },
        { key: 'album_name', expr: 'albums.name', text: true, joined: true },
        { key: 'name', expr: 'categories_albums.name', text: true },
        { key: 'order', expr: 'categories_albums."order"' },
        { key: 'id_language', expr: 'categories_albums.id_language', text: true },
      ],
      from: 'categories_albums',
      decor:
        'LEFT JOIN categories ON categories_albums.id_category = categories.id_category ' +
        'LEFT JOIN albums ON categories_albums.id_album = albums.id_album',
      table: 'categories_albums',
      tiebreak: 'categories_albums.id_category_album ASC',
    },
    pre: languageFilter('categories_albums.id_language', query),
  }),
  show: async (db, _base, id) => {
    const row = await find(db, 'categories_albums', 'id_category_album', id)
    if (!row) return null
    const [category, album] = await Promise.all([
      find(db, 'categories', 'id_category', row.id_category),
      find(db, 'albums', 'id_album', row.id_album),
    ])
    return {
      ...row,
      category: category && presentRow(category),
      album: album && presentRow(album),
    }
  },
  validate: async (v, body, id) => {
    v.required('id_category')
    if (v.required('id_album')) {
      await v.unique('id_album', 'categories_albums', 'id_album', {
        ignore: { key: 'id_category_album', id },
        where: { column: 'id_category', value: body.id_category },
      })
    }
    await requireLanguage(v)
  },
  defaults: (body) => ({
    ...(filled(body, 'order') ? {} : { order: 0 }),
    ...(filled(body, 'name') ? {} : { name: '' }),
  }),
}

const albums: Resource = {
  path: 'albums',
  table: 'albums',
  pk: 'id_album',
  fillable: ['name', 'id_file_image', 'id_language', 'color'],
  list: (base, query) => {
    const slugs = query.get('categories_slug')
    const pre = languageFilter('albums.id_language', query)
    let from = 'albums'
    if (slugs !== null) {
      const list = slugs.split(',')
      from +=
        ' JOIN categories_albums ON categories_albums.id_album = albums.id_album' +
        ' JOIN categories ON categories.id_category = categories_albums.id_category'
      pre.push({ sql: `categories.slug IN (${list.map(() => '?').join(', ')})`, params: list })
    }
    return {
      spec: {
        columns: [
          { key: 'id_album', expr: 'albums.id_album' },
          { key: 'name', expr: 'albums.name', text: true },
          { key: 'id_file_image', expr: 'albums.id_file_image' },
          { key: 'url_image', expr: fileUrl(base, 'files'), text: true, joined: true },
          { key: 'image_version', expr: 'files.version', joined: true },
          { key: 'id_language', expr: 'albums.id_language', text: true },
          { key: 'color', expr: 'albums.color', text: true },
          { key: 'subtitle', expr: slugs === null ? "''" : 'categories_albums.name' },
          { key: 'order', expr: slugs === null ? "''" : 'categories_albums."order"' },
          { key: 'created_at', expr: 'albums.created_at' },
          { key: 'updated_at', expr: 'albums.updated_at' },
        ],
        from,
        decor: 'LEFT JOIN files ON albums.id_file_image = files.id_file',
        tiebreak: 'albums.id_album ASC',
        distinct: true,
      },
      pre,
    }
  },
  show: async (db, base, id) => {
    const album = await db
      .prepare(
        `SELECT albums.id_album, albums.name, albums.id_file_image, ${fileUrl(base, 'files')} AS url_image, ` +
          'files.version AS image_version, albums.id_language, albums.color, albums.created_at, albums.updated_at ' +
          'FROM albums LEFT JOIN files ON albums.id_file_image = files.id_file WHERE albums.id_album = ?',
      )
      .bind(id)
      .first<Row>()
    if (!album) return null

    const musics = await db
      .prepare(
        `SELECT musics.id_music, albums_musics.track, musics.name, ` +
          `${selectOf(musicFileColumns(base))}, ` +
          `musics.id_language, musics.created_at, musics.updated_at ` +
          `FROM musics LEFT JOIN albums_musics ON albums_musics.id_music = musics.id_music ${MUSIC_FILES} ` +
          'WHERE albums_musics.id_album = ? ORDER BY albums_musics.track, musics.id_music',
      )
      .bind(album.id_album)
      .all<Row>()
    return { ...album, musics: musics.results.map(presentRow) }
  },
  validate: async (v) => {
    if (v.required('name')) v.string('name')
    await requireLanguage(v)
  },
}

const musics: Resource = {
  path: 'musics',
  table: 'musics',
  pk: 'id_music',
  fillable: ['name', 'id_file_image', 'id_file_music', 'id_file_instrumental_music', 'id_language'],
  list: (base, query) => {
    const pre = languageFilter('musics.id_language', query)
    let from = 'musics'
    const album = query.get('id_album')
    if (album !== null) {
      from += ' JOIN albums_musics ON albums_musics.id_music = musics.id_music'
      pre.push({ sql: 'albums_musics.id_album = ?', params: [album] })
    }
    return {
      spec: {
        columns: [
          { key: 'id_music', expr: 'musics.id_music' },
          { key: 'name', expr: 'musics.name', text: true },
          ...musicFileColumns(base),
          { key: 'id_language', expr: 'musics.id_language', text: true },
          { key: 'created_at', expr: 'musics.created_at' },
          { key: 'updated_at', expr: 'musics.updated_at' },
        ],
        from,
        decor: MUSIC_FILES,
        table: 'musics',
        counted: true,
        tiebreak: 'musics.id_music ASC',
      },
      pre,
    }
  },
  nullWhenMissing: true,
  show: async (db, base, id) => {
    const music = await db
      .prepare(
        `SELECT musics.id_music, musics.name, musics.id_file_image, ${fileUrl(base, 'files_image')} AS url_image, ` +
          'files_image.version AS image_version, files_image.image_position AS image_position, ' +
          `musics.id_file_music, ${fileUrl(base, 'files_music')} AS url_music, files_music.version AS music_version, ` +
          `musics.id_file_instrumental_music, ${fileUrl(base, 'files_instrumental_music')} AS url_instrumental_music, ` +
          'files_instrumental_music.version AS instrumental_music_version, ' +
          `musics.id_language, musics.created_at, musics.updated_at FROM musics ${MUSIC_FILES} WHERE musics.id_music = ?`,
      )
      .bind(id)
      .first<Row>()
    if (!music) return null

    // Slide sem imagem própria herda a da música — a origem fazia isso no SQL.
    const lyric = await db
      .prepare(
        'SELECT lyrics.id_lyric, lyrics.id_music, lyrics.lyric, ' +
          'ifnull(lyrics.id_file_image, ?) AS id_file_image, ' +
          `ifnull(${fileUrl(base, 'files_image')}, ?) AS url_image, ` +
          'ifnull(files_image.version, ?) AS image_version, ' +
          'ifnull(files_image.image_position, ?) AS image_position, ' +
          'lyrics.time, lyrics.instrumental_time, lyrics.show_slide, lyrics."order", lyrics.id_language, ' +
          'lyrics.created_at, lyrics.updated_at ' +
          'FROM lyrics LEFT JOIN files AS files_image ON lyrics.id_file_image = files_image.id_file ' +
          'WHERE lyrics.id_music = ? ORDER BY lyrics."order"',
      )
      .bind(
        music.id_file_image ?? 0,
        music.url_image ?? '',
        music.image_version ?? 0,
        music.image_position ?? 0,
        music.id_music,
      )
      .all<Row>()
    return { ...music, lyric: lyric.results.map(presentRow) }
  },
  validate: async (v) => {
    if (v.required('name')) v.string('name')
    await requireLanguage(v)
  },
  cascade: (db, id) => [
    db.prepare('DELETE FROM lyrics WHERE id_music = ?').bind(id),
    db.prepare('DELETE FROM albums_musics WHERE id_music = ?').bind(id),
  ],
}

const albumsMusics: Resource = {
  path: 'albums_musics',
  table: 'albums_musics',
  pk: 'id_album_music',
  fillable: ['id_album', 'id_music', 'track', 'id_language'],
  list: (_base, query) => ({
    spec: {
      columns: [
        { key: 'id_album_music', expr: 'albums_musics.id_album_music' },
        { key: 'id_music', expr: 'albums_musics.id_music' },
        { key: 'music_name', expr: 'musics.name', text: true, joined: true },
        { key: 'id_album', expr: 'albums_musics.id_album' },
        { key: 'album_name', expr: 'albums.name', text: true, joined: true },
        { key: 'track', expr: 'albums_musics.track' },
        { key: 'id_language', expr: 'albums_musics.id_language', text: true },
      ],
      from: 'albums_musics',
      decor:
        'LEFT JOIN musics ON albums_musics.id_music = musics.id_music ' +
        'LEFT JOIN albums ON albums_musics.id_album = albums.id_album',
      table: 'albums_musics',
      counted: true,
      tiebreak: 'albums_musics.id_album_music ASC',
    },
    pre: languageFilter('albums_musics.id_language', query),
  }),
  show: async (db, _base, id) => {
    const row = await find(db, 'albums_musics', 'id_album_music', id)
    if (!row) return null
    const [album, music] = await Promise.all([
      find(db, 'albums', 'id_album', row.id_album),
      find(db, 'musics', 'id_music', row.id_music),
    ])
    return { ...row, album: album && presentRow(album), music: music && presentRow(music) }
  },
  validate: async (v, body, id) => {
    v.required('id_music')
    if (v.required('id_album')) {
      await v.unique('id_album', 'albums_musics', 'id_album', {
        ignore: { key: 'id_album_music', id },
        where: { column: 'id_music', value: body.id_music },
      })
    }
    await requireLanguage(v)
  },
}

const lyrics: Resource = {
  path: 'lyrics',
  table: 'lyrics',
  pk: 'id_lyric',
  fillable: [
    'id_music',
    'lyric',
    'aux_lyric',
    'id_file_image',
    'time',
    'instrumental_time',
    'show_slide',
    'order',
    'id_language',
  ],
  list: (_base, query) => {
    const pre = languageFilter('lyrics.id_language', query)
    let from = 'lyrics'
    const album = query.get('id_album')
    if (album !== null) {
      from += ' JOIN albums_musics ON albums_musics.id_music = lyrics.id_music'
      pre.push({ sql: 'albums_musics.id_album = ?', params: [album] })
    }
    return {
      spec: {
        columns: [
          { key: 'id_lyric', expr: 'lyrics.id_lyric' },
          { key: 'id_music', expr: 'lyrics.id_music' },
          { key: 'music', expr: 'musics.name', text: true, joined: true },
          { key: 'lyric', expr: 'lyrics.lyric', text: true },
          { key: 'aux_lyric', expr: 'lyrics.aux_lyric', text: true },
          { key: 'id_file_image', expr: 'lyrics.id_file_image' },
          { key: 'time', expr: 'lyrics.time' },
          { key: 'instrumental_time', expr: 'lyrics.instrumental_time' },
          { key: 'show_slide', expr: 'lyrics.show_slide' },
          { key: 'order', expr: 'lyrics."order"' },
          { key: 'id_language', expr: 'lyrics.id_language', text: true },
        ],
        from,
        decor: 'LEFT JOIN musics ON musics.id_music = lyrics.id_music',
        table: 'lyrics',
        counted: true,
        tiebreak: 'lyrics.id_lyric ASC',
      },
      pre,
    }
  },
  show: (db, base, id) =>
    db
      .prepare(
        'SELECT lyrics.id_lyric, lyrics.id_music, lyrics.lyric, lyrics.aux_lyric, lyrics.id_file_image, ' +
          `${fileUrl(base, 'files')} AS url_image, files.version AS image_version, ` +
          'lyrics.time, lyrics.instrumental_time, lyrics.show_slide, lyrics."order", lyrics.id_language, ' +
          'lyrics.created_at, lyrics.updated_at ' +
          'FROM lyrics LEFT JOIN files ON lyrics.id_file_image = files.id_file WHERE lyrics.id_lyric = ?',
      )
      .bind(id)
      .first<Row>(),
  validate: async (v) => {
    if (v.required('id_music')) await v.exists('id_music', 'musics', 'id_music')
    await requireLanguage(v)
  },
}

const RESOURCES = [categories, categoriesAlbums, albums, musics, albumsMusics, lyrics]

/** Os mesmos recursos, para a publicação gerar a camada REST a partir do banco. */
export const resources = { categories, categoriesAlbums, albums, musics, albumsMusics, lyrics }

// ----------------------------------------------------------- permissões

const PERMISSION_SUFFIX: Record<string, string> = {
  POST: '.insert',
  PUT: '.update',
  DELETE: '.delete',
}

/** AccessMiddleware da origem: administrador passa; os demais precisam da permissão da ação. */
const access =
  (permission: string): MiddlewareHandler<App> =>
  async (c, next) => {
    const user = c.var.user
    if (!user.is_admin) {
      const needed = permission + (PERMISSION_SUFFIX[c.req.method] ?? '')
      if (!(user.permissions ?? []).includes(needed)) {
        return c.json(
          {
            error: `Você não tem permissão para executar esta ação. Permissão necessária: "${needed}"`,
          },
          401,
        )
      }
    }
    await next()
  }

const confirmedPassword: MiddlewareHandler<App> = async (c, next) => {
  if (c.var.user.is_temporary_password) {
    return c.json({ error: 'Necessário alterar sua senha para executar esta ação!' }, 401)
  }
  await next()
}

// --------------------------------------------------------------- escrita

/** Valor como vai para o banco: booleano vira 0/1 e lista ou objeto vira JSON. */
function toColumn(value: unknown): unknown {
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value !== null && typeof value === 'object') return JSON.stringify(value)
  return value ?? null
}

function pick(body: Body, fillable: string[]): Row {
  const values: Row = {}
  for (const key of fillable) {
    if (key in body) values[key] = toColumn(body[key])
  }
  return values
}

/** Igualdade como a do Eloquent ao decidir se um atributo mudou: 5 e "5" são o mesmo valor. */
function same(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a ?? null) === (b ?? null)
  }
  return String(a) === String(b)
}

const ident = (name: string) => `"${name}"`

function audit(c: Ctx, table: string, action: Action, oldValues: Row, newValues: Row) {
  c.executionCtx.waitUntil(notifyTelegram(c.env, table, action, oldValues, newValues, c.var.user))
  return logStatement(c.env.DB, table, action, oldValues, newValues, c.var.user)
}

async function insertRow(c: Ctx, table: string, values: Row, logged: Row = {}): Promise<Row> {
  const now = sqlNow()
  const row = { ...values, created_at: now, updated_at: now }
  const columns = Object.keys(row)
  const created = await c.env.DB.prepare(
    `INSERT INTO ${table} (${columns.map(ident).join(', ')}) ` +
      `VALUES (${columns.map(() => '?').join(', ')}) RETURNING *`,
  )
    .bind(...Object.values(row))
    .first<Row>()
  if (!created) throw new Error(`insert em ${table} não devolveu a linha`)

  await audit(c, table, 'insert', {}, { ...created, ...logged }).run()
  return created
}

async function updateRow(
  c: Ctx,
  table: string,
  pk: string,
  before: Row,
  values: Row,
  logged: Row = {},
): Promise<void> {
  const dirty = Object.entries(values).filter(([key, value]) => !same(before[key], value))
  if (dirty.length === 0) return

  const oldValues: Row = {}
  const newValues: Row = {}
  for (const [key, value] of dirty) {
    oldValues[key] = key in logged ? logged[key] : before[key]
    newValues[key] = key in logged ? logged[key] : value
  }

  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE ${table} SET ${dirty.map(([key]) => `${ident(key)} = ?`).join(', ')}, updated_at = ? ` +
        `WHERE ${pk} = ?`,
    ).bind(...dirty.map(([, value]) => value), sqlNow(), before[pk]),
    audit(c, table, 'update', oldValues, newValues),
  ])
}

// ----------------------------------------------------------------- rotas

export const admin = new Hono<App>()

admin.onError((error, c) => {
  console.error('admin', error)
  return c.json({ error: 'Erro interno do servidor.', code: 500 }, 500)
})

admin.use('/admin/*', requireAuth, confirmedPassword)

for (const resource of RESOURCES) {
  const { path, table, pk } = resource
  const write = access(path)

  admin.get(`/admin/${path}`, async (c) => {
    const url = new URL(c.req.url)
    const { spec, pre } = resource.list(FILES_URL, url.searchParams)
    return c.json(await paginate(c.env.DB, spec, url, pre))
  })

  admin.get(`/admin/${path}/:id`, async (c) => {
    const row = await resource.show(c.env.DB, FILES_URL, c.req.param('id'))
    if (!row && !resource.nullWhenMissing) return c.json(NOT_FOUND, 404)
    return c.json({ data: row && presentRow(row) })
  })

  admin.post(`/admin/${path}`, write, async (c) => {
    const body = await readBody(c)
    const v = new Validator(body, c.env.DB)
    await resource.validate(v, body, null)
    if (v.failed) return c.json(validationError(v.messages), 422)

    const values = { ...pick(body, resource.fillable), ...resource.defaults?.(body) }
    const created = await insertRow(c, table, values)
    return c.json({ data: presentRow(created), message: CREATED }, 201)
  })

  admin.put(`/admin/${path}/:id`, write, async (c) => {
    const id = c.req.param('id')
    const body = await readBody(c)
    const v = new Validator(body, c.env.DB)
    await resource.validate(v, body, id)
    if (v.failed) return c.json(validationError(v.messages), 422)

    const before = await find(c.env.DB, table, pk, id)
    if (!before) return c.json(NOT_FOUND, 404)

    await updateRow(c, table, pk, before, pick(body, resource.fillable))
    const after = await find(c.env.DB, table, pk, id)
    return c.json({ data: after && presentRow(after), message: UPDATED })
  })

  admin.delete(`/admin/${path}/:id`, write, async (c) => {
    const id = c.req.param('id')
    const before = await find(c.env.DB, table, pk, id)
    if (!before) return c.json(NOT_FOUND, 404)

    await c.env.DB.batch([
      ...(resource.cascade?.(c.env.DB, id) ?? []),
      c.env.DB.prepare(`DELETE FROM ${table} WHERE ${pk} = ?`).bind(id),
      audit(c, table, 'delete', before, {}),
    ])
    return c.json({ message: DELETED })
  })
}

// --------------------------------------------------------------- arquivos

export const filesSpec = (base: string): ListSpec => ({
  columns: [
    { key: 'id_file', expr: 'files.id_file' },
    { key: 'name', expr: 'files.name', text: true },
    { key: 'type', expr: 'files.type', text: true },
    { key: 'size', expr: 'files.size' },
    { key: 'dir', expr: 'files.dir', text: true },
    { key: 'file_name', expr: 'files.file_name', text: true },
    { key: 'image_position', expr: 'files.image_position' },
    { key: 'duration', expr: 'files.duration' },
    { key: 'version', expr: 'files.version' },
    { key: 'created_at', expr: 'files.created_at', filter: false },
    { key: 'updated_at', expr: 'files.updated_at', filter: false },
    { key: 'url', expr: fileUrl(base, 'files'), filter: false },
  ],
  from: 'files',
  table: 'files',
  counted: true,
  tiebreak: 'files.id_file ASC',
})

admin.get('/admin/files', async (c) => {
  const url = new URL(c.req.url)
  const rawAlbum = url.searchParams.get('id_album')
  const pre: Where[] = []
  if (rawAlbum !== null) {
    // O controller PHP converte id_album para inteiro antes das cinco
    // subconsultas. O grupo preserva a intenção dos orWhereRaw da origem e faz
    // os demais filtros de Data::data valerem para todos os arquivos do álbum.
    const numeric = rawAlbum.trimStart().match(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i)
    const album = numeric ? Math.trunc(Number(numeric[0])) : 0
    pre.push({
      sql:
        '(files.id_file IN (SELECT albums.id_file_image FROM albums WHERE albums.id_album = ?) ' +
        'OR files.id_file IN (SELECT musics.id_file_music FROM musics JOIN albums_musics ON albums_musics.id_music = musics.id_music WHERE albums_musics.id_album = ?) ' +
        'OR files.id_file IN (SELECT musics.id_file_instrumental_music FROM musics JOIN albums_musics ON albums_musics.id_music = musics.id_music WHERE albums_musics.id_album = ?) ' +
        'OR files.id_file IN (SELECT lyrics.id_file_image FROM lyrics JOIN albums_musics ON albums_musics.id_music = lyrics.id_music WHERE albums_musics.id_album = ?) ' +
        'OR files.id_file IN (SELECT musics.id_file_image FROM musics JOIN albums_musics ON albums_musics.id_music = musics.id_music WHERE albums_musics.id_album = ?))',
      params: [album, album, album, album, album],
    })
  }
  return c.json(await paginate(c.env.DB, filesSpec(FILES_URL), url, pre))
})

admin.get('/admin/files/:id', async (c) => {
  const spec = filesSpec(FILES_URL)
  const row = await c.env.DB.prepare(
    `SELECT ${selectOf(spec.columns)} FROM files WHERE files.id_file = ?`,
  )
    .bind(c.req.param('id'))
    .first<Row>()
  return row ? c.json({ data: presentRow(row) }) : c.json(NOT_FOUND, 404)
})

admin.post('/admin/files', access('files'), async (c) => {
  try {
    const upload = await readMediaUpload(c.req.raw)
    const collision = await c.env.DB.prepare(
      'SELECT id_file FROM files WHERE dir = ? COLLATE NOCASE ' +
        'AND (file_name = ? COLLATE NOCASE OR name = ? COLLATE NOCASE) LIMIT 1',
    )
      .bind(upload.dir, upload.file.name, upload.file.name)
      .first()
    if (collision) throw new UploadError('Já existe um arquivo com esse nome nesta pasta.', 409)
    const config = await c.env.DB.prepare(
      "SELECT value FROM configs WHERE key = 'version_number'",
    ).first<{ value: string }>()
    const version = Number(config?.value)
    if (!Number.isSafeInteger(version) || version < 1)
      throw new UploadError('A versão do catálogo não está disponível.', 503)
    const now = sqlNow()
    const values = {
      name: upload.file.name,
      file_name: upload.file.name,
      type: upload.type,
      dir: upload.dir,
      size: upload.file.size,
      version,
      duration: null,
      image_position: null,
      created_at: now,
      updated_at: now,
    }
    const created = await storeMediaUpload(upload, c.env.FILES, c.env.FILES_ORIGINALS, async () => {
      const [result] = await c.env.DB.batch<Row>([
        c.env.DB.prepare(
          `INSERT INTO files (${Object.keys(values).map(ident).join(', ')}) VALUES (${Object.keys(
            values,
          )
            .map(() => '?')
            .join(', ')}) RETURNING *`,
        ).bind(...Object.values(values)),
        logStatement(c.env.DB, 'files', 'insert', {}, values, c.var.user),
      ])
      return result!.results[0]!
    })
    c.executionCtx.waitUntil(notifyTelegram(c.env, 'files', 'insert', {}, created, c.var.user))
    return c.json(
      {
        data: presentRow({ ...created, url: `${FILES_URL}${upload.dir}/${upload.file.name}` }),
        message: CREATED,
      },
      201,
    )
  } catch (error) {
    if (error instanceof UploadError) {
      const body =
        error.status === 422
          ? validationError({ [error.field]: [error.message] })
          : { error: error.message, code: error.status }
      return c.json(body, error.status)
    }
    throw error
  }
})

// --------------------------------------------------------------- usuários

const USER_FILLABLE = ['name', 'username', 'email', 'is_temporary_password', 'phone', 'permissions']

const usersSpec: ListSpec = {
  columns: [
    { key: 'id', expr: 'id' },
    { key: 'name', expr: 'name', text: true },
    { key: 'username', expr: 'username', text: true },
    { key: 'email', expr: 'email', text: true },
    { key: 'is_temporary_password', expr: 'is_temporary_password' },
    { key: 'is_admin', expr: 'is_admin' },
    { key: 'phone', expr: 'phone', text: true },
    { key: 'permissions', expr: 'permissions', text: true },
    { key: 'created_at', expr: 'created_at', filter: false },
    { key: 'updated_at', expr: 'updated_at', filter: false },
  ],
  from: 'users',
  tiebreak: 'id ASC',
}

const presentUserRow = (row: Row) => ({ ...presentUser(row as unknown as UserRow) })

async function validateUser(v: Validator, id: string | null, withPassword: boolean) {
  if (v.required('name')) v.string('name')
  if (v.required('username')) {
    v.string('username')
    await v.unique('username', 'users', 'username', { ignore: { key: 'id', id } })
  }
  if (v.required('email')) {
    v.string('email')
    v.email('email')
    await v.unique('email', 'users', 'email', { ignore: { key: 'id', id } })
  }
  if (withPassword && v.required('password')) {
    v.string('password')
    v.min('password', 6)
  }
}

admin.use('/admin/users', access('users'))
admin.use('/admin/users/*', access('users'))

admin.get('/admin/users', async (c) => {
  return c.json(await paginate(c.env.DB, usersSpec, new URL(c.req.url), [], presentUserRow))
})

admin.get('/admin/users/:id', async (c) => {
  const row = await find(c.env.DB, 'users', 'id', c.req.param('id'))
  return row ? c.json({ data: presentUserRow(row) }) : c.json(NOT_FOUND, 404)
})

admin.post('/admin/users', async (c) => {
  const body = await readBody(c)
  const v = new Validator(body, c.env.DB)
  await validateUser(v, null, true)
  if (v.failed) return c.json(validationError(v.messages), 422)

  const values = {
    ...pick(body, USER_FILLABLE),
    password: await hashPassword(String(body.password)),
    is_temporary_password: 1,
  }
  const created = await insertRow(c, 'users', values, { password: '***' })
  return c.json({ data: presentUserRow(created), message: CREATED }, 201)
})

admin.put('/admin/users/:id', async (c) => {
  const id = c.req.param('id')
  const body = await readBody(c)
  const changesPassword = filled(body, 'password')
  const v = new Validator(body, c.env.DB)
  await validateUser(v, id, changesPassword)
  if (v.failed) return c.json(validationError(v.messages), 422)

  const before = await find(c.env.DB, 'users', 'id', id)
  if (!before) return c.json(NOT_FOUND, 404)

  const values = pick(body, USER_FILLABLE)
  if (changesPassword) {
    if (before.is_admin) {
      return c.json({ error: 'A senha do administrador não pode ser alterada por esta rota!' }, 400)
    }
    values.password = await hashPassword(String(body.password))
    values.is_temporary_password = 1
  }
  if (before.is_admin) delete values.permissions

  await updateRow(c, 'users', 'id', before, values, { password: '***' })
  const after = await find(c.env.DB, 'users', 'id', id)
  return c.json({ data: after && presentUserRow(after), message: UPDATED })
})

admin.delete('/admin/users/:id', async (c) => {
  const before = await find(c.env.DB, 'users', 'id', c.req.param('id'))
  if (!before) return c.json(NOT_FOUND, 404)
  if (before.is_admin) return c.json({ error: 'Este usuário não pode ser excluído!' }, 400)

  const { password: _hidden, ...logged } = before
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(before.id),
    audit(c, 'users', 'delete', logged, {}),
  ])
  return c.json({ message: DELETED })
})
