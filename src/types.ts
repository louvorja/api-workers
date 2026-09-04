export type Bindings = {
  FILES: R2Bucket
  DB_VERSION: string
  LEGACY_API_URL: string
}

export type App = { Bindings: Bindings }
