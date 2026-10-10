/**
 * Diz se o painel alterou algo desde a última publicação.
 *
 * Existe para a rotina de hora em hora não exportar o banco à toa: cada export
 * conta, na cota diária de leitura do D1, uma linha por linha exportada. Aqui a
 * pergunta custa uma linha — o maior id da auditoria, que toda escrita do painel
 * incrementa — comparada com a marca que a última publicação deixou no R2.
 *
 *   node --env-file=.env --experimental-strip-types scripts/publish-gate.ts
 *
 * Imprime `changed=true|false` e, no GitHub Actions, grava o mesmo em
 * $GITHUB_OUTPUT. Carga feita direto no banco (seed, `wrangler d1 execute`) não
 * passa pela auditoria: depois dela, dispare a publicação à mão.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { PUBLISHED_LOG_KEY, publishedLogChanged } from './lib/publication.ts'
import * as r2 from './lib/r2.ts'

const args = new Map(
  process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=') as [string, string]),
)
const DATABASE = args.get('database') ?? 'louvorja'

const output = execFileSync(
  'npx',
  [
    'wrangler',
    'd1',
    'execute',
    DATABASE,
    '--remote',
    '--json',
    '--command',
    'SELECT coalesce(max(id_log), 0) AS head FROM logs',
  ],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
)
const head = Number(
  (JSON.parse(output) as Array<{ results: Array<{ head: unknown }> }>)[0]?.results[0]?.head,
)
if (!Number.isSafeInteger(head)) throw new Error(`resposta inesperada do D1: ${output}`)

const stored = await r2.get(PUBLISHED_LOG_KEY)
const changed = publishedLogChanged(head, stored === null ? null : new TextDecoder().decode(stored))

console.log(
  changed
    ? `Há alteração do painel ainda não publicada (auditoria em ${head}).`
    : `Nada mudou desde a última publicação (auditoria em ${head}).`,
)
console.log(`changed=${changed}`)
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`)
