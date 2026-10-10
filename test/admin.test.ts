import {
  applyD1Migrations,
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import worker from '../src/index.ts'
import { hashPassword } from '../src/lib/auth/password.ts'

type Json = Record<string, any>

const call = async (path: string, init: RequestInit & { token?: string; json?: unknown } = {}) => {
  const headers = new Headers(init.headers)
  if (init.token) headers.set('Authorization', `Bearer ${init.token}`)
  if (init.json !== undefined) headers.set('Content-Type', 'application/json')
  const ctx = createExecutionContext()
  const res = await worker.fetch(
    new Request(`https://api.test${path}`, {
      ...init,
      headers,
      body: init.json === undefined ? init.body : JSON.stringify(init.json),
    }),
    env,
    ctx,
  )
  await waitOnExecutionContext(ctx)
  return res
}

const login = async (username: string, password: string) => {
  const res = await call('/auth/login', { method: 'POST', json: { username, password } })
  return (await res.json()) as Json
}

const logs = async (table: string) =>
  (await env.DB.prepare('SELECT * FROM logs WHERE "table" = ? ORDER BY id_log').bind(table).all())
    .results as Json[]

let admin: string
let editor: string

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)

  const now = '2022-12-20 16:46:28'
  const senha = await hashPassword('Senha@123')
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO languages VALUES ('pt', 'Português', ?, ?), ('es', 'Espanhol', ?, ?)",
    ).bind(now, now, now, now),
    env.DB.prepare(
      'INSERT INTO files (id_file, name, type, size, dir, file_name, image_position, duration, version, created_at, updated_at) VALUES ' +
        "(1, 'capa.bmp', 'image_album', 10, '/covers', 'capa.jpg', NULL, NULL, 1, ?1, ?1), " +
        "(2, 'fundo.jpg', 'image_music', 20, '/images', 'fundo.jpg', 3, NULL, 1, ?1, ?1), " +
        "(3, 'Sol.mp3', 'music', 30, '/musics/pt/Álbum Um', 'Sol.opus', NULL, '00:02:17', 1, ?1, ?1), " +
        "(4, 'Sol PB.mp3', 'music', 40, '/musics/pt/Álbum Um', 'Sol PB.opus', NULL, '00:02:17', 1, ?1, ?1)",
    ).bind(now),
    env.DB.prepare(
      'INSERT INTO albums (id_album, name, id_file_image, color, id_language, created_at, updated_at) VALUES ' +
        "(1, 'Álbum Um', 1, '#C2442D', 'pt', ?1, ?1), (2, 'Outro Álbum', NULL, '', 'pt', ?1, ?1)",
    ).bind(now),
    env.DB.prepare(
      'INSERT INTO categories (id_category, name, slug, "order", type, id_language, created_at, updated_at) VALUES ' +
        "(1, 'Diversas', 'misc', 20, 'collection', 'pt', ?1, ?1), (2, 'Varios', 'misc', 20, 'collection', 'es', ?1, ?1)",
    ).bind(now),
    env.DB.prepare(
      "INSERT INTO categories_albums (id_category_album, id_category, id_album, name, \"order\", id_language) VALUES (1, 1, 1, '1992', 1, 'pt')",
    ),
    env.DB.prepare(
      'INSERT INTO musics (id_music, name, id_file_image, id_file_music, id_file_instrumental_music, id_language, created_at, updated_at) VALUES ' +
        "(1, 'Nosso Sol é Jesus', 2, 3, 4, 'pt', ?1, ?1), " +
        "(7, 'Coração Aberto', 2, 3, NULL, 'pt', ?1, ?1), " +
        "(9, 'árvore da Vida', NULL, NULL, NULL, 'pt', ?1, ?1), " +
        "(20, 'Sol de Justicia', NULL, NULL, NULL, 'es', ?1, ?1)",
    ).bind(now),
    env.DB.prepare(
      'INSERT INTO lyrics (id_lyric, id_music, lyric, aux_lyric, id_file_image, time, instrumental_time, show_slide, "order", id_language) VALUES ' +
        "(10, 1, 'O nosso sol', NULL, NULL, '00:00:08', '00:00:00', 1, 1, 'pt'), " +
        "(11, 1, 'Veio iluminar', NULL, 1, '00:00:17', '00:00:19', 1, 2, 'pt'), " +
        "(12, 7, 'De coração', NULL, NULL, '00:00:05', '00:00:00', 1, 1, 'pt')",
    ),
    env.DB.prepare(
      "INSERT INTO albums_musics (id_album_music, id_album, id_music, track, id_language) VALUES (1, 1, 1, 1, 'pt'), (2, 1, 7, 2, 'pt')",
    ),
    env.DB.prepare(
      'INSERT INTO users (id, name, username, email, password, is_temporary_password, is_admin, permissions, created_at, updated_at) VALUES ' +
        "(1, 'Maria Admin', 'admin', 'admin@louvorja.com.br', ?1, 0, 1, NULL, ?2, ?2), " +
        "(2, 'João da Silva Editor', 'editor', 'editor@louvorja.com.br', ?1, 0, 0, '[\"musics.update\"]', ?2, ?2), " +
        "(3, 'Novato', 'novato', 'novato@louvorja.com.br', ?1, 1, 0, NULL, ?2, ?2)",
    ).bind(senha, now),
  ])

  admin = (await login('admin', 'Senha@123')).token
  editor = (await login('editor', 'Senha@123')).token
})

describe('auth', () => {
  it('entrega token e usuário sem a senha', async () => {
    const body = await login('ADMIN', 'Senha@123')
    expect(body.token.split('.')).toHaveLength(3)
    expect(body.user).toMatchObject({
      id: 1,
      username: 'admin',
      is_admin: true,
      is_temporary_password: false,
      permissions: null,
      initials: 'MA',
      short_name: 'Maria Admin',
      created_at: '2022-12-20T16:46:28.000000Z',
    })
    expect(body.user.password).toBeUndefined()
  })

  it('recusa senha errada e usuário inexistente com a mesma resposta', async () => {
    for (const [user, pass] of [
      ['admin', 'errada'],
      ['ninguem', 'Senha@123'],
    ] as const) {
      const res = await call('/auth/login', {
        method: 'POST',
        json: { username: user, password: pass },
      })
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'Login ou senha incorretos.' })
    }
  })

  it('valida no formato que o painel lê', async () => {
    const res = await call('/auth/login', { method: 'POST', json: { username: '' } })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({
      error: 'O campo nome de usuário é obrigatório.\nO campo senha é obrigatório.',
      messages: {
        username: ['O campo nome de usuário é obrigatório.'],
        password: ['O campo senha é obrigatório.'],
      },
      code: 422,
    })
  })

  it('exige token nas rotas do painel', async () => {
    for (const token of [undefined, 'lixo', `${admin}x`]) {
      const res = await call('/admin/musics', { token })
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'Token inválido ou expirado.', code: 401 })
    }
  })

  it('não deixa resposta autenticada ir para o cache e libera escrita no preflight', async () => {
    const res = await call('/auth/me', { token: admin })
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(((await res.json()) as Json).username).toBe('admin')

    const preflight = await call('/admin/musics/1', { method: 'OPTIONS' })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-methods')).toContain('PUT')
    expect(preflight.headers.get('access-control-allow-headers')).toContain('Authorization')
  })

  it('renova o token e encerra o antigo no logout', async () => {
    const { token } = await login('editor', 'Senha@123')
    const refreshed = (await (
      await call('/auth/refresh-token', { method: 'POST', token, json: [] })
    ).json()) as Json
    expect(refreshed.user.username).toBe('editor')
    expect(refreshed.token).not.toBe(token)
    expect((await call('/auth/me', { token: refreshed.token })).status).toBe(200)

    const out = await call('/auth/logout', { method: 'POST', token: refreshed.token })
    expect(await out.json()).toEqual([])
    expect((await call('/auth/me', { token: refreshed.token })).status).toBe(401)
  })

  it('senha provisória bloqueia o painel até ser trocada', async () => {
    const { token, user } = await login('novato', 'Senha@123')
    expect(user.is_temporary_password).toBe(true)

    const blocked = await call('/admin/musics', { token })
    expect(blocked.status).toBe(401)
    expect(await blocked.json()).toEqual({
      error: 'Necessário alterar sua senha para executar esta ação!',
    })

    const fraca = await call('/auth/change-password', {
      method: 'POST',
      token,
      json: { current_password: 'Senha@123', new_password: 'abc', new_password_confirmation: 'x' },
    })
    expect(fraca.status).toBe(422)
    expect(((await fraca.json()) as Json).messages.new_password).toEqual([
      'A nova senha deve ter no mínimo 8 caracteres.',
      'A confirmação da nova senha não coincide.',
      'A nova senha deve conter pelo menos uma letra, um número e um caractere especial.',
    ])

    const errada = await call('/auth/change-password', {
      method: 'POST',
      token,
      json: {
        current_password: 'nao',
        new_password: 'Nova@1234',
        new_password_confirmation: 'Nova@1234',
      },
    })
    expect(errada.status).toBe(400)

    const ok = await call('/auth/change-password', {
      method: 'POST',
      token,
      json: {
        current_password: 'Senha@123',
        new_password: 'Nova@1234',
        new_password_confirmation: 'Nova@1234',
      },
    })
    expect(await ok.json()).toEqual({ message: 'Senha alterada com sucesso.' })

    // A troca encerra a sessão, como na origem.
    expect((await call('/auth/me', { token })).status).toBe(401)
    const again = await login('novato', 'Nova@1234')
    expect(again.user.is_temporary_password).toBe(false)
    expect((await call('/admin/musics', { token: again.token })).status).toBe(200)

    const log = (await logs('users')).at(-1) as Json
    expect(log.action).toBe('update')
    expect(log.new_values).not.toContain('pbkdf2')
  })
})

describe('listagem', () => {
  it('devolve o envelope de paginação do Laravel', async () => {
    const body = (await (
      await call('/admin/musics?limit=2&sort_by=id_music', { token: admin })
    ).json()) as Json
    expect(body).toMatchObject({
      current_page: 1,
      from: 1,
      to: 2,
      total: 4,
      per_page: 2,
      last_page: 2,
      path: 'https://api.test/admin/musics',
      first_page_url: 'https://api.test/admin/musics?page=1',
      next_page_url: 'https://api.test/admin/musics?page=2',
      prev_page_url: null,
    })
    expect(body.links.map((l: Json) => l.label)).toEqual([
      '&laquo; Previous',
      '1',
      '2',
      'Next &raquo;',
    ])
    expect(body.data.map((m: Json) => m.id_music)).toEqual([1, 7])
    expect(body.data[0]).toEqual({
      id_music: 1,
      name: 'Nosso Sol é Jesus',
      id_file_image: 2,
      url_image: 'https://api.test/file/images/fundo.jpg',
      image_version: 1,
      id_file_music: 3,
      url_music: 'https://api.test/file/musics/pt/Álbum Um/Sol.opus',
      music_version: 1,
      id_file_instrumental_music: 4,
      url_instrumental_music: 'https://api.test/file/musics/pt/Álbum Um/Sol PB.opus',
      instrumental_music_version: 1,
      id_language: 'pt',
      created_at: '2022-12-20T16:46:28.000000Z',
      updated_at: '2022-12-20T16:46:28.000000Z',
    })
  })

  it('página além da última vem vazia, sem from nem to', async () => {
    const body = (await (
      await call('/admin/musics?limit=2&page=9', { token: admin })
    ).json()) as Json
    expect(body).toMatchObject({ current_page: 9, data: [], from: null, to: null, total: 4 })
  })

  it('sem limit a página tem 15 linhas; negativo é o "traga tudo" do painel', async () => {
    for (const query of ['', '?limit=0', '?limit=abc']) {
      const body = (await (await call(`/admin/musics${query}`, { token: admin })).json()) as Json
      expect(body.per_page).toBe(15)
    }

    // É como o painel carrega as listas de seleção.
    const body = (await (
      await call('/admin/musics?limit=-1&sort_by=name', { token: admin })
    ).json()) as Json
    expect(body.per_page).toBe(9999)
    // Ordenação sem distinguir caixa nem acento, como no MySQL de origem.
    expect(body.data.map((m: Json) => m.name)).toEqual([
      'árvore da Vida',
      'Coração Aberto',
      'Nosso Sol é Jesus',
      'Sol de Justicia',
    ])
  })

  it('ignora ordenação e filtro que não são colunas da listagem', async () => {
    const sort = encodeURIComponent('name; DROP TABLE musics--')
    const body = (await (
      await call(`/admin/musics?sort_by=${sort}&senha=like:*a*&limit=50`, { token: admin })
    ).json()) as Json
    expect(body.total).toBe(4)

    // O valor do filtro é sempre parâmetro, nunca SQL.
    const valor = encodeURIComponent("or:1' OR '1'='1")
    const filtrado = (await (
      await call(`/admin/musics?id_music=${valor}`, { token: admin })
    ).json()) as Json
    expect(filtrado.total).toBe(0)
    expect((await env.DB.prepare('SELECT count(*) AS n FROM musics').first<Json>())?.n).toBe(4)
  })

  it('não deixa filtrar usuários pelo hash da senha', async () => {
    const q = encodeURIComponent('like:pbkdf2*')
    const body = (await (await call(`/admin/users?password=${q}`, { token: admin })).json()) as Json
    expect(body.total).toBe(3)
  })

  it('busca ignora caixa e acento', async () => {
    const q = encodeURIComponent('like:*CORACAO*')
    const body = (await (await call(`/admin/musics?name=${q}`, { token: admin })).json()) as Json
    expect(body.data.map((m: Json) => m.id_music)).toEqual([7])
  })

  it('filtra por idioma e ordena em ordem decrescente', async () => {
    const body = (await (
      await call('/admin/musics?id_language=pt&sort_by=id_music.desc', { token: admin })
    ).json()) as Json
    expect(body.data.map((m: Json) => m.id_music)).toEqual([9, 7, 1])
  })

  it('a busca do painel vira uma corrente de OR, na ordem das colunas', async () => {
    // É o que o DataTable manda: número em colunas numéricas, texto nas demais.
    const params = new URLSearchParams({
      id_music: 'or:0',
      name: 'orlike:*sol*',
      id_language: 'orlike:*sol*',
    })
    const body = (await (
      await call(`/admin/musics?${params}&sort_by=id_music`, { token: admin })
    ).json()) as Json
    expect(body.data.map((m: Json) => m.id_music)).toEqual([1, 20])
  })

  it('lista as letras de uma música na ordem dos slides', async () => {
    const body = (await (
      await call('/admin/lyrics?id_music=1&sort_by=order', { token: admin })
    ).json()) as Json
    expect(body.data.map((l: Json) => l.id_lyric)).toEqual([10, 11])
    expect(body.data[0]).toMatchObject({
      music: 'Nosso Sol é Jesus',
      time: '00:00:08',
      show_slide: 1,
    })
  })

  it('serve a biblioteca de arquivos por tipo', async () => {
    const body = (await (
      await call('/admin/files?type=music&sort_by=id_file.desc&limit=50', { token: admin })
    ).json()) as Json
    expect(body.data.map((f: Json) => f.id_file)).toEqual([4, 3])
    expect(body.data[0].url).toBe('https://api.test/file/musics/pt/Álbum Um/Sol PB.opus')

    const one = (await (await call('/admin/files/1', { token: admin })).json()) as Json
    expect(one.data).toMatchObject({
      id_file: 1,
      name: 'capa.bmp',
      url: 'https://api.test/file/covers/capa.jpg',
    })
  })
})

describe('custo de leitura', () => {
  const stored = async (name: string) =>
    (await env.DB.prepare('SELECT total FROM row_counts WHERE name = ?').bind(name).first<Json>())
      ?.total
  const real = async (table: string) =>
    (await env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first<Json>())?.n

  it('o total guardado acompanha inclusões e exclusões, até em cascata', async () => {
    for (const table of ['musics', 'lyrics', 'files', 'albums_musics']) {
      expect(await stored(table)).toBe(await real(table))
    }

    const criada = (await (
      await call('/admin/musics', {
        method: 'POST',
        token: admin,
        json: { name: 'Temporária', id_language: 'pt' },
      })
    ).json()) as Json
    const id = criada.data.id_music
    await call('/admin/lyrics', {
      method: 'POST',
      token: admin,
      json: {
        id_music: id,
        lyric: 'x',
        time: '00:00:01',
        instrumental_time: '00:00:00',
        show_slide: 1,
        order: 1,
        id_language: 'pt',
      },
    })
    expect(await stored('musics')).toBe(await real('musics'))
    expect(await stored('lyrics')).toBe(await real('lyrics'))

    const lista = (await (await call('/admin/lyrics?limit=1', { token: admin })).json()) as Json
    expect(lista.total).toBe(await real('lyrics'))

    // Excluir a música apaga as letras dela por tabela; o gatilho conta cada uma.
    await call(`/admin/musics/${id}`, { method: 'DELETE', token: admin })
    expect(await stored('musics')).toBe(await real('musics'))
    expect(await stored('lyrics')).toBe(await real('lyrics'))
  })

  it('com filtro o total é contado de verdade', async () => {
    const body = (await (await call('/admin/lyrics?id_music=1', { token: admin })).json()) as Json
    expect(body.total).toBe(2)
  })

  it('a caixa de seleção do painel pede só o código e o nome', async () => {
    const body = (await (
      await call('/admin/musics?sort_by=name&limit=-1&only=id_music,name', { token: admin })
    ).json()) as Json
    expect(body.total).toBe(await real('musics'))
    expect(Object.keys(body.data[0])).toEqual(['id_music', 'name'])

    // Coluna desconhecida em `only` não derruba nem esvazia a resposta.
    const tudo = (await (await call('/admin/musics?only=nada', { token: admin })).json()) as Json
    expect(Object.keys(tudo.data[0])).toContain('url_music')
  })

  it('juntar depois de paginar devolve as mesmas linhas, na mesma ordem', async () => {
    const pagina = (await (
      await call('/admin/lyrics?limit=2&page=2&sort_by=id_lyric.desc', { token: admin })
    ).json()) as Json
    const todas = (await (
      await call('/admin/lyrics?limit=-1&sort_by=id_lyric.desc', { token: admin })
    ).json()) as Json
    expect(pagina.data).toEqual(todas.data.slice(2, 4))
    expect(pagina.data[0].music).toBeTypeOf('string')
  })
})

describe('registro único', () => {
  it('música traz as letras, e o slide sem imagem herda a da música', async () => {
    const { data } = (await (await call('/admin/musics/1', { token: admin })).json()) as Json
    expect(data).toMatchObject({
      id_music: 1,
      image_position: 3,
      url_image: 'https://api.test/file/images/fundo.jpg',
    })
    expect(data.lyric).toHaveLength(2)
    expect(data.lyric[0]).toMatchObject({
      id_lyric: 10,
      id_file_image: 2,
      url_image: 'https://api.test/file/images/fundo.jpg',
      image_position: 3,
    })
    expect(data.lyric[1]).toMatchObject({
      id_file_image: 1,
      url_image: 'https://api.test/file/covers/capa.jpg',
    })
  })

  it('música inexistente devolve data nula, como na origem', async () => {
    const res = await call('/admin/musics/999', { token: admin })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: null })
  })

  it('os demais recursos devolvem 404', async () => {
    const res = await call('/admin/albums/999', { token: admin })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Registro não encontrado!' })
  })

  it('vínculo álbum-música traz os dois lados aninhados', async () => {
    const { data } = (await (await call('/admin/albums_musics/1', { token: admin })).json()) as Json
    expect(data).toMatchObject({ id_album_music: 1, track: 1 })
    expect(data.album.name).toBe('Álbum Um')
    expect(data.music.name).toBe('Nosso Sol é Jesus')
  })

  it('álbum traz as músicas na ordem das faixas', async () => {
    const { data } = (await (await call('/admin/albums/1', { token: admin })).json()) as Json
    expect(data.url_image).toBe('https://api.test/file/covers/capa.jpg')
    expect(data.musics.map((m: Json) => [m.track, m.id_music])).toEqual([
      [1, 1],
      [2, 7],
    ])
  })
})

describe('escrita', () => {
  it('cria, altera e registra na auditoria só o que mudou', async () => {
    const created = await call('/admin/musics', {
      method: 'POST',
      token: admin,
      json: { name: 'Nova Canção', id_language: 'pt', id_file_music: 3, limit: 10 },
    })
    expect(created.status).toBe(201)
    const { data, message } = (await created.json()) as Json
    expect(message).toBe('Registro cadastrado com sucesso!')
    expect(data).toMatchObject({ name: 'Nova Canção', id_language: 'pt', id_file_music: 3 })
    expect(data.id_music).toBeGreaterThan(20)

    const updated = await call(`/admin/musics/${data.id_music}`, {
      method: 'PUT',
      token: admin,
      // O painel devolve o formulário inteiro, inclusive campos que não são da tabela.
      json: { ...data, name: 'Canção Nova', url_music: 'ignorado' },
    })
    expect(((await updated.json()) as Json).data.name).toBe('Canção Nova')

    // Salvar de novo sem mudar nada não gera linha de auditoria.
    await call(`/admin/musics/${data.id_music}`, {
      method: 'PUT',
      token: admin,
      json: { ...data, name: 'Canção Nova' },
    })

    const trilha = (await logs('musics')).filter((l) => JSON.stringify(l).includes('Can'))
    expect(trilha.map((l) => l.action)).toEqual(['insert', 'update'])
    expect(JSON.parse(trilha[1]?.old_values)).toEqual({ name: 'Nova Canção' })
    expect(JSON.parse(trilha[1]?.new_values)).toEqual({ name: 'Canção Nova' })
    expect(trilha[1]?.user_id).toBe(1)
  })

  it('distingue campo vazio do texto "null" ao decidir o que mudou', async () => {
    const antes = (await logs('lyrics')).length
    await call('/admin/lyrics/10', {
      method: 'PUT',
      token: admin,
      json: { id_music: 1, id_language: 'pt', aux_lyric: 'null' },
    })
    const row = await env.DB.prepare(
      'SELECT aux_lyric FROM lyrics WHERE id_lyric = 10',
    ).first<Json>()
    expect(row?.aux_lyric).toBe('null')
    expect((await logs('lyrics')).length).toBe(antes + 1)

    await call('/admin/lyrics/10', {
      method: 'PUT',
      token: admin,
      json: { id_music: 1, id_language: 'pt', aux_lyric: null },
    })
    const depois = await env.DB.prepare(
      'SELECT aux_lyric FROM lyrics WHERE id_lyric = 10',
    ).first<Json>()
    expect(depois?.aux_lyric).toBeNull()
  })

  it('valida campos obrigatórios e chave estrangeira', async () => {
    const res = await call('/admin/musics', {
      method: 'POST',
      token: admin,
      json: { id_language: 'xx' },
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as Json).messages).toEqual({
      name: ['O campo name é obrigatório.'],
      id_language: ['O id language escolhido é inválido.'],
    })
  })

  it('slug de categoria é único por idioma', async () => {
    const repetido = await call('/admin/categories', {
      method: 'POST',
      token: admin,
      json: { name: 'Outra', slug: 'MISC', id_language: 'pt' },
    })
    expect(((await repetido.json()) as Json).messages).toEqual({ slug: ['O slug já está em uso.'] })

    const mesmoRegistro = await call('/admin/categories/1', {
      method: 'PUT',
      token: admin,
      json: { name: 'Diversas', slug: 'misc', id_language: 'pt' },
    })
    expect(mesmoRegistro.status).toBe(200)

    const nova = await call('/admin/categories', {
      method: 'POST',
      token: admin,
      json: { name: 'Infantis', slug: 'children', id_language: 'pt' },
    })
    expect(((await nova.json()) as Json).data).toMatchObject({ slug: 'children', order: 0 })
  })

  it('grava a letra com quebra de linha e o booleano do painel', async () => {
    const res = await call('/admin/lyrics', {
      method: 'POST',
      token: admin,
      json: {
        id_music: 7,
        lyric: 'Linha um\r\nLinha dois',
        time: '00:00:30',
        instrumental_time: '00:00:00',
        show_slide: true,
        order: 2,
        id_language: 'pt',
      },
    })
    expect(res.status).toBe(201)
    expect(((await res.json()) as Json).data).toMatchObject({
      lyric: 'Linha um\r\nLinha dois',
      show_slide: 1,
      order: 2,
    })
  })

  it('excluir a música leva junto letras e vínculos', async () => {
    const res = await call('/admin/musics/7', { method: 'DELETE', token: admin })
    expect(await res.json()).toEqual({ message: 'Registro excluído com sucesso!' })

    const sobrou = await env.DB.prepare(
      'SELECT (SELECT count(*) FROM lyrics WHERE id_music = 7) AS letras, ' +
        '(SELECT count(*) FROM albums_musics WHERE id_music = 7) AS vinculos',
    ).first()
    expect(sobrou).toEqual({ letras: 0, vinculos: 0 })
  })

  it('violação de integridade vira 500 no formato da origem', async () => {
    // Álbum 1 ainda tem música e categoria apontando para ele.
    const res = await call('/admin/albums/1', { method: 'DELETE', token: admin })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Erro interno do servidor.', code: 500 })
  })
})

describe('permissões', () => {
  it('quem não é administrador lê tudo, mas só escreve com a permissão da ação', async () => {
    expect((await call('/admin/musics', { token: editor })).status).toBe(200)

    const criar = await call('/admin/musics', {
      method: 'POST',
      token: editor,
      json: { name: 'X', id_language: 'pt' },
    })
    expect(criar.status).toBe(401)
    expect(await criar.json()).toEqual({
      error:
        'Você não tem permissão para executar esta ação. Permissão necessária: "musics.insert"',
    })

    const alterar = await call('/admin/musics/1', {
      method: 'PUT',
      token: editor,
      json: { name: 'Nosso Sol É Jesus', id_language: 'pt' },
    })
    expect(alterar.status).toBe(200)
  })

  it('a tela de usuários exige permissão até para ler', async () => {
    const res = await call('/admin/users', { token: editor })
    expect(res.status).toBe(401)
    expect(((await res.json()) as Json).error).toContain('"users"')
  })
})

describe('usuários', () => {
  it('cria com senha provisória e nunca devolve o hash', async () => {
    const res = await call('/admin/users', {
      method: 'POST',
      token: admin,
      json: {
        name: 'Ana Paula Souza',
        username: 'ana',
        email: 'ana@louvorja.com.br',
        password: 'provisoria',
        permissions: ['lyrics', 'lyrics.update'],
        is_admin: true,
      },
    })
    expect(res.status).toBe(201)
    const { data } = (await res.json()) as Json
    expect(data).toMatchObject({
      username: 'ana',
      is_admin: false,
      is_temporary_password: true,
      permissions: ['lyrics', 'lyrics.update'],
      initials: 'AS',
      short_name: 'Ana Souza',
    })
    expect(data.password).toBeUndefined()
    expect(JSON.stringify(await logs('users'))).not.toContain('pbkdf2')

    const entrou = await login('ana', 'provisoria')
    expect(entrou.user.is_temporary_password).toBe(true)

    const lista = (await (await call('/admin/users?sort_by=name', { token: admin })).json()) as Json
    expect(lista.data.every((u: Json) => u.password === undefined)).toBe(true)
  })

  it('recusa usuário e e-mail repetidos', async () => {
    const res = await call('/admin/users', {
      method: 'POST',
      token: admin,
      json: { name: 'Clone', username: 'Editor', email: 'invalido', password: '123' },
    })
    expect(((await res.json()) as Json).messages).toEqual({
      username: ['O username já está em uso.'],
      email: ['O campo email deve conter um endereço de email válido.'],
      password: ['O campo password deve ter no mínimo 6 caracteres.'],
    })
  })

  it('protege o administrador', async () => {
    const senha = await call('/admin/users/1', {
      method: 'PUT',
      token: admin,
      json: {
        name: 'Maria Admin',
        username: 'admin',
        email: 'admin@louvorja.com.br',
        password: 'outra123',
      },
    })
    expect(senha.status).toBe(400)

    const excluir = await call('/admin/users/1', { method: 'DELETE', token: admin })
    expect(excluir.status).toBe(400)
    expect(await excluir.json()).toEqual({ error: 'Este usuário não pode ser excluído!' })
  })
})
