import { createExecutionContext, env } from 'cloudflare:test'
import { beforeAll, describe, expect, it } from 'vitest'
import worker from '../src/index.ts'

const call = async (path: string) => {
  const ctx = createExecutionContext()
  return worker.fetch(new Request(`https://api.test${path}`), env, ctx)
}

// O que a publicação grava em rest/<lang>_collections_online.json: só o que
// está validado, já com o id do canal e da playlist de cada linha.
beforeAll(async () => {
  await env.FILES.put(
    'rest/pt_collections_online.json',
    JSON.stringify({
      channels: [
        {
          channel_id: 'canal-pt',
          title: "Canal d'Água",
          custom_url: '@pt',
          default_image: 'pt.jpg',
          default_image_base64: 'base64-pt',
        },
      ],
      playlists: [
        {
          playlist_id: 'lista-pt',
          channel_id: 'canal-pt',
          title: 'Lista PT',
          default_image: 'lp.jpg',
          default_image_base64: 'lp64',
        },
      ],
      videos: [
        {
          video_id: 'video-pt',
          playlist_id: 'lista-pt',
          title: 'Louvor | teste',
          sequence: 3,
          default_image: 'vp.jpg',
          default_image_base64: 'vp64',
        },
      ],
    }),
  )
  await env.FILES.put(
    'rest/es_collections_online.json',
    JSON.stringify({
      channels: [
        {
          channel_id: 'canal-es',
          title: 'Canal ES',
          custom_url: '@es',
          default_image: 'es.jpg',
          default_image_base64: 'base64-es',
        },
      ],
      playlists: [
        {
          playlist_id: 'lista-es',
          channel_id: 'canal-es',
          title: 'Lista ES',
          default_image: 'le.jpg',
          default_image_base64: 'le64',
        },
      ],
      videos: [
        {
          video_id: 'video-es',
          playlist_id: 'lista-es',
          title: 'Alabanza',
          sequence: 4,
          default_image: 've.jpg',
          default_image_base64: 've64',
        },
      ],
    }),
  )
})

describe('/onlinevideos legado', () => {
  it('gera o SQL PT completo que o Delphi executa', async () => {
    const text = await (await call('/onlinevideos?lang=pt')).text()
    expect(text).toContain('DELETE FROM ONL_CANAIS|INSERT INTO ONL_CANAIS')
    expect(text).toContain("Canal d''Água")
    expect(text).toContain("'lista-pt'")
    expect(text).toContain("'video-pt'")
    expect(text).toContain('Louvor ｜ teste')
    expect(text).not.toContain('Louvor | teste')
    expect(text.trim().split('|')).toHaveLength(6)
    expect(text).not.toContain('canal-es')
  })

  it('filtra playlists por canal e vídeos por playlist', async () => {
    const playlists = await (await call('/onlinevideos?tipo=playlists&id=canal-pt&lang=pt')).text()
    expect(playlists).toContain("DELETE FROM ONL_PLAYLISTS WHERE CANAL_ID = 'canal-pt'")
    expect(playlists).toContain('lista-pt')
    expect(playlists).not.toContain('DELETE FROM ONL_CANAIS')

    const videos = await (await call('/onlinevideos?tipo=videos&id=lista-pt&lang=pt')).text()
    expect(videos).toContain("DELETE FROM ONL_VIDEOS WHERE PLAYLIST_ID = 'lista-pt'")
    expect(videos).toContain('video-pt')
  })

  it('infere o idioma pelo id quando o retry do Delphi perde lang', async () => {
    const playlists = await (await call('/onlinevideos?tipo=playlists&id=canal-es')).text()
    expect(playlists).toContain('lista-es')
    expect(playlists).not.toContain('lista-pt')

    const videos = await (await call('/onlinevideos?tipo=videos&id=lista-es')).text()
    expect(videos).toContain('video-es')
    expect(videos).not.toContain('video-pt')
  })

  it('devolve JSON separado por idioma', async () => {
    const response = await call('/onlinevideos?format=json&lang=es')
    expect(response.headers.get('content-type')).toContain('application/json')
    const body = (await response.json()) as Record<string, Array<Record<string, unknown>>>
    expect(body.channels?.map((row) => row.channel_id)).toEqual(['canal-es'])
    expect(body.playlists?.map((row) => row.playlist_id)).toEqual(['lista-es'])
    expect(body.videos?.map((row) => row.video_id)).toEqual(['video-es'])
  })

  it('aceita id_language como a API PHP', async () => {
    const response = await call('/onlinevideos?format=json&id_language=es')
    const body = (await response.json()) as Record<string, Array<Record<string, unknown>>>

    expect(body.channels?.map((row) => row.channel_id)).toEqual(['canal-es'])
    expect(body.channels?.map((row) => row.channel_id)).not.toContain('canal-pt')
  })
})
