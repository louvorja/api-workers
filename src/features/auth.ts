import { Hono } from 'hono'
import { logStatement, notifyTelegram } from '../lib/admin/audit.ts'
import { Validator, validationError } from '../lib/admin/validation.ts'
import { checkPassword, hashPassword } from '../lib/auth/password.ts'
import { blockToken, issueToken, readBody, requireAuth } from '../lib/auth/session.ts'
import { findUserRow, presentUser, type UserRow } from '../lib/auth/users.ts'
import { sqlNow } from '../lib/sql.ts'
import type { App } from '../types.ts'

export const auth = new Hono<App>()

/** Verificado quando o usuário não existe, para o tempo de resposta não revelar isso. */
const NO_USER_HASH = `pbkdf2-sha256$100000$${'A'.repeat(22)}==$${'A'.repeat(43)}=`

const PASSWORD_RE = /^(?=.*[A-Za-z])(?=.*\d)(?=.*[@$!%*#?&])[A-Za-z\d@$!%*#?&]{8,}$/

auth.post('/auth/login', async (c) => {
  const body = await readBody(c)
  const v = new Validator(body, c.env.DB)
  if (v.required('username', 'O campo nome de usuário é obrigatório.')) {
    v.string('username', 'O campo nome de usuário deve ser uma string.')
  }
  if (v.required('password', 'O campo senha é obrigatório.')) {
    v.string('password', 'O campo senha deve ser uma string.')
  }
  if (v.failed) return c.json(validationError(v.messages), 422)

  const row = await c.env.DB.prepare('SELECT * FROM users WHERE username = ?')
    .bind(body.username)
    .first<UserRow>()
  const matches = await checkPassword(String(body.password), row?.password ?? NO_USER_HASH)
  if (!row || !matches) return c.json({ error: 'Login ou senha incorretos.' }, 401)

  return c.json({ token: await issueToken(c, row), user: presentUser(row) })
})

for (const path of ['/auth/refresh-token', '/auth/refresh_token']) {
  auth.post(path, requireAuth, async (c) => {
    const row = await findUserRow(c.env.DB, c.var.user.id)
    if (!row) return c.json({ error: 'Token inválido ou expirado.' }, 401)

    const token = await issueToken(c, row)
    await c.env.DB.batch(blockToken(c.env.DB, c.var.claims, 30))
    return c.json({ token, user: presentUser(row) })
  })
}

auth.get('/auth/me', requireAuth, (c) => c.json(c.var.user))

auth.post('/auth/logout', requireAuth, async (c) => {
  await c.env.DB.batch(blockToken(c.env.DB, c.var.claims))
  return c.json([])
})

auth.post('/auth/change-password', requireAuth, async (c) => {
  const body = await readBody(c)
  const v = new Validator(body, c.env.DB)
  if (v.required('current_password', 'O campo senha atual é obrigatório.')) {
    v.string('current_password')
  }
  if (v.required('new_password', 'O campo nova senha é obrigatório.')) {
    v.string('new_password')
    v.min('new_password', 8, 'A nova senha deve ter no mínimo 8 caracteres.')
    if (body.new_password !== body.new_password_confirmation) {
      v.fail('new_password', 'A confirmação da nova senha não coincide.')
    }
    if (!PASSWORD_RE.test(String(body.new_password))) {
      v.fail(
        'new_password',
        'A nova senha deve conter pelo menos uma letra, um número e um caractere especial.',
      )
    }
  }
  if (v.failed) return c.json(validationError(v.messages), 422)

  const row = await findUserRow(c.env.DB, c.var.user.id)
  if (!row || !(await checkPassword(String(body.current_password), row.password))) {
    return c.json({ error: 'Senha atual incorreta.' }, 400)
  }
  if (await checkPassword(String(body.new_password), row.password)) {
    return c.json({ error: 'A nova senha não pode ser igual à senha atual.' }, 400)
  }

  // A origem registrava o hash antigo e o novo na auditoria e no Telegram; aqui
  // fica só o fato de a senha ter mudado.
  const oldValues = { password: '***', is_temporary_password: row.is_temporary_password }
  const newValues = { password: '***', is_temporary_password: 0 }

  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE users SET password = ?, is_temporary_password = 0, updated_at = ? WHERE id = ?',
    ).bind(await hashPassword(String(body.new_password)), sqlNow(), row.id),
    logStatement(c.env.DB, 'users', 'update', oldValues, newValues, c.var.user),
    ...blockToken(c.env.DB, c.var.claims),
  ])
  c.executionCtx.waitUntil(
    notifyTelegram(c.env, 'users', 'update', oldValues, newValues, c.var.user),
  )

  return c.json({ message: 'Senha alterada com sucesso.' })
})
