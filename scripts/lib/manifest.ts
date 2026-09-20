import { createHash } from 'node:crypto'

/** Fingerprint estável do conteúdo lógico do manifesto, independente da ordem. */
export function manifestFingerprint(value: unknown): string {
  const rows = Array.isArray(value)
    ? value
        .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
        .map((entry) => ({
          file: String(entry.file ?? ''),
          table: String(entry.table ?? ''),
          hash: String(entry.hash ?? ''),
        }))
        .sort((a, b) => `${a.table}/${a.file}`.localeCompare(`${b.table}/${b.file}`))
    : []
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}
