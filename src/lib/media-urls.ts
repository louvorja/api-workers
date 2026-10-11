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
 * - `current`: apps atuais. Tudo sai do armazenamento, com o nome exato do
 *   arquivo guardado.
 * - `legacy`: app web antigo e app Android. O áudio sai sempre em `.mp3`, do
 *   armazenamento dos originais, porque navegadores de iPhones mais velhos não
 *   tocam Opus. Capas e imagens continuam pela API, como a API antiga fazia.
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

const MEDIA_FIELD = /"(url_[a-z_]+)":"\/(covers|images|musics)\/((?:[^"\\]|\\.)*)"/g

/** Troca os caminhos de mídia de um JSON do catálogo pelos endereços completos. */
export function withMediaUrls(text: string, variant: MediaVariant): string {
  // A maior tabela (a lista de músicas) não tem mídia: evita varrê-la à toa.
  if (!text.includes('"url_')) return text
  return text.replace(MEDIA_FIELD, (_match, key: string, dir: string, rest: string) => {
    if (variant === 'current') return `"${key}":"${FILES_URL}/${dir}/${rest}"`
    return dir === 'musics'
      ? `"${key}":"${ORIGINALS_URL}/musics/${rest.replace(/\.opus$/, '.mp3')}"`
      : `"${key}":"https://${LEGACY_HOST}/file/${dir}/${rest}"`
  })
}
