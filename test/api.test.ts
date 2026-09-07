import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import worker from '../src/index.ts'

const call = async (path: string, init?: RequestInit) => {
  const ctx = createExecutionContext()
  const res = await worker.fetch(new Request(`https://api.test${path}`, init), env, ctx)
  await waitOnExecutionContext(ctx)
  return res
}

beforeAll(async () => {
  await env.FILES.put('json_db/config.json', JSON.stringify({ version_number: 185 }))
  await env.FILES.put('json_db/music_1.json', JSON.stringify({ id_music: 1 }))
  await env.FILES.put('meta/params.json', JSON.stringify({ db_version: '185', help: 'x' }))
  await env.FILES.put('covers/1992.jpg', new Uint8Array([1, 2, 3, 4, 5]))
  await env.FILES.put('musics/pt/A/B.opus', new Uint8Array(100))
  await env.FILES.put('musics/pt/A/So Mp3.mp3', new Uint8Array(50))

  await env.FILES.put(
    'rest/pt_hymnal.json',
    JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ id_music: i + 1 }))),
  )
  await env.FILES.put('rest/pt_config.json', JSON.stringify({ version: '185' }))
  await env.FILES.put('rest/pt_music_7.json', JSON.stringify({ id_music: 7, lyric: [] }))
  await env.FILES.put(
    'rest/pt_collections_online.json',
    JSON.stringify({ channels: [], playlists: [], videos: [] }),
  )
  await env.FILES.put('meta/onlinevideos.txt', 'DELETE FROM ONL_CANAIS|INSERT INTO ...')
})

describe('json_db', () => {
  it('serve um arquivo existente', async () => {
    const res = await call('/json_db/config')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ version_number: 185 })
  })

  it('404 no formato legado, sem vazar caminho interno', async () => {
    const res = await call('/json_db/nao_existe')
    expect(res.status).toBe(404)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toEqual({ error: 'Arquivo não encontrado!' })
    expect(body.path).toBeUndefined()
  })

  it('rejeita chave fora do padrão em vez de descer no bucket', async () => {
    expect((await call('/json_db/a.b')).status).toBe(404)
  })

  it('marca o 404 como no-store para não envenenar a borda', async () => {
    const res = await call('/json_db/nao_existe')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})

describe('file', () => {
  it('resolve .bmp para a capa .jpg convertida', async () => {
    const res = await call('/file/covers/1992.bmp')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('image/jpeg')
  })

  it('resolve .mp3 para o .opus do acervo', async () => {
    const res = await call('/file/musics/pt/A/B.mp3')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('audio/ogg')
  })

  it('resolve .opus para o .mp3 quando a faixa não foi convertida', async () => {
    const res = await call('/file/musics/pt/A/So Mp3.opus')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('audio/mpeg')
  })

  it('prefere o .opus quando os dois existem', async () => {
    const res = await call('/file/musics/pt/A/B.opus')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('audio/ogg')
  })

  it('responde 206 a Range', async () => {
    const res = await call('/file/musics/pt/A/B.opus', { headers: { Range: 'bytes=0-9' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 0-9/100')
  })

  it('não escapa do prefixo do bucket', async () => {
    expect((await call('/file/../meta/params.json')).status).toBe(404)
  })

  it('não serve os prefixos internos do bucket', async () => {
    expect((await call('/file/json_db/config.json')).status).toBe(404)
    expect((await call('/file/meta/params.json')).status).toBe(404)
  })

  it('nomeia arquivo acentuado sem quebrar o header', async () => {
    await env.FILES.put('musics/pt/A/Não Só.opus', new Uint8Array(10))
    const res = await call('/file/musics/pt/A/N%C3%A3o%20S%C3%B3.opus')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain("filename*=UTF-8''")
  })

  it('HEAD na raiz responde para o teste de conexão do desktop', async () => {
    expect((await call('/file', { method: 'HEAD' })).status).toBe(200)
  })
})

describe('params', () => {
  it('devolve JSON por padrão', async () => {
    const res = await call('/params')
    expect(await res.json()).toEqual({ db_version: '185', help: 'x' })
  })

  it('devolve INI com CRLF, como o parser Delphi espera', async () => {
    const res = await call('/params?type=env')
    expect(await res.text()).toBe('db_version=185\r\nhelp=x\r\n')
  })

  it('preserva o tipo dos valores no JSON', async () => {
    await env.FILES.put('meta/params.json', JSON.stringify({ db_version: 185, help: 'x' }))
    const body = (await (await call('/params')).json()) as Record<string, unknown>
    expect(body.db_version).toBe(185)
    expect(typeof body.db_version).toBe('number')
  })
})

describe('cabeçalhos', () => {
  it('libera CORS sem o par inválido origin=* + credentials', async () => {
    const res = await call('/json_db/config')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-credentials')).toBeNull()
  })
})

describe('REST', () => {
  it('pagina no envelope do Laravel, 15 por página', async () => {
    const res = await call('/pt/hymnal')
    const body = (await res.json()) as Record<string, unknown>
    expect(body.total).toBe(40)
    expect(body.per_page).toBe(15)
    expect(body.last_page).toBe(3)
    expect((body.data as unknown[]).length).toBe(15)
    expect(body.prev_page_url).toBeNull()
    expect(body.next_page_url).toContain('page=2')
  })

  it('respeita ?page e calcula from/to', async () => {
    const body = (await (await call('/pt/hymnal?page=3')).json()) as Record<string, unknown>
    expect(body.current_page).toBe(3)
    expect((body.data as unknown[]).length).toBe(10)
    expect(body.from).toBe(31)
    expect(body.to).toBe(40)
    expect(body.next_page_url).toBeNull()
  })

  it('trava página fora do intervalo na última', async () => {
    const body = (await (await call('/pt/hymnal?page=999')).json()) as Record<string, unknown>
    expect(body.current_page).toBe(3)
  })

  it('serve config e item de música', async () => {
    expect(await (await call('/pt/config')).json()).toEqual({ data: { version: '185' } })
    expect(await (await call('/pt/musics/7')).json()).toEqual({
      data: { id_music: 7, lyric: [] },
    })
  })

  it('rejeita idioma desconhecido', async () => {
    expect((await call('/fr/hymnal')).status).toBe(404)
    expect((await call('/pt/inexistente')).status).toBe(404)
  })

  it('não deixa a rota genérica engolir /json_db e /file', async () => {
    expect((await call('/json_db/config')).status).toBe(200)
    expect((await call('/file/covers/1992.bmp')).status).toBe(200)
  })

  it('serve /db/bundle sem ser engolido pelo curinga /db/:key', async () => {
    await env.FILES.put('meta/bundle.zip', new Uint8Array([80, 75, 3, 4]))
    const res = await call('/db/bundle')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('zip')
  })

  it('sanitiza o id do player para não injetar HTML', async () => {
    const res = await call("/player?v=abc'></iframe><script>alert(1)</script>")
    const html = await res.text()
    expect(html).not.toContain('<script>')
    expect(html).toContain('https://www.youtube.com/embed/"')
  })

  it('aceita id de vídeo legítimo', async () => {
    const html = await (await call('/player?v=dQw4w9WgXcQ')).text()
    expect(html).toContain('embed/dQw4w9WgXcQ')
  })

  it('não deixa /:lang engolir as rotas de um segmento', async () => {
    expect((await call('/health')).status).toBe(200)
    expect((await call('/version')).status).toBe(200)
    expect((await call('/player')).status).toBe(200)
    expect((await call('/pt')).status).toBe(200)
    expect((await call('/xx')).status).toBe(404)
  })

  it('collections/online devolve JSON, não o dump SQL de /onlinevideos', async () => {
    const res = await call('/pt/collections/online')
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(await res.json()).toEqual({ channels: [], playlists: [], videos: [] })

    // A rota antiga continua servindo o dump, que é outro formato.
    const dump = await call('/onlinevideos')
    expect(await dump.text()).toContain('ONL_CANAIS')
  })

  it('publica o openapi declarando as rotas', async () => {
    const spec = (await (await call('/openapi.json')).json()) as {
      info: { title: string }
      paths: Record<string, unknown>
    }
    expect(spec.info.title).toBe('LouvorJA API')
    expect(Object.keys(spec.paths)).toContain('/file/{path}')
  })

  it('health não entra em cache', async () => {
    const res = await call('/health')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})
