import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BUNDLE_KEY,
  BUNDLE_VARIANT_KEYS,
  CATALOG_VARIANT_KEYS,
  MANIFEST_VARIANT_KEYS,
  withMediaUrls,
} from '../../src/lib/media-urls.ts'

export const BUNDLE_MANIFEST = '_bundle_manifest.json'
const BIBLE_FILE = /^bible_\d+_\d+_\d+\.json$/
export type BundleArtifact = { key: string; path: string; contentType: string }
const hash = (body: string, algorithm: string) => createHash(algorithm).update(body).digest('hex')

/** Refuse an incomplete source snapshot before building any installable package. */
function validateSource(source: Map<string, string>): void {
  const read = (name: string) => {
    const body = source.get(name)
    if (body === undefined) throw new Error(`Pacote incompleto: ${name}`)
    return JSON.parse(body)
  }
  const config = read('config.json')
  if (!Number.isSafeInteger(config.version_number)) throw new Error('Versão do catálogo inválida')
  const expectedBible = new Set<string>()
  for (const lang of ['pt', 'es']) {
    for (const suffix of ['musics', 'categories', 'hymnal', 'bible_version', 'bible_book']) {
      if (!Array.isArray(read(`${lang}_${suffix}.json`)))
        throw new Error(`Lista inválida: ${lang}_${suffix}`)
    }
    const versions = read(`${lang}_bible_version.json`)
    const books = read(`${lang}_bible_book.json`)
    if (!versions.length || !books.length) throw new Error(`Metadados bíblicos ausentes: ${lang}`)
    for (const { id_bible_version: version } of versions) {
      for (const { id_bible_book: book, chapters } of books) {
        if (
          ![version, book, chapters].every((n) => Number.isSafeInteger(n) && n > 0) ||
          chapters > 200
        ) {
          throw new Error('Metadados bíblicos inválidos')
        }
        for (let chapter = 1; chapter <= chapters; chapter++) {
          const name = `bible_${version}_${book}_${chapter}.json`
          if (expectedBible.has(name)) throw new Error(`Capítulo duplicado nos metadados: ${name}`)
          expectedBible.add(name)
          read(name)
        }
      }
    }
  }
  const references = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) references(item)
      return
    }
    if (!value || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value)) {
      if (
        (key === 'id_music' || key === 'id_album') &&
        Number.isSafeInteger(item) &&
        Number(item) > 0
      ) {
        const name = `${key.slice(3)}_${item}.json`
        if (!source.has(name)) throw new Error(`Referência ausente: ${name}`)
      }
      references(item)
    }
  }
  for (const [name, body] of source) {
    if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) throw new Error(`Nome inválido: ${name}`)
    const value = JSON.parse(body)
    if (BIBLE_FILE.test(name)) {
      if (!expectedBible.has(name)) throw new Error(`Capítulo fora dos metadados: ${name}`)
      if (
        !value ||
        Array.isArray(value) ||
        typeof value !== 'object' ||
        !Object.keys(value).length ||
        Object.entries(value).some(
          ([verse, text]) => !/^[1-9]\d*$/.test(verse) || typeof text !== 'string',
        )
      ) {
        throw new Error(`Capítulo inválido: ${name}`)
      }
    } else references(value)
  }
}

/** One source snapshot produces the full, catalog-only and Bible packages and exact-byte manifests. */
export function buildBundleArtifacts(jsonDir: string, workdir: string): BundleArtifact[] {
  const source = new Map(
    readdirSync(jsonDir)
      .filter((name) => name.endsWith('.json') && !name.endsWith('_manifest.json'))
      .sort()
      .map((name) => [name, readFileSync(join(jsonDir, name), 'utf8')]),
  )
  validateSource(source)
  const artifacts: BundleArtifact[] = []
  for (const variant of ['base', 'current', 'legacy'] as const) {
    const data = new Map(
      [...source].map(([name, body]) => [
        name,
        variant === 'base' ? body : withMediaUrls(body, variant),
      ]),
    )
    const manifestKey = variant === 'base' ? 'meta/manifest.json' : MANIFEST_VARIANT_KEYS[variant]
    const manifestPath = join(workdir, `manifest-${variant}.json`)
    writeFileSync(
      manifestPath,
      JSON.stringify(
        [...data].map(([name, body]) => ({
          file: name,
          table: name.slice(0, -5),
          path: `/db/${name.slice(0, -5)}`,
          hash: hash(body, 'md5'),
        })),
      ),
    )
    artifacts.push({ key: manifestKey, path: manifestPath, contentType: 'application/json' })
    for (const kind of (variant === 'base' ? ['full', 'bible'] : ['full', 'catalog']) as Array<
      'full' | 'catalog' | 'bible'
    >) {
      const entries = [...data].filter(
        ([name]) => kind === 'full' || BIBLE_FILE.test(name) === (kind === 'bible'),
      )
      const dir = join(workdir, `package-${variant}-${kind}`)
      rmSync(dir, { recursive: true, force: true })
      mkdirSync(dir)
      for (const [name, body] of entries) writeFileSync(join(dir, name), body)
      writeFileSync(
        join(dir, BUNDLE_MANIFEST),
        JSON.stringify({
          schema_version: 1,
          kind,
          files: entries.map(([name, body]) => ({
            name,
            bytes: Buffer.byteLength(body),
            sha256: hash(body, 'sha256'),
          })),
        }),
      )
      const path = join(workdir, `package-${variant}-${kind}.zip`)
      rmSync(path, { force: true })
      execFileSync('zip', ['-qq', '-r', '-X', path, '.'], { cwd: dir })
      const key =
        kind === 'bible'
          ? 'meta/bible-bundle.zip'
          : variant === 'base'
            ? BUNDLE_KEY
            : kind === 'full'
              ? BUNDLE_VARIANT_KEYS[variant]
              : CATALOG_VARIANT_KEYS[variant]
      artifacts.push({ key, path, contentType: 'application/zip' })
    }
  }
  return artifacts
}
