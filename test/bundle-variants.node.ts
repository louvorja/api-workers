import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildBundleVariants } from '../scripts/lib/bundle-variants.ts'

const unzipped = (zip: string, file: string) =>
  execFileSync('unzip', ['-p', zip, file], { encoding: 'utf8' })

test('gera um pacote por variante, com os endereços de mídia de cada uma', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'bundle-variants-'))
  try {
    const jsonDir = join(workdir, 'json')
    mkdirSync(jsonDir)
    const music = { id_music: 1, url_music: '/musics/pt/A/B.opus', url_image: '/images/x.jpg' }
    const bible = [{ verse: 1, text: 'No princípio' }]
    const config = { version_number: 185 }
    writeFileSync(join(jsonDir, 'music_1.json'), JSON.stringify(music))
    writeFileSync(join(jsonDir, 'bible_1_1_1.json'), JSON.stringify(bible))
    writeFileSync(join(jsonDir, 'config.json'), JSON.stringify(config))

    const variants = buildBundleVariants(jsonDir, workdir)
    assert.deepEqual(
      variants.map(({ variant, key, rewritten }) => ({ variant, key, rewritten })),
      [
        { variant: 'current', key: 'meta/bundle-files.zip', rewritten: 1 },
        { variant: 'legacy', key: 'meta/bundle-legacy.zip', rewritten: 1 },
      ],
    )

    const [current, legacy] = variants as [(typeof variants)[0], (typeof variants)[0]]
    assert.deepEqual(JSON.parse(unzipped(current.path, 'music_1.json')), {
      id_music: 1,
      url_music: 'https://files.louvorja.com.br/musics/pt/A/B.opus',
      url_image: 'https://files.louvorja.com.br/images/x.jpg',
    })
    assert.deepEqual(JSON.parse(unzipped(legacy.path, 'music_1.json')), {
      id_music: 1,
      url_music: 'https://mp3.louvorja.com.br/musics/pt/A/B.mp3',
      url_image: 'https://files.louvorja.com.br/images/x.jpg',
    })
    // O que não tem mídia entra igual nas duas variantes.
    for (const { path } of variants) {
      assert.deepEqual(JSON.parse(unzipped(path, 'bible_1_1_1.json')), bible)
      assert.deepEqual(JSON.parse(unzipped(path, 'config.json')), config)
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
})
