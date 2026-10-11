import { describe, expect, it } from 'vitest'
import { reconcileRestMedia } from '../scripts/lib/rest-media.ts'
import { withMediaUrls } from '../src/lib/media-urls.ts'

const prefix = 'https://api.louvorja.workers.dev/file/'
const sizes = new Map([
  ['musics/pt/A.mp3', 100],
  ['musics/pt/B.opus', 200],
  ['images/a.jpg', 300],
])

describe('reconciliação de mídia REST', () => {
  it('resolve ambos os formatos pelo inventário sem converter nem inventar arquivo', () => {
    const source = {
      url_music: `${prefix}musics/pt/A.opus`,
      albums: [{ url_music: '/musics/pt/B.mp3' }],
    }
    expect(JSON.parse(reconcileRestMedia(JSON.stringify(source), sizes))).toEqual({
      url_music: `${prefix}musics/pt/A.mp3`,
      albums: [{ url_music: '/musics/pt/B.opus' }],
    })
    expect(() => reconcileRestMedia('{"url_music":"/musics/pt/C.opus"}', sizes)).toThrow(
      'Arquivo ausente',
    )
  })

  it('size acompanha o arquivo entregue em cada domínio, qualquer que seja a ordem das propriedades', () => {
    const source = [
      { id_file: 1, size: 999, url: `${prefix}musics/pt/B.opus` },
      { id_file: 2, url: `${prefix}images/a.jpg`, size: 888 },
    ]
    const current = reconcileRestMedia(JSON.stringify(source), sizes)
    expect(JSON.parse(current).map((row: { size: number }) => row.size)).toEqual([200, 300])
    const originals = new Map([
      ['musics/pt/B.mp3', 500],
      ['images/a.jpg', 300],
    ])
    const legacy = reconcileRestMedia(current, originals, 'legacy')
    expect(JSON.parse(withMediaUrls(legacy, 'legacy'))).toEqual([
      { id_file: 1, size: 500, url: 'https://mp3.louvorja.com.br/musics/pt/B.mp3' },
      { id_file: 2, size: 300, url: 'https://files.louvorja.com.br/images/a.jpg' },
    ])
    expect(() => reconcileRestMedia(current, sizes, 'legacy')).toThrow('Arquivo ausente')
  })

  it('preserva texto e URLs externas e não interpreta paginação como arquivo', () => {
    const source = {
      lyric: '"url_music":"/musics/pt/C.opus"',
      url_music: 'https://external.example/musics/pt/C.opus',
      url: 'https://api.louvorja.workers.dev/pt/musics?page=2',
      url_image: null,
    }
    expect(JSON.parse(reconcileRestMedia(JSON.stringify(source), sizes))).toEqual(source)
    expect(JSON.parse(withMediaUrls(JSON.stringify(source), 'legacy'))).toEqual(source)
  })

  it('é idempotente e mantém o nome exato quando as duas extensões existem', () => {
    const inventory = new Map([...sizes, ['musics/pt/B.mp3', 500]])
    const source = '{"url_music":"/musics/pt/B.opus"}'
    const result = reconcileRestMedia(source, inventory)
    expect(result).toBe(source)
    expect(reconcileRestMedia(result, inventory)).toBe(result)
  })
})
