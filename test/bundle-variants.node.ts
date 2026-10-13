import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { buildBundleArtifacts } from '../scripts/lib/bundle-variants.ts'

const unzipped = (zip: string, file: string) =>
  execFileSync('unzip', ['-p', zip, file], { encoding: 'utf8' })
function fixture(dir: string) {
  const data: Record<string, unknown> = {
    config: { version_number: 185 },
    music_1: { id_music: 1, url_music: '/musics/pt/A/B.opus', url_image: '/images/x.jpg' },
  }
  for (const [lang, version] of [
    ['pt', 1],
    ['es', 2],
  ] as const) {
    for (const table of ['musics', 'categories', 'hymnal']) data[`${lang}_${table}`] = []
    data[`${lang}_bible_version`] = [{ id_bible_version: version }]
    data[`${lang}_bible_book`] = [{ id_bible_book: 1, chapters: 1 }]
    data[`bible_${version}_1_1`] = { 1: 'No princípio' }
  }
  for (const [key, value] of Object.entries(data))
    writeFileSync(join(dir, `${key}.json`), JSON.stringify(value))
}

test('gera pacotes compatíveis, catálogo separado e hashes dos bytes finais de cada variante', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'bundle-artifacts-'))
  try {
    const jsonDir = join(workdir, 'json')
    mkdirSync(jsonDir)
    fixture(jsonDir)
    const artifacts = buildBundleArtifacts(jsonDir, workdir, true)
    assert.equal(artifacts.length, 9)
    for (const variant of ['files', 'legacy']) {
      const full = artifacts.find((a) => a.key === `meta/bundle-${variant}.zip`)!
      const catalog = artifacts.find((a) => a.key === `meta/catalog-bundle-${variant}.zip`)!
      const music = JSON.parse(unzipped(full.path, 'music_1.json'))
      assert.equal(
        music.url_music,
        variant === 'files'
          ? 'https://files.louvorja.com.br/musics/pt/A/B.opus'
          : 'https://mp3.louvorja.com.br/musics/pt/A/B.mp3',
      )
      assert.equal(music.url_image, 'https://files.louvorja.com.br/images/x.jpg')
      const fullManifest = JSON.parse(unzipped(full.path, '_bundle_manifest.json'))
      const manifest = JSON.parse(unzipped(catalog.path, '_bundle_manifest.json'))
      assert.equal(fullManifest.kind, 'full')
      assert.equal(manifest.kind, 'catalog')
      assert.equal(fullManifest.files.length - manifest.files.length, 2)
      assert.ok(manifest.files.every((f: { name: string }) => !/^bible_\d/.test(f.name)))
      for (const file of manifest.files) {
        const bytes = unzipped(catalog.path, file.name)
        assert.equal(file.bytes, Buffer.byteLength(bytes))
        assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'))
      }
    }
    rmSync(join(jsonDir, 'bible_1_1_1.json'))
    assert.throws(() => buildBundleArtifacts(jsonDir, workdir), /incompleto/)
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
})

test('publicação padrão produz só base e arquivos atuais, preservando Opus recebido', () => {
  const workdir = mkdtempSync(join(tmpdir(), 'bundle-current-'))
  try {
    const jsonDir = join(workdir, 'json')
    mkdirSync(jsonDir)
    fixture(jsonDir)
    const artifacts = buildBundleArtifacts(jsonDir, workdir)
    assert.equal(artifacts.length, 6)
    assert.ok(artifacts.every((artifact) => !artifact.key.includes('legacy')))
    const current = artifacts.find((artifact) => artifact.key === 'meta/catalog-bundle-files.zip')!
    assert.equal(
      JSON.parse(unzipped(current.path, 'music_1.json')).url_music,
      'https://files.louvorja.com.br/musics/pt/A/B.opus',
    )
  } finally {
    rmSync(workdir, { recursive: true, force: true })
  }
})
