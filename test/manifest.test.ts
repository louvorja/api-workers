import { describe, expect, it } from 'vitest'
import { manifestFingerprint } from '../scripts/lib/manifest.ts'

describe('manifestFingerprint', () => {
  it('is stable when entries change order', () => {
    const a = [
      { file: 'b.json', table: 'b', hash: '2' },
      { file: 'a.json', table: 'a', hash: '1' },
    ]
    const b = [...a].reverse()
    expect(manifestFingerprint(a)).toBe(manifestFingerprint(b))
  })

  it('changes when a table hash changes', () => {
    expect(manifestFingerprint([{ file: 'music_1.json', table: 'music_1', hash: 'old' }])).not.toBe(
      manifestFingerprint([{ file: 'music_1.json', table: 'music_1', hash: 'new' }]),
    )
  })
})
