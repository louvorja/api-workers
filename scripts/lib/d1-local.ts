/**
 * Interface do D1 sobre um SQLite local, para os scripts rodarem as mesmas
 * consultas do Worker numa réplica do banco (`wrangler d1 export`).
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'

// Sem "parameter properties": os scripts rodam com o strip-types do Node, que
// só remove tipos e não gera código.
class LocalStatement {
  private readonly db: DatabaseSync
  private readonly sql: string
  private readonly params: SQLInputValue[]

  constructor(db: DatabaseSync, sql: string, params: SQLInputValue[] = []) {
    this.db = db
    this.sql = sql
    this.params = params
  }

  bind(...values: unknown[]) {
    return new LocalStatement(
      this.db,
      this.sql,
      values.map((value) => (value ?? null) as SQLInputValue),
    )
  }

  async all<T>() {
    return { results: this.db.prepare(this.sql).all(...this.params) as T[], success: true }
  }

  async first<T>() {
    return (this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null
  }

  async run() {
    this.db.prepare(this.sql).run(...this.params)
    return { success: true }
  }
}

export function localD1(db: DatabaseSync): D1Database {
  return {
    prepare: (sql: string) => new LocalStatement(db, sql),
    batch: (statements: LocalStatement[]) => Promise.all(statements.map((s) => s.all())),
  } as unknown as D1Database
}
