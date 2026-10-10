/**
 * Imprime o SQL que cria um usuário do painel. A senha entra como provisória:
 * o painel obriga a trocá-la no primeiro acesso.
 *
 *   node --experimental-strip-types scripts/create-user.ts \
 *     --name="Fulano" --username=fulano --email=fulano@exemplo.com --password=... [--admin] \
 *     | npx wrangler d1 execute louvorja --local --file=/dev/stdin
 */
import { hashPassword } from '../src/lib/auth/password.ts'

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [key, ...rest] = a.replace(/^--/, '').split('=')
    return [key as string, rest.join('=')] as const
  }),
)

const required = (key: string) => {
  const value = args.get(key)
  if (!value) throw new Error(`informe --${key}=...`)
  return value
}
const quote = (text: string) => `'${text.replace(/'/g, "''")}'`

const now = new Date().toISOString().slice(0, 19).replace('T', ' ')
const values = [
  quote(required('name')),
  quote(required('username')),
  quote(required('email')),
  quote(await hashPassword(required('password'))),
  '1',
  args.has('admin') ? '1' : '0',
  quote(now),
  quote(now),
]

console.log(
  'INSERT INTO users (name, username, email, password, is_temporary_password, is_admin, created_at, updated_at) ' +
    `VALUES (${values.join(', ')});`,
)
