const MEDIA_PREFIXES = ['covers/', 'images/', 'musics/']

/** Converte caminho relativo ou URL completa em uma chave de mídia do bucket. */
export function mediaPath(value: string): string | null {
  let pathname = value.trim()
  if (!pathname) return null

  if (/^https?:\/\//i.test(pathname)) {
    try {
      pathname = new URL(pathname).pathname
    } catch {
      return null
    }
  } else if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(pathname)) {
    return null
  }

  try {
    pathname = decodeURIComponent(pathname)
  } catch {
    return null
  }

  pathname = pathname
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^file\//i, '')
  if (!MEDIA_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return null
  if (pathname.split('/').some((part) => part === '..')) return null
  return pathname
}

export function normalizedMediaPath(value: string): string | null {
  const path = mediaPath(value)
  if (!path) return null
  if (path.toLowerCase().endsWith('.mp3')) return `${path.slice(0, -4)}.opus`
  if (path.toLowerCase().endsWith('.bmp')) return `${path.slice(0, -4)}.jpg`
  return path
}
