import {
  applyD1Migrations,
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import worker from '../src/index.ts'
import {
  IMAGE_UPLOAD_LIMIT,
  MULTIPART_UPLOAD_LIMIT,
  readMediaUpload,
} from '../src/lib/admin/upload.ts'
import { sign } from '../src/lib/auth/jwt.ts'
import type { Bindings } from '../src/types.ts'

type Item = {
  id_file: number
  name: string
  file_name: string
  dir: string
  url: string
  size: number
  version: number
  duration: string | null
}
const tokens: string[] = []

async function call(
  path: string,
  init: RequestInit = {},
  token = tokens[0],
  bindings: Partial<Bindings> = {},
) {
  const headers = new Headers(init.headers)
  if (token) headers.set('authorization', `Bearer ${token}`)
  const context = createExecutionContext()
  const response = await worker.fetch(
    new Request(`https://api.test${path}`, { ...init, headers }),
    { ...env, ...bindings },
    context,
  )
  await waitOnExecutionContext(context)
  return response
}

function mp3() {
  const bytes = new Uint8Array(834)
  bytes.set([0xff, 0xfb, 0x90, 0], 0)
  bytes.set([0xff, 0xfb, 0x90, 0], 417)
  return bytes
}

function opus() {
  const bytes = new Uint8Array(47)
  bytes.set(new TextEncoder().encode('OggS'))
  bytes[5] = 2
  bytes[26] = 1
  bytes[27] = 19
  bytes.set(new TextEncoder().encode('OpusHead'), 28)
  bytes[36] = 1
  bytes[37] = 2
  return bytes
}

function bmp() {
  const bytes = new Uint8Array(58)
  const view = new DataView(bytes.buffer)
  bytes.set([66, 77])
  view.setUint32(2, bytes.length, true)
  view.setUint32(10, 54, true)
  view.setUint32(14, 40, true)
  view.setUint32(18, 1, true)
  view.setUint32(22, 1, true)
  view.setUint16(26, 1, true)
  view.setUint16(28, 24, true)
  return bytes
}

const png = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1XcAAAAASUVORK5CYII=',
  ),
  (c) => c.charCodeAt(0),
)

function form(name = 'Louvor.mp3', bytes: Uint8Array = mp3(), type = 'music', dir?: string) {
  const body = new FormData()
  body.set('file', new File([bytes], name, { type: 'application/octet-stream' }))
  body.set('type', type)
  if (type === 'music') body.set('id_language', 'pt')
  if (dir !== undefined) body.set('dir', dir)
  return body
}

const upload = (body: FormData, token = tokens[0], bindings?: Partial<Bindings>) =>
  call('/admin/files', { method: 'POST', body }, token, bindings)

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  await env.DB.prepare(
    "INSERT INTO configs (key, type, value) VALUES ('version_number', 'number', '185'), ('version', 'number', '1787701723')",
  ).run()
  for (const [index, admin, permissions, temporary] of [
    [1, 1, '[]', 0],
    [2, 0, '["files.insert"]', 0],
    [3, 0, '["musics.update"]', 0],
    [4, 1, '[]', 1],
  ] as const) {
    await env.DB.prepare(
      'INSERT INTO users (id, name, username, email, password, is_admin, permissions, is_temporary_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
      .bind(
        index,
        `User ${index}`,
        `user${index}`,
        `${index}@example.com`,
        'unused',
        admin,
        permissions,
        temporary,
      )
      .run()
    const now = Math.floor(Date.now() / 1000)
    tokens.push(
      await sign(
        {
          iss: 'https://api.test/auth/login',
          sub: String(index),
          id: index,
          name: `User ${index}`,
          username: `user${index}`,
          iat: now,
          nbf: now,
          exp: now + 3600,
          jti: crypto.randomUUID(),
        },
        env.JWT_SECRET,
      ),
    )
  }
})

describe('upload de arquivos do painel', () => {
  it('exige usuário autenticado, senha confirmada e permissão files.insert', async () => {
    for (const token of ['', tokens[2], tokens[3]]) {
      expect((await upload(form('Negado.mp3'), token)).status).toBe(401)
    }
    expect(await env.FILES.head('musics/pt/Avulsas/Negado.mp3')).toBeNull()
    expect(await env.FILES_ORIGINALS.head('musics/pt/Avulsas/Negado.mp3')).toBeNull()
  })

  it.each([
    ['Canção.MP3', mp3(), 'audio/mpeg'],
    ['Canção.opus', opus(), 'audio/ogg'],
  ] as const)(
    'preserva %s e publica os mesmos bytes com backup, versão 185 e preview',
    async (name, bytes, contentType) => {
      const response = await upload(form(name, bytes, 'music', 'Álbum 2026'), tokens[1])
      expect(response.status).toBe(201)
      const { data } = (await response.json()) as { data: Item }
      expect(data).toMatchObject({
        name,
        file_name: name,
        size: bytes.length,
        version: 185,
        duration: null,
        dir: '/musics/pt/Álbum 2026',
        url: `https://files.louvorja.com.br/musics/pt/Álbum 2026/${name}`,
      })
      const key = `${data.dir.slice(1)}/${name}`
      for (const bucket of [env.FILES, env.FILES_ORIGINALS]) {
        const object = await bucket.get(key)
        expect(new Uint8Array(await object!.arrayBuffer())).toEqual(bytes)
        expect(object!.httpMetadata?.contentType).toBe(contentType)
      }
      const lookup = await call(`/admin/files/${data.id_file}`)
      expect(((await lookup.json()) as { data: Item }).data).toEqual(data)
      expect(
        (await env.DB.prepare("SELECT value FROM configs WHERE key = 'version_number'").first<{
          value: string
        }>())!.value,
      ).toBe('185')
      expect(
        (await env.DB.prepare("SELECT value FROM configs WHERE key = 'version'").first<{
          value: string
        }>())!.value,
      ).toBe('1787701723')
      const log = await env.DB.prepare(
        "SELECT new_values FROM logs WHERE \"table\" = 'files' AND json_extract(new_values, '$.name') = ?",
      )
        .bind(name)
        .first<{ new_values: string }>()
      expect(JSON.parse(log!.new_values)).toMatchObject({
        name,
        file_name: name,
        version: 185,
        size: bytes.length,
      })
    },
  )

  it('aceita MP3 com ID3 e idioma es, sem descartar os metadados originais', async () => {
    const bytes = new Uint8Array(10 + mp3().length)
    bytes.set([73, 68, 51, 4, 0, 0, 0, 0, 0, 0])
    bytes.set(mp3(), 10)
    const body = form('Canción.mp3', bytes)
    body.set('id_language', 'es')
    expect((await upload(body)).status).toBe(201)
    expect(
      new Uint8Array(await (await env.FILES.get('musics/es/Avulsas/Canción.mp3'))!.arrayBuffer()),
    ).toEqual(bytes)
  })

  it.each([
    ['Capa.bmp', bmp(), 'image_album', 'covers'],
    ['Fundo.png', png, 'image_music', 'images'],
    ['Fundo.jpeg', new Uint8Array([255, 216, 255, 224, 0, 2, 255, 217]), 'image_music', 'images'],
  ] as const)('preserva imagem %s no diretório correspondente', async (name, bytes, type, dir) => {
    const response = await upload(form(name, bytes, type))
    expect(response.status).toBe(201)
    expect(((await response.json()) as { data: Item }).data).toMatchObject({
      name,
      file_name: name,
      dir: `/${dir}`,
      size: bytes.length,
    })
    expect(
      new Uint8Array(await (await env.FILES_ORIGINALS.get(`${dir}/${name}`))!.arrayBuffer()),
    ).toEqual(bytes)
  })

  it.each([
    '../Fora.mp3',
    'Sub\\Fora.mp3',
    'CON.mp3',
    'LPT1.mp3',
    'Música#1.mp3',
    'Música%20.mp3',
    'Música.mp3.',
    'Música.mp3 ',
  ])('recusa nome inseguro %s', async (name) => {
    expect((await upload(form(name))).status).toBe(422)
  })

  it.each(['../fora', '/absoluto', 'album//pasta', 'album/..', 'CON', 'pasta\\filha', 'álbum#1'])(
    'recusa pasta insegura %s',
    async (dir) => {
      expect((await upload(form('Invalido.mp3', mp3(), 'music', dir))).status).toBe(422)
    },
  )

  it('valida campos, arquivo único, idioma, tipo e limites antes de escrever', async () => {
    const missingLanguage = form()
    missingLanguage.delete('id_language')
    const invalidLanguage = form()
    invalidLanguage.set('id_language', 'en')
    const repeated = form()
    repeated.append('file', new File([mp3()], 'Outro.mp3'))
    const unexpected = form()
    unexpected.set('version', '999')
    const extraDirectory = form('Foto.png', png, 'image_music', 'covers')
    const tooLarge = form('Grande.bmp', new Uint8Array(IMAGE_UPLOAD_LIMIT + 1), 'image_album')
    for (const body of [
      missingLanguage,
      invalidLanguage,
      repeated,
      unexpected,
      extraDirectory,
      form('empty.mp3', new Uint8Array()),
      form('foo.exe', mp3()),
      form('mp3', mp3()),
      form('opus', opus()),
      form('foo.jpg', png, 'image_album'),
      form('wrong.mp3', opus()),
      form('wrong.opus', mp3()),
      form('wrong.bmp', png, 'image_album'),
      form('fake.mp3', new TextEncoder().encode('ID3invalid')),
      form('fake.opus', new TextEncoder().encode('OggSVorbis')),
    ]) {
      const response = await upload(body)
      expect(response.status).toBe(422)
      expect(await response.json()).toHaveProperty('messages')
    }
    expect((await upload(tooLarge)).status).toBe(413)
    expect(
      (
        await call('/admin/files', {
          method: 'POST',
          body: '{}',
          headers: { 'content-type': 'application/json' },
        })
      ).status,
    ).toBe(422)
    expect(
      (
        await call('/admin/files', {
          method: 'POST',
          body: 'x',
          headers: {
            'content-type': 'multipart/form-data; boundary=x',
            'content-length': String(MULTIPART_UPLOAD_LIMIT + 1),
          },
        })
      ).status,
    ).toBe(413)
  })

  it('limita o stream real mesmo sem Content-Length e cancela a leitura', async () => {
    let canceled = false
    const chunk = new Uint8Array(64 * 1024)
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk)
      },
      cancel() {
        canceled = true
      },
    })
    await expect(
      readMediaUpload(
        new Request('https://api.test/admin/files', {
          method: 'POST',
          headers: { 'content-type': 'multipart/form-data; boundary=x' },
          body,
        }),
      ),
    ).rejects.toMatchObject({ status: 413 })
    expect(canceled).toBe(true)
  })

  it('não sobrescreve objeto já existente em nenhum bucket', async () => {
    for (const [bucket, name] of [
      [env.FILES, 'Publicado.mp3'],
      [env.FILES_ORIGINALS, 'Original.mp3'],
    ] as const) {
      const key = `musics/pt/Avulsas/${name}`
      await bucket.put(key, 'preservado')
      expect((await upload(form(name))).status).toBe(409)
      expect(await (await bucket.get(key))!.text()).toBe('preservado')
      const other = bucket === env.FILES ? env.FILES_ORIGINALS : env.FILES
      expect(await other.head(key)).toBeNull()
    }
  })

  it('protege nomes originais já convertidos e colisões sem diferenciar maiúsculas', async () => {
    await env.DB.prepare(
      "INSERT INTO files (name, file_name, dir, type, size, version) VALUES ('Sol.mp3', 'Sol.opus', '/musics/pt/Avulsas', 'music', 123, 185)",
    ).run()
    expect((await upload(form('sol.MP3'))).status).toBe(409)
    expect((await upload(form('SOL.OPUS', opus()))).status).toBe(409)
    expect(await env.FILES.head('musics/pt/Avulsas/sol.MP3')).toBeNull()
  })

  it('uploads simultâneos do mesmo nome criam apenas uma entrada e preservam os bytes', async () => {
    const responses = await Promise.all([
      upload(form('Concorrente.mp3')),
      upload(form('Concorrente.mp3')),
    ])
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409])
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM files WHERE file_name = 'Concorrente.mp3'",
    ).first<{ total: number }>()
    expect(count!.total).toBe(1)
    for (const bucket of [env.FILES, env.FILES_ORIGINALS])
      expect(
        new Uint8Array(
          await (await bucket.get('musics/pt/Avulsas/Concorrente.mp3'))!.arrayBuffer(),
        ),
      ).toEqual(mp3())
  })

  it('falha no D1 remove somente os dois objetos novos e não grava log nem catálogo', async () => {
    await env.FILES_ORIGINALS.put('musics/pt/Avulsas/Anterior.mp3', 'backup anterior')
    await env.DB.exec(
      "CREATE TRIGGER reject_upload BEFORE INSERT ON files WHEN NEW.name = 'Falha.mp3' BEGIN SELECT RAISE(ABORT, 'falha simulada'); END;",
    )
    try {
      expect((await upload(form('Falha.mp3'))).status).toBe(500)
      for (const bucket of [env.FILES, env.FILES_ORIGINALS])
        expect(await bucket.head('musics/pt/Avulsas/Falha.mp3')).toBeNull()
      expect(
        await env.DB.prepare("SELECT id_file FROM files WHERE name = 'Falha.mp3'").first(),
      ).toBeNull()
      expect(
        await env.DB.prepare("SELECT id_log FROM logs WHERE new_values LIKE '%Falha.mp3%'").first(),
      ).toBeNull()
      expect(await (await env.FILES_ORIGINALS.get('musics/pt/Avulsas/Anterior.mp3'))!.text()).toBe(
        'backup anterior',
      )
    } finally {
      await env.DB.exec('DROP TRIGGER reject_upload')
    }
  })

  it('falha ao publicar remove o backup criado pela operação e não cadastra o arquivo', async () => {
    const unavailable = {
      put: async () => {
        throw new Error('falha R2 simulada')
      },
    } as unknown as R2Bucket
    expect(
      (await upload(form('SemPublicacao.mp3'), tokens[0], { FILES: unavailable })).status,
    ).toBe(500)
    expect(await env.FILES_ORIGINALS.head('musics/pt/Avulsas/SemPublicacao.mp3')).toBeNull()
    expect(
      await env.DB.prepare("SELECT id_file FROM files WHERE name = 'SemPublicacao.mp3'").first(),
    ).toBeNull()
  })

  it('cadastro e auditoria são atômicos: falha no log desfaz a linha e os objetos novos', async () => {
    await env.DB.exec(
      "CREATE TRIGGER reject_upload_log BEFORE INSERT ON logs WHEN NEW.new_values LIKE '%SemLog.mp3%' BEGIN SELECT RAISE(ABORT, 'falha de log simulada'); END;",
    )
    try {
      expect((await upload(form('SemLog.mp3'))).status).toBe(500)
      expect(
        await env.DB.prepare("SELECT id_file FROM files WHERE name = 'SemLog.mp3'").first(),
      ).toBeNull()
      for (const bucket of [env.FILES, env.FILES_ORIGINALS])
        expect(await bucket.head('musics/pt/Avulsas/SemLog.mp3')).toBeNull()
    } finally {
      await env.DB.exec('DROP TRIGGER reject_upload_log')
    }
  })
})
