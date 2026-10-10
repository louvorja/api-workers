import type { Claims } from './lib/auth/jwt.ts'
import type { User } from './lib/auth/users.ts'

export type Bindings = {
  FILES: R2Bucket
  DB: D1Database
  DB_VERSION: string
  LEGACY_API_URL: string
  JWT_SECRET: string
  TELEGRAM_BOT_TOKEN?: string
  TELEGRAM_CHAT_ID?: string
}

export type Variables = {
  user: User
  claims: Claims
}

export type App = { Bindings: Bindings; Variables: Variables }
