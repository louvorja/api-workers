/**
 * Decide o que falta fazer com cada arquivo de mídia do catálogo.
 *
 * Cada arquivo existe em dois lugares:
 *
 * - o original (MP3, BMP ou JPEG), com o nome antigo `dir/name`, no bucket dos
 *   originais. É o que o Delphi e os apps antigos baixam;
 * - a versão que os apps atuais baixam, `dir/file_name`, no bucket `files`:
 *   Opus quando o MP3 passa de 128 kbps, JPEG no lugar de BMP, e o próprio
 *   original nos outros casos.
 *
 * Um arquivo novo chega só em um deles — o original enviado ao bucket dos
 * originais, ou o arquivo de uma apresentação importada, gravado em `files` —
 * e este plano diz como completar o outro lado.
 */
export type MediaRecord = {
  idFile: number
  type: string
  dir: string
  /** Nome antigo, o do arquivo original (`.mp3`, `.bmp`). */
  name: string
  /** Nome do arquivo guardado em `files`. */
  fileName: string
}

export type MediaWork = {
  idFile: number
  type: string
  originalKey: string
  storedKey: string
  /** De onde ler os bytes originais. */
  source: 'originals' | 'files'
  /** O original ainda não está no bucket dos originais. */
  copyOriginal: boolean
}

export type MediaPlan = {
  work: MediaWork[]
  /** Só existe a versão convertida: o original não pode ser recriado a partir dela. */
  withoutOriginal: string[]
  /** Registrado no catálogo, mas sem arquivo em lugar nenhum. */
  missing: string[]
}

const keyOf = (dir: string, name: string) => `${dir.replace(/^\/+|\/+$/g, '')}/${name}`

export function planMedia(
  records: readonly MediaRecord[],
  files: ReadonlySet<string>,
  originals: ReadonlySet<string>,
): MediaPlan {
  const plan: MediaPlan = { work: [], withoutOriginal: [], missing: [] }
  for (const record of records) {
    const originalKey = keyOf(record.dir, record.name)
    const storedKey = keyOf(record.dir, record.fileName)
    const hasOriginal = originals.has(originalKey)
    const hasStored = files.has(storedKey)
    const base = { idFile: record.idFile, type: record.type, originalKey, storedKey }

    if (hasOriginal && hasStored) continue
    if (hasOriginal) {
      plan.work.push({ ...base, source: 'originals', copyOriginal: false })
    } else if (!hasStored) {
      plan.missing.push(originalKey)
    } else if (record.fileName === record.name) {
      // Acabou de ser importado: o que está em `files` ainda é o original.
      plan.work.push({ ...base, source: 'files', copyOriginal: true })
    } else {
      plan.withoutOriginal.push(originalKey)
    }
  }
  return plan
}

/** Nome do arquivo guardado, com a extensão trocada. */
export function withExtension(name: string, extension: string): string {
  const dot = name.lastIndexOf('.')
  return `${dot > 0 ? name.slice(0, dot) : name}.${extension}`
}
