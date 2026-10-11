/**
 * Endereços de mídia do catálogo.
 *
 * O catálogo é guardado com o caminho do arquivo dentro do armazenamento
 * ("/musics/..."). Quem lê recebe o endereço completo, direto no armazenamento:
 * arquivo entregue pela API conta na cota diária de requisições do Worker.
 */

/** Domínio da API antiga. Quem chega por ele é cliente antigo. */
export const LEGACY_HOST = 'api.louvorja.com.br'

/** Bucket `files`: a melhor versão de cada arquivo (Opus ou MP3, JPEG). */
export const FILES_URL = 'https://files.louvorja.com.br'

/** Bucket `files-original`: os MP3 originais de todo o acervo. */
export const ORIGINALS_URL = 'https://mp3.louvorja.com.br'

/**
 * Capas e imagens saem sempre de `FILES_URL`. Só o áudio muda:
 *
 * - `current`: apps atuais. O arquivo guardado, com o nome exato (Opus ou MP3).
 * - `legacy`: app web antigo e app Android. Sempre `.mp3`, do armazenamento
 *   dos originais, porque navegadores de iPhones mais velhos não tocam Opus.
 */
export type MediaVariant = 'current' | 'legacy'

export const mediaVariantFor = (hostname: string): MediaVariant =>
  hostname === LEGACY_HOST ? 'legacy' : 'current'

/** Pacote do catálogo com os endereços de cada variante já escritos. */
export const BUNDLE_KEY = 'meta/bundle.zip'
export const BUNDLE_VARIANT_KEYS: Record<MediaVariant, string> = {
  current: 'meta/bundle-files.zip',
  legacy: 'meta/bundle-legacy.zip',
}

const MEDIA_FIELD = /"(url(?:_[a-z_]+)?)":("(?:[^"\\]|\\.)*")/g
const MEDIA_PATH =
  /^(?:(?:https:\/\/(?:api\.louvorja\.workers\.dev|api\.louvorja\.com\.br))?\/file|https:\/\/files\.louvorja\.com\.br)?\/(covers|images|musics)\/(.+)$/

/** Só endereços do nosso acervo; URLs externas e links de paginação ficam intactos. */
export function catalogMediaPath(value: string): string | null {
  const match = MEDIA_PATH.exec(value)
  return match ? `${match[1]}/${match[2]}` : null
}

/** Troca os caminhos de mídia de um JSON do catálogo pelos endereços completos. */
export function withMediaUrls(text: string, variant: MediaVariant): string {
  // A maior tabela (a lista de músicas) não tem mídia: evita varrê-la à toa.
  if (!text.includes('"url')) return text
  return text.replace(MEDIA_FIELD, (match, key: string, encoded: string) => {
    const path = catalogMediaPath(JSON.parse(encoded) as string)
    if (path === null) return match
    const url =
      variant === 'legacy' && path.startsWith('musics/')
        ? `${ORIGINALS_URL}/${path.replace(/\.opus(?=[?#]|$)/, '.mp3')}`
        : `${FILES_URL}/${path}`
    return `"${key}":${JSON.stringify(url)}`
  })
}
