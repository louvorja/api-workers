import { describe, expect, it } from 'vitest'
import { mediaPath, normalizedMediaPath } from '../scripts/lib/media.ts'

describe('media URL normalization used by ingest', () => {
  it('extracts a media key from the new absolute R2 URL', () => {
    expect(mediaPath('https://cdn.example/musics/pt/hino.mp3')).toBe('musics/pt/hino.mp3')
    expect(normalizedMediaPath('https://cdn.example/musics/pt/hino.mp3')).toBe(
      'musics/pt/hino.opus',
    )
  })

  it('extracts a media key from the legacy /file URL', () => {
    expect(mediaPath('https://api.louvorja.com.br/file/covers/2026.bmp')).toBe('covers/2026.bmp')
    expect(normalizedMediaPath('https://api.louvorja.com.br/file/covers/2026.bmp')).toBe(
      'covers/2026.jpg',
    )
  })

  it('keeps relative Workers paths compatible', () => {
    expect(normalizedMediaPath('/images/slide 1.jpg')).toBe('images/slide 1.jpg')
  })

  it('does not reinterpret unrelated URLs as media', () => {
    expect(mediaPath('https://www.youtube.com/watch?v=abc')).toBeNull()
    expect(mediaPath('/file/../secret.mp3')).toBeNull()
  })
})
