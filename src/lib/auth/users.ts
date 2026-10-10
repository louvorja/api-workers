import { toIso } from '../sql.ts'

export type UserRow = {
  id: number
  name: string
  username: string
  email: string
  password: string
  is_temporary_password: number
  is_admin: number
  phone: string | null
  permissions: string | null
  created_at: string | null
  updated_at: string | null
}

/** O usuário como a origem o devolve: sem a senha, com os casts e os campos derivados. */
export type User = {
  id: number
  name: string
  username: string
  email: string
  is_temporary_password: boolean
  is_admin: boolean
  phone: string | null
  permissions: string[] | null
  created_at: unknown
  updated_at: unknown
  initials: string
  short_name: string
}

function parsePermissions(raw: string | null): string[] | null {
  if (raw === null) return null
  try {
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value) ? value.map(String) : null
  } catch {
    return null
  }
}

export function presentUser(row: UserRow): User {
  const names = row.name.trim().split(' ')
  const first = names[0] ?? ''
  const last = names[names.length - 1] ?? ''
  const single = names.length === 1

  return {
    id: row.id,
    name: row.name,
    username: row.username,
    email: row.email,
    is_temporary_password: Boolean(row.is_temporary_password),
    is_admin: Boolean(row.is_admin),
    phone: row.phone,
    permissions: parsePermissions(row.permissions),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    initials: single
      ? first.slice(0, 1).toUpperCase()
      : first.slice(0, 1).toUpperCase() + last.slice(0, 1).toUpperCase(),
    short_name: single ? first : `${first} ${last}`,
  }
}

export function findUserRow(db: D1Database, id: number | string): Promise<UserRow | null> {
  return db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>()
}
