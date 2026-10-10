import type { DatabaseSync } from 'node:sqlite'
import { isSupportedPasswordHash } from '../../src/lib/auth/password.ts'

export type CutoverAdminReport = {
  adminCount: number
  bcryptAdminCount: number
  supportedAdminCount: number
}

const CREATE_ADMIN_HINT =
  'crie explicitamente um administrador com `npm run d1:user -- --admin ...` e aplique o SQL no D1'

function usersTableExists(db: DatabaseSync): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users' LIMIT 1").get(),
  )
}

/**
 * Confere apenas a capacidade de autenticação do corte. Usuários continuam
 * sendo dados operacionais do D1 e nenhum hash é criado ou convertido aqui.
 */
export function inspectCutoverAdmin(db: DatabaseSync): CutoverAdminReport {
  if (!usersTableExists(db)) {
    throw new Error('preflight do corte: tabela users ausente; aplique as migrations do D1')
  }

  const rows = db.prepare('SELECT password FROM users WHERE is_admin = 1').all() as Array<{
    password: unknown
  }>
  const passwords = rows.map((row) => (typeof row.password === 'string' ? row.password : ''))

  return {
    adminCount: passwords.length,
    bcryptAdminCount: passwords.filter((password) => /^\$2[aby]\$/.test(password)).length,
    supportedAdminCount: passwords.filter(isSupportedPasswordHash).length,
  }
}

export function assertCutoverAdmin(db: DatabaseSync): CutoverAdminReport {
  const report = inspectCutoverAdmin(db)
  if (report.supportedAdminCount > 0) return report

  if (report.adminCount === 0) {
    throw new Error(`preflight do corte: nenhum administrador configurado; ${CREATE_ADMIN_HINT}`)
  }

  const bcrypt =
    report.bcryptAdminCount > 0
      ? ` ${report.bcryptAdminCount} administrador(es) ainda usa(m) bcrypt do PHP, que o Worker não autentica.`
      : ''
  throw new Error(
    `preflight do corte: nenhum administrador possui hash PBKDF2-SHA256 válido.${bcrypt} ` +
      `Hashes não são convertidos automaticamente; ${CREATE_ADMIN_HINT}.`,
  )
}
