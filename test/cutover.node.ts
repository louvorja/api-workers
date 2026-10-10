import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { checkCutoverExport } from '../scripts/check-cutover.ts'
import { assertCutoverAdmin } from '../scripts/lib/cutover.ts'
import { hashPassword } from '../src/lib/auth/password.ts'

const usersSchema = `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0
  );
`

function fixture(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(usersSchema)
  return db
}

function insertUser(db: DatabaseSync, id: number, password: string, isAdmin: boolean) {
  db.prepare('INSERT INTO users (id, username, password, is_admin) VALUES (?, ?, ?, ?)').run(
    id,
    `user-${id}`,
    password,
    isAdmin ? 1 : 0,
  )
}

test('aprova quando existe ao menos um administrador PBKDF2 suportado', async () => {
  const db = fixture()
  const valid = await hashPassword('Senha@123')
  insertUser(db, 1, '$2y$10$abcdefghijklmnopqrstuv0123456789012345678901234567890', true)
  insertUser(db, 2, valid, true)
  insertUser(db, 3, await hashPassword('Editor@123'), false)

  assert.deepEqual(assertCutoverAdmin(db), {
    adminCount: 2,
    bcryptAdminCount: 1,
    supportedAdminCount: 1,
  })
})

test('recusa banco sem administrador sem criar ou alterar usuários', () => {
  const db = fixture()
  insertUser(db, 1, 'texto-legado', false)

  assert.throws(() => assertCutoverAdmin(db), /nenhum administrador configurado/)
  assert.deepEqual(
    db
      .prepare('SELECT id, password, is_admin FROM users')
      .all()
      .map((row) => ({ ...row })),
    [{ id: 1, password: 'texto-legado', is_admin: 0 }],
  )
})

test('recusa administrador bcrypt do PHP sem migrar o hash silenciosamente', () => {
  const db = fixture()
  const bcrypt = '$2y$10$abcdefghijklmnopqrstuv0123456789012345678901234567890'
  insertUser(db, 1, bcrypt, true)

  assert.throws(() => assertCutoverAdmin(db), /bcrypt do PHP, que o Worker não autentica/)
  assert.equal(db.prepare('SELECT password FROM users WHERE id = 1').get()?.password, bcrypt)
})

test('recusa PBKDF2 truncado ou com custo diferente do formato suportado', () => {
  for (const password of [
    'pbkdf2-sha256$100000$AAAA$AAAA',
    `pbkdf2-sha256$99999$${'A'.repeat(22)}==$${'A'.repeat(43)}=`,
  ]) {
    const db = fixture()
    insertUser(db, 1, password, true)
    assert.throws(() => assertCutoverAdmin(db), /nenhum administrador possui hash PBKDF2/)
  }
})

test('preflight automatizável lê o export SQL e exige a tabela de usuários', async (context) => {
  const directory = mkdtempSync(join(tmpdir(), 'louvorja-cutover-'))
  context.after(() => rmSync(directory, { recursive: true, force: true }))
  const validExport = join(directory, 'valid.sql')
  const missingExport = join(directory, 'missing.sql')
  const hash = await hashPassword('Senha@123')
  writeFileSync(
    validExport,
    `${usersSchema}\nINSERT INTO users VALUES (1, 'admin', '${hash}', 1);\n`,
  )
  writeFileSync(missingExport, 'CREATE TABLE configs (key TEXT PRIMARY KEY);\n')

  assert.equal(checkCutoverExport(validExport).supportedAdminCount, 1)
  assert.throws(() => checkCutoverExport(missingExport), /tabela users ausente/)
})
