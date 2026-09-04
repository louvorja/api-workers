const TYPES: Record<string, string> = {
  opus: 'audio/ogg',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  bmp: 'image/bmp',
  gif: 'image/gif',
  json: 'application/json',
  zip: 'application/zip',
  txt: 'text/plain; charset=UTF-8',
  html: 'text/html; charset=UTF-8',
}

export function mimeOf(key: string): string {
  const ext = key.slice(key.lastIndexOf('.') + 1).toLowerCase()
  return TYPES[ext] ?? 'application/octet-stream'
}
