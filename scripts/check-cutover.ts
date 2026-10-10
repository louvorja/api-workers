/**
 * Valida, sem alterar dados, que a réplica usada no corte contém ao menos um
 * administrador que a autenticação do Worker consegue reconhecer.
 *
 *   npm run cutover:check -- --export=replica.sql
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { assertCutoverAdmin, type CutoverAdminReport } from './lib/cutover.ts'

export function checkCutoverExport(path: string): CutoverAdminReport {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(readFileSync(path, 'utf8'))
    return assertCutoverAdmin(db)
  } finally {
    db.close()
  }
}

function main() {
  const args = new Map(
    process.argv.slice(2).map((arg) => arg.replace(/^--/, '').split('=') as [string, string]),
  )
  const path = args.get('export')
  if (!path) throw new Error('informe --export=<arquivo do wrangler d1 export>')

  const report = checkCutoverExport(path)
  console.log(
    `Preflight aprovado: ${report.supportedAdminCount} administrador(es) com PBKDF2-SHA256 válido.`,
  )
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === invokedPath) main()
