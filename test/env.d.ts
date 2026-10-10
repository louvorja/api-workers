/// <reference types="@cloudflare/vitest-plugin/types" />

import type { D1Migration } from 'cloudflare:test'

// Bindings que só existem nos testes (ver vitest.config.ts).
declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[]
    }
  }
}
