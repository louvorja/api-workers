/**
 * Gera, a partir do pacote publicado (meta/bundle.zip), os pacotes com os
 * endereços de mídia de cada variante e os envia ao R2.
 *
 * A publicação normal já faz isso sempre que o catálogo muda. Este comando
 * existe para a primeira vez e para quando só o endereço do armazenamento
 * mudou, sem alteração no catálogo.
 *
 *   npm run bundle:variants            # só mostra o que faria
 *   npm run bundle:variants -- --write # envia ao R2
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUNDLE_KEY } from '../src/lib/media-urls.ts'
import { buildBundleArtifacts } from './lib/bundle-variants.ts'
import * as r2 from './lib/r2.ts'

const write = process.argv.includes('--write')

const bundle = await r2.get(BUNDLE_KEY)
if (bundle === null) throw new Error(`${BUNDLE_KEY} não existe no bucket`)

const workdir = mkdtempSync(join(tmpdir(), 'louvorja-bundle-'))
try {
  const jsonDir = join(workdir, 'json')
  mkdirSync(jsonDir)
  writeFileSync(join(workdir, 'bundle.zip'), bundle)
  execFileSync('unzip', ['-qq', '-o', join(workdir, 'bundle.zip'), '-d', jsonDir])

  for (const variant of buildBundleArtifacts(jsonDir, workdir)) {
    const megabytes = (statSync(variant.path).size / 1e6).toFixed(1)
    console.log(`${variant.key}: ${megabytes} MB`)
    if (write) await r2.put(variant.key, readFileSync(variant.path), variant.contentType)
  }
  console.log(write ? 'Enviado ao R2.' : 'Simulação: nada foi enviado (use --write).')
} finally {
  rmSync(workdir, { recursive: true, force: true })
}
