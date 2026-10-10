import { describe, expect, it } from 'vitest'
import { pageWindow } from '../src/lib/admin/listing.ts'
import { type Claims, sign, verify } from '../src/lib/auth/jwt.ts'
import { checkPassword, hashPassword } from '../src/lib/auth/password.ts'
import { foldSql, foldText, sqlNow, toIso } from '../src/lib/sql.ts'

const NOW = 1_800_000_000
const claims = (extra: Partial<Claims> = {}): Claims => ({
  iss: 'https://api.test/auth/login',
  iat: NOW,
  exp: NOW + 3600,
  nbf: NOW,
  jti: 'abc',
  sub: '1',
  name: 'Maria',
  username: 'maria',
  id: 1,
  ...extra,
})

const b64url = (text: string) =>
  btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

describe('jwt', () => {
  it('aceita o próprio token e devolve as claims', async () => {
    const token = await sign(claims(), 'segredo')
    expect(await verify(token, 'segredo', NOW + 10)).toMatchObject({ sub: '1', jti: 'abc' })
  })

  it('recusa token vencido, ainda não válido ou assinado com outro segredo', async () => {
    const token = await sign(claims(), 'segredo')
    expect(await verify(token, 'segredo', NOW + 3600)).toBeNull()
    expect(await verify(token, 'outro', NOW + 10)).toBeNull()
    expect(
      await verify(await sign(claims({ nbf: NOW + 60 }), 'segredo'), 'segredo', NOW),
    ).toBeNull()
  })

  it('recusa conteúdo adulterado e token sem assinatura', async () => {
    const [head, , signature] = (await sign(claims(), 'segredo')).split('.')
    const forged = b64url(JSON.stringify(claims({ sub: '999', id: 999 })))
    expect(await verify(`${head}.${forged}.${signature}`, 'segredo', NOW + 10)).toBeNull()

    // O clássico "alg: none": cabeçalho dizendo que não há assinatura.
    const none = b64url(JSON.stringify({ typ: 'JWT', alg: 'none' }))
    expect(await verify(`${none}.${forged}.`, 'segredo', NOW + 10)).toBeNull()
    expect(await verify(`${none}.${forged}.AAAA`, 'segredo', NOW + 10)).toBeNull()
    expect(await verify('lixo', 'segredo', NOW)).toBeNull()
  })
})

describe('senha', () => {
  it('confere a senha certa e recusa a errada', async () => {
    const hash = await hashPassword('Senha@123')
    expect(hash).toMatch(/^pbkdf2-sha256\$100000\$/)
    expect(await checkPassword('Senha@123', hash)).toBe(true)
    expect(await checkPassword('senha@123', hash)).toBe(false)
  })

  it('a mesma senha gera hashes diferentes', async () => {
    expect(await hashPassword('Senha@123')).not.toBe(await hashPassword('Senha@123'))
  })

  it('recusa formato desconhecido em vez de quebrar', async () => {
    for (const stored of [
      '',
      'texto-puro',
      '$2y$10$abcdefghijklmnopqrstuv',
      'pbkdf2-sha256$x$y$z',
    ]) {
      expect(await checkPassword('qualquer', stored)).toBe(false)
    }
  })
})

describe('paginação', () => {
  const labels = (current: number, last: number) =>
    pageWindow(current, last)
      .map((p) => p ?? '…')
      .join(' ')

  it('mostra todas as páginas quando são poucas', () => {
    expect(labels(3, 13)).toBe('1 2 3 4 5 6 7 8 9 10 11 12 13')
  })

  it('reproduz as três janelas do Laravel', () => {
    expect(labels(1, 251)).toBe('1 2 3 4 5 6 7 8 9 10 … 250 251')
    expect(labels(7, 251)).toBe('1 2 3 4 5 6 7 8 9 10 … 250 251')
    expect(labels(8, 251)).toBe('1 2 … 5 6 7 8 9 10 11 … 250 251')
    expect(labels(120, 251)).toBe('1 2 … 117 118 119 120 121 122 123 … 250 251')
    expect(labels(244, 251)).toBe('1 2 … 241 242 243 244 245 246 247 … 250 251')
    expect(labels(245, 251)).toBe('1 2 … 242 243 244 245 246 247 248 249 250 251')
    expect(labels(251, 251)).toBe('1 2 … 242 243 244 245 246 247 248 249 250 251')
  })
})

describe('texto', () => {
  it('dobra caixa e acento do mesmo jeito no SQL e no JavaScript', () => {
    expect(foldText('CORAÇÃO é Ñandú')).toBe('coracao e nandu')
    expect(foldSql('x')).toContain('replace(')
    expect(foldSql('x').startsWith('lower(')).toBe(true)
  })

  it('converte datas entre o formato do banco e o da API', () => {
    expect(sqlNow(new Date('2026-10-10T16:46:28.123Z'))).toBe('2026-10-10 16:46:28')
    expect(toIso('2026-10-10 16:46:28')).toBe('2026-10-10T16:46:28.000000Z')
    expect(toIso(null)).toBeNull()
    expect(toIso('texto qualquer')).toBe('texto qualquer')
  })
})
