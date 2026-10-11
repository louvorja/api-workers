import { execFileSync } from 'node:child_process'
import { linkSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUNDLE_VARIANT_KEYS, type MediaVariant, withMediaUrls } from '../../src/lib/media-urls.ts'

const BIBLE_FILE = /^bible_\d+_\d+_\d+\.json$/

export type BundleVariant = { variant: MediaVariant; key: string; path: string; rewritten: number }

/**
 * Monta, a partir do diretório com os JSONs do catálogo, um ZIP por variante de
 * endereço de mídia. O app instala o pacote e usa os endereços que vêm nele: sem
 * a variante, ele completaria o caminho com o endereço da API e cada arquivo
 * baixado voltaria a contar na cota do Worker.
 *
 * Os capítulos da Bíblia não têm mídia e entram por link, sem cópia.
 */
export function buildBundleVariants(jsonDir: string, workdir: string): BundleVariant[] {
  const files = readdirSync(jsonDir).filter((file) => file.endsWith('.json'))
  return (Object.keys(BUNDLE_VARIANT_KEYS) as MediaVariant[]).map((variant) => {
    const dir = join(workdir, `bundle-${variant}`)
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir)
    let rewritten = 0
    for (const file of files) {
      if (BIBLE_FILE.test(file)) {
        linkSync(join(jsonDir, file), join(dir, file))
        continue
      }
      const original = readFileSync(join(jsonDir, file), 'utf8')
      const text = withMediaUrls(original, variant)
      if (text !== original) rewritten++
      writeFileSync(join(dir, file), text)
    }
    const path = join(workdir, `bundle-${variant}.zip`)
    rmSync(path, { force: true })
    execFileSync('zip', ['-qq', '-r', '-X', path, '.'], { cwd: dir })
    return { variant, key: BUNDLE_VARIANT_KEYS[variant], path, rewritten }
  })
}
