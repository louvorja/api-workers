/**
 * Senhas em PBKDF2-SHA256 pela WebCrypto — nativo no runtime, sem dependência.
 * 100.000 iterações é o teto que o workerd aceita. O formato guarda esquema e
 * custo junto do hash para que um dia dê para subir o custo sem invalidar as
 * senhas existentes.
 */
const SCHEME = 'pbkdf2-sha256'
const ITERATIONS = 100_000
const SALT_BYTES = 16
const HASH_BYTES = 32

const toB64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const fromB64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

type ParsedPasswordHash = {
  iterations: number
  salt: Uint8Array
  hash: Uint8Array
}

function parsePasswordHash(stored: string): ParsedPasswordHash | null {
  const parts = stored.split('$')
  if (parts.length !== 4) return null
  const [scheme, rawIterations, rawSalt, rawHash] = parts
  if (scheme !== SCHEME || !rawIterations || !rawSalt || !rawHash) return null

  const iterations = Number(rawIterations)
  if (!Number.isSafeInteger(iterations) || iterations !== ITERATIONS) return null

  try {
    const salt = fromB64(rawSalt)
    const hash = fromB64(rawHash)
    if (salt.length !== SALT_BYTES || hash.length !== HASH_BYTES) return null
    // `atob` tolera algumas representações não canônicas. Exigir a forma que
    // nós mesmos geramos evita aceitar um hash truncado ou ambíguo no corte.
    if (toB64(salt) !== rawSalt || toB64(hash) !== rawHash) return null
    return { iterations, salt, hash }
  } catch {
    return null
  }
}

/** Retorna true somente para o formato que este runtime consegue autenticar. */
export function isSupportedPasswordHash(stored: string): boolean {
  return parsePasswordHash(stored) !== null
}

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
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const hash = await derive(password, salt, ITERATIONS)
  return `${SCHEME}$${ITERATIONS}$${toB64(salt)}$${toB64(hash)}`
}

export async function checkPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parsePasswordHash(stored)
  if (parsed === null) return false

  let actual: Uint8Array
  try {
    actual = await derive(password, parsed.salt, parsed.iterations)
  } catch {
    return false
  }
  if (actual.length !== parsed.hash.length) return false

  let diff = 0
  for (let i = 0; i < actual.length; i++) diff |= (actual[i] ?? 0) ^ (parsed.hash[i] ?? 0)
  return diff === 0
}
