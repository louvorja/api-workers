import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          JWT_SECRET: 'segredo-de-teste',
          // As migrations são lidas no Node e aplicadas dentro do runtime pelo teste.
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
        },
      },
    }),
  ],
}))
