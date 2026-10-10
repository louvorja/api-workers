/**
 * Senhas em PBKDF2-SHA256 pela WebCrypto — nativo no runtime, sem dependência.
 * 100.000 iterações é o teto que o workerd aceita. O formato guarda esquema e
 * custo junto do hash para que um dia dê para subir o custo sem invalidar as
 * senhas existentes.
 */
const SCHEME = 'pbkdf2-sha256'
const ITERATIONS = 100_000

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const fromB64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256,
  )
  return new Uint8Array(bits)
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await derive(password, salt, ITERATIONS)
  return `${SCHEME}$${ITERATIONS}$${toB64(salt)}$${toB64(hash)}`
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iterations, salt, hash] = stored.split('$')
  if (scheme !== SCHEME || !iterations || !salt || !hash) return false

  let expected: Uint8Array
  let actual: Uint8Array
  try {
    expected = fromB64(hash)
    actual = await derive(password, fromB64(salt), Number(iterations))
  } catch {
    return false
  }
  if (actual.length !== expected.length) return false

  let diff = 0
  for (let i = 0; i < actual.length; i++) diff |= (actual[i] ?? 0) ^ (expected[i] ?? 0)
  return diff === 0
}
