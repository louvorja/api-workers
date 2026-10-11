import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import { legacyCatalog } from '../src/features/json-db.ts'
import worker from '../src/index.ts'

const get = async (url: string) => {
  const ctx = createExecutionContext()
  const response = await worker.fetch(new Request(url), env, ctx)
  await waitOnExecutionContext(ctx)
  return response
}

const music = {
  id_music: 7,
  name: 'Santo "Santo"',
  url_image: '/images/hasd_018.jpg',
  url_music: '/musics/pt/Hinário/Santo, Santo.opus',
  url_instrumental_music: '/musics/pt/Hinário/Santo, Santo - PB.mp3',
  albums: [{ id_album: 1, url_image: '/covers/hasd.jpg' }],
  lyric: [{ id_lyric: 1, lyric: 'veja /images/x.jpg no texto', url_image: '/images/slide.png' }],
}

beforeAll(async () => {
  await env.FILES.put('json_db/music_7.json', JSON.stringify(music))
  await env.FILES.put(
    'json_db/bible_1_1_1.json',
    JSON.stringify([{ verse: 1, text: 'No princípio' }]),
  )
})

// O app web antigo usa os campos url_* como endereço pronto, sem prefixar nada.
describe('catálogo pedido pelo domínio da API antiga', () => {
  it('devolve endereços completos, com o áudio em .mp3 e as imagens como estão', async () => {
    const response = await get('https://api.louvorja.com.br/json_db/music_7?20261011')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('cache-control')).toBe('private, max-age=86400')
    expect(await response.json()).toEqual({
      ...music,
      url_image: 'https://api.louvorja.com.br/file/images/hasd_018.jpg',
      url_music: 'https://api.louvorja.com.br/file/musics/pt/Hinário/Santo, Santo.mp3',
      url_instrumental_music:
        'https://api.louvorja.com.br/file/musics/pt/Hinário/Santo, Santo - PB.mp3',
      albums: [{ id_album: 1, url_image: 'https://api.louvorja.com.br/file/covers/hasd.jpg' }],
      lyric: [
        {
          id_lyric: 1,
          // Texto que só parece um caminho não é campo de mídia: fica intacto.
          lyric: 'veja /images/x.jpg no texto',
          url_image: 'https://api.louvorja.com.br/file/images/slide.png',
        },
      ],
    })
  })

  it('não mexe no que os apps recebem pelo endereço de sempre', async () => {
    const response = await get('https://api.louvorja.workers.dev/json_db/music_7')
    expect(await response.json()).toEqual(music)
    expect(response.headers.get('etag')).toMatch(/^".+"$/)
  })

  it('entrega a Bíblia sem reescrita e responde 404 para chave inexistente', async () => {
    const bible = await get('https://api.louvorja.com.br/json_db/bible_1_1_1')
    expect(await bible.json()).toEqual([{ verse: 1, text: 'No princípio' }])
    expect((await get('https://api.louvorja.com.br/json_db/nao_existe')).status).toBe(404)
  })

  // O cache do Worker tem uma chave só para os dois domínios (caminho e query).
  // Resposta que muda conforme o domínio não pode entrar nele.
  it('mantém fora do cache compartilhado o que sai diferente em cada domínio', async () => {
    const path = '/json_db/music_7?20261011'
    const legacy = await get(`https://api.louvorja.com.br${path}`)
    const current = await get(`https://api.louvorja.workers.dev${path}`)
    expect(await legacy.text()).not.toBe(await current.text())
    for (const response of [legacy, current]) {
      expect(response.headers.get('cache-control')).toBe('private, max-age=86400')
    }
  })

  it('deixa no cache compartilhado só a Bíblia, que sai igual nos dois domínios', async () => {
    const path = '/json_db/bible_1_1_1?20261011'
    const legacy = await get(`https://api.louvorja.com.br${path}`)
    const current = await get(`https://api.louvorja.workers.dev${path}`)
    expect(await legacy.text()).toBe(await current.text())
    for (const response of [legacy, current]) {
      expect(response.headers.get('cache-control')).toBe(
        'public, max-age=86400, stale-while-revalidate=604800',
      )
    }
  })

  it('preserva aspas escapadas dentro do nome do arquivo', () => {
    const text = JSON.stringify({ url_music: '/musics/pt/A "B".opus', other: '/musics/x.opus' })
    expect(JSON.parse(legacyCatalog(text, 'https://h'))).toEqual({
      url_music: 'https://h/file/musics/pt/A "B".mp3',
      other: '/musics/x.opus',
    })
  })
})
