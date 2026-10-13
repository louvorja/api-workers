export type MediaRecord = {
  idFile: number
  type: string
  dir: string
  name: string
  fileName: string
}

export type MediaWork = {
  key: string
  source: 'originals' | 'files'
  target: 'originals' | 'files'
}

export type MediaRepair = {
  idFile: number
  previousFileName: string
  fileName: string
  key: string
}

export type MediaPlan = {
  work: MediaWork[]
  repairs: MediaRepair[]
  duplicates: Array<{ key: string; canonicalKey: string }>
  withoutOriginal: string[]
  missing: string[]
}

const keyOf = (dir: string, name: string) =>
  `${dir.replace(/^\/+|\/+$/g, '')}/${name.replace(/^\/+/, '')}`

export function planMedia(
  records: readonly MediaRecord[],
  files: ReadonlySet<string>,
  originals: ReadonlySet<string>,
): MediaPlan {
  const plan: MediaPlan = {
    work: [],
    repairs: [],
    duplicates: [],
    withoutOriginal: [],
    missing: [],
  }
  const planned = new Set<string>()
  const availableKey = (record: MediaRecord) =>
    [keyOf(record.dir, record.fileName), keyOf(record.dir, record.name)].find(
      (key) => files.has(key) || originals.has(key),
    )
  const referenced = new Set(records.map((record) => availableKey(record)))
  const duplicateKeys = new Set<string>()
  const copy = (key: string, source: MediaWork['source'], target: MediaWork['target']) => {
    const id = `${target}/${key}`
    if (!planned.has(id)) {
      planned.add(id)
      plan.work.push({ key, source, target })
    }
  }

  for (const record of records) {
    const originalKey = keyOf(record.dir, record.name)
    const storedKey = keyOf(record.dir, record.fileName)
    const available = availableKey(record)
    if (!available) {
      plan.missing.push(storedKey)
      continue
    }

    if (!files.has(available)) copy(available, 'originals', 'files')
    if (available !== storedKey) {
      plan.repairs.push({
        idFile: record.idFile,
        previousFileName: record.fileName,
        fileName: record.name,
        key: available,
      })
    }

    if (!originals.has(originalKey)) {
      if (files.has(originalKey)) copy(originalKey, 'files', 'originals')
      else plan.withoutOriginal.push(originalKey)
    }

    // O Delphi histórico continua baixando o BMP, mesmo com JPEG no catálogo web.
    if (record.type !== 'music' && /\.bmp$/i.test(originalKey) && !files.has(originalKey)) {
      if (originals.has(originalKey)) copy(originalKey, 'originals', 'files')
      else plan.missing.push(originalKey)
    }

    if (
      record.type === 'music' &&
      /\.opus$/i.test(storedKey) &&
      /\.mp3$/i.test(originalKey) &&
      files.has(storedKey) &&
      files.has(originalKey) &&
      originals.has(originalKey) &&
      !referenced.has(originalKey) &&
      !duplicateKeys.has(originalKey)
    ) {
      plan.duplicates.push({ key: originalKey, canonicalKey: storedKey })
      duplicateKeys.add(originalKey)
    }
  }
  return plan
}
