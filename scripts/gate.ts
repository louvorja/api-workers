/**
 * Decide se o pipeline precisa rodar hoje.
 *
 * `/db/config` da origem responde em 188 bytes, sem token, e traz `version` —
 * o epoch do último rebuild do banco. Comparar isso com o estado custa uma
 * requisição; descobrir o mesmo pelo /db/manifest custaria 2,2MB, e pelo
 * /db/bundle, 28MB. No dia em que nada mudou, o ciclo inteiro para aqui.
 *
 * Escreve `changed` e `reason` em $GITHUB_OUTPUT quando rodando no Actions.
 *
 *   node --env-file=.env --experimental-strip-types scripts/gate.ts [--force]
 */
import { appendFileSync } from 'node:fs'
import { fetchLegacy } from './lib/legacy.ts'
import { manifestFingerprint } from './lib/manifest.ts'
import * as state from './lib/state.ts'

const FORCE = process.argv.includes('--force')

type ConfigEnvelope = {
  data?: { version?: number; version_number?: number }
  version?: number
  version_number?: number
}

const res = await fetchLegacy('/db/config')
if (res.status !== 200) throw new Error(`/db/config -> HTTP ${res.status}`)

const body = JSON.parse(new TextDecoder().decode(res.body)) as ConfigEnvelope
const atual = body.data ?? body
const version = Number(atual.version ?? 0)
const versionNumber = Number(atual.version_number ?? 0)
if (!version) throw new Error('/db/config não trouxe version')

// A origem pode regenerar os JSONs (inclusive mudar apenas URLs de mídia) sem
// alterar `version`. O manifesto é a fonte barata de hashes por tabela; sem
// compará-lo, o cron conclui "nada mudou" e deixa a réplica defasada.
const manifestRes = await fetchLegacy('/db/manifest')
if (manifestRes.status !== 200) throw new Error(`/db/manifest -> HTTP ${manifestRes.status}`)
const manifestHash = manifestFingerprint(
  JSON.parse(new TextDecoder().decode(manifestRes.body)) as unknown,
)

const anterior = await state.load()

// Lote pendente força execução mesmo sem mudança na origem: a `version` não vai
// mudar só porque sobrou mídia do teto anterior, e sem isso o resto nunca entra.
const pendente = anterior.media_pending > 0

const manifestChanged = manifestHash !== anterior.manifest_hash
const changed = FORCE || pendente || version !== anterior.version || manifestChanged
const reason = FORCE
  ? 'execução forçada'
  : version !== anterior.version
    ? `origem mudou: version ${anterior.version || '(nenhuma)'} -> ${version} (db_version ${versionNumber})`
    : manifestChanged
      ? `manifesto mudou: ${anterior.manifest_hash ? `${anterior.manifest_hash.slice(0, 8)} -> ` : ''}${manifestHash.slice(0, 8)}`
      : pendente
        ? `${anterior.media_pending} mídias pendentes do ciclo anterior`
        : `nada mudou (version ${version}, db_version ${versionNumber})`

console.log(reason)

const out = process.env.GITHUB_OUTPUT
if (out) {
  appendFileSync(out, `changed=${changed}\n`)
  appendFileSync(out, `reason=${reason}\n`)
  appendFileSync(out, `version=${version}\n`)
  appendFileSync(out, `version_number=${versionNumber}\n`)
  appendFileSync(out, `manifest_hash=${manifestHash}\n`)
}
