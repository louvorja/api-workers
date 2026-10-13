import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import worker from '../src/index.ts'
import { withMediaUrls } from '../src/lib/media-urls.ts'

const LEGACY = 'https://api.louvorja.com.br'
const CURRENT = 'https://api.louvorja.workers.dev'

const get = async (url: string, init?: RequestInit) => {
  const ctx = createExecutionContext()
  const response = await worker.fetch(new Request(url, init), env, ctx)
  await waitOnExecutionContext(ctx)
  return response
}

// Como o catálogo é guardado: só o caminho dentro do armazenamento.
const music = {
  id_music: 7,
  name: 'Santo "Santo"',
  url_image: '/images/hasd_018.jpg',
  url_music: '/musics/pt/Hinário/Santo, Santo.opus',
  url_instrumental_music: '/musics/pt/Hinário/Santo, Santo - PB.mp3',
  albums: [{ id_album: 1, url_image: '/covers/hasd.jpg' }],
  lyric: [{ id_lyric: 1, lyric: 'veja /images/x.jpg no texto', url_image: '/images/slide.png' }],
}

// Apps atuais: tudo direto do armazenamento, com o nome exato do arquivo.
const forCurrent = {
  ...music,
  url_image: 'https://files.louvorja.com.br/images/hasd_018.jpg',
  url_music: 'https://files.louvorja.com.br/musics/pt/Hinário/Santo, Santo.opus',
  url_instrumental_music: 'https://files.louvorja.com.br/musics/pt/Hinário/Santo, Santo - PB.mp3',
  albums: [{ id_album: 1, url_image: 'https://files.louvorja.com.br/covers/hasd.jpg' }],
  lyric: [
    {
      id_lyric: 1,
      // Texto que só parece um caminho não é campo de mídia: fica intacto.
      lyric: 'veja /images/x.jpg no texto',
      url_image: 'https://files.louvorja.com.br/images/slide.png',
    },
  ],
}

beforeAll(async () => {
  await env.FILES.put('json_db/music_7.json', JSON.stringify(music))
  await env.FILES.put('json_db/album_3.json', JSON.stringify([music, { ...music, id_music: 8 }]))
  await env.FILES.put(
    'json_db/bible_1_1_1.json',
    JSON.stringify([{ verse: 1, text: 'No princípio' }]),
  )
})

describe('endereços de mídia em /json_db', () => {
  it('manda os apps atuais direto ao armazenamento, com o nome exato do arquivo', async () => {
    const response = await get(`${CURRENT}/json_db/music_7?20261011`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(await response.json()).toEqual(forCurrent)
  })

  it('preserva as mesmas URLs e extensões quando a chamada vem do domínio antigo', async () => {
    const response = await get(`${LEGACY}/json_db/music_7?20261011`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(forCurrent)
  })

  it('preserva o cache do catálogo no cliente em ambos os domínios', async () => {
    for (const origin of [LEGACY, CURRENT]) {
      const response = await get(`${origin}/json_db/music_7?20261011`)
      expect(response.headers.get('cache-control')).toBe('private, max-age=86400')
    }
  })

  it('mantém a Bíblia no cache compartilhado dos dois domínios', async () => {
    const path = '/json_db/bible_1_1_1?20261011'
    const legacy = await get(`${LEGACY}${path}`)
    const current = await get(`${CURRENT}${path}`)
    expect(await legacy.json()).toEqual([{ verse: 1, text: 'No princípio' }])
    expect(await current.json()).toEqual([{ verse: 1, text: 'No princípio' }])
    for (const response of [legacy, current]) {
      expect(response.headers.get('cache-control')).toBe(
        'public, max-age=86400, stale-while-revalidate=604800',
      )
    }
  })

  it('responde HEAD sem corpo e 404 para chave inexistente', async () => {
    const head = await get(`${CURRENT}/json_db/music_7`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect((await head.arrayBuffer()).byteLength).toBe(0)
    for (const origin of [LEGACY, CURRENT]) {
      expect((await get(`${origin}/json_db/nao_existe`)).status).toBe(404)
    }
  })
})

describe('endereços de mídia em /db', () => {
  it('devolve a mesma tabela e URLs nos dois domínios preservando a paginação', async () => {
    const current = await get(`${CURRENT}/db/album_3`)
    expect(current.headers.get('cache-control')).toBe('private, max-age=3600')
    expect(await current.json()).toEqual({
      data: [forCurrent, { ...forCurrent, id_music: 8 }],
      meta: { total: 2, per_page: 50, current_page: 1, last_page: 1 },
    })

    const legacy = await get(`${LEGACY}/db/album_3?per_page=1&page=2`)
    expect(legacy.headers.get('cache-control')).toBe('private, max-age=3600')
    expect(await legacy.json()).toEqual({
      data: [{ ...forCurrent, id_music: 8 }],
      meta: { total: 2, per_page: 1, current_page: 2, last_page: 2 },
    })
  })

  it('mantém a Bíblia igual nos dois domínios e no cache compartilhado', async () => {
    for (const origin of [LEGACY, CURRENT]) {
      const response = await get(`${origin}/db/bible_1_1_1`)
      expect(response.headers.get('cache-control')).toBe(
        'public, max-age=3600, stale-while-revalidate=86400',
      )
      expect(((await response.json()) as { data: unknown }).data).toEqual([
        { verse: 1, text: 'No princípio' },
      ])
    }
  })
})

describe('pacote do catálogo', () => {
  it('entrega o pacote sem endereços enquanto a variante não foi publicada', async () => {
    await env.FILES.put('meta/bundle.zip', 'pacote-sem-enderecos')
    for (const origin of [LEGACY, CURRENT]) {
      const response = await get(`${origin}/db/bundle`)
      expect(await response.text()).toBe('pacote-sem-enderecos')
      expect(response.headers.get('cache-control')).toBe('private, max-age=3600')
    }
  })

  it('entrega o mesmo pacote atual aos dois domínios', async () => {
    await env.FILES.put('meta/bundle.zip', 'pacote-sem-enderecos')
    await env.FILES.put('meta/bundle-files.zip', 'pacote-dos-apps-atuais')
    await env.FILES.put('meta/bundle-legacy.zip', 'pacote-dos-apps-antigos')
    expect(await (await get(`${CURRENT}/db/bundle`)).text()).toBe('pacote-dos-apps-atuais')
    expect(await (await get(`${LEGACY}/db/bundle`)).text()).toBe('pacote-dos-apps-atuais')
  })
})

describe('troca dos caminhos de mídia', () => {
  it('reescreve URLs de mídia do REST sem tocar na paginação nem em hosts externos', () => {
    const source = {
      url_music: `${CURRENT}/file/musics/pt/A.opus`,
      url_image: `${LEGACY}/file/covers/a.jpg`,
      url: `${CURRENT}/file/images/a.jpg`,
      next_page_url: `${LEGACY}/pt/musics?page=2`,
      external: { url_image: 'https://example.com/images/a.jpg' },
    }
    expect(JSON.parse(withMediaUrls(JSON.stringify(source), 'legacy'))).toEqual({
      ...source,
      url_music: 'https://mp3.louvorja.com.br/musics/pt/A.mp3',
      url_image: 'https://files.louvorja.com.br/covers/a.jpg',
      url: 'https://files.louvorja.com.br/images/a.jpg',
    })
  })

  it('preserva aspas escapadas dentro do nome do arquivo', () => {
    const text = JSON.stringify({ url_music: '/musics/pt/A "B".opus', other: '/musics/x.opus' })
    expect(JSON.parse(withMediaUrls(text, 'current'))).toEqual({
      url_music: 'https://files.louvorja.com.br/musics/pt/A "B".opus',
      other: '/musics/x.opus',
    })
    expect(JSON.parse(withMediaUrls(text, 'legacy'))).toEqual({
      url_music: 'https://mp3.louvorja.com.br/musics/pt/A "B".mp3',
      other: '/musics/x.opus',
    })
  })

  it('não toca em JSON sem campo de mídia nem em endereço que já é completo', () => {
    const plain = JSON.stringify([{ id_music: 1, name: 'A /musics/x.opus' }])
    expect(withMediaUrls(plain, 'current')).toBe(plain)
    const absolute = JSON.stringify({ url_music: 'https://exemplo.com/a.mp3', url_image: null })
    expect(withMediaUrls(absolute, 'current')).toBe(absolute)
    expect(withMediaUrls(absolute, 'legacy')).toBe(absolute)
  })
})
