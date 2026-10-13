/**
 * Documentação das chaves de `/json_db`, o caminho que todos os apps usam para
 * ler o catálogo e a Bíblia. Cada chave tem a própria entrada, com o formato
 * da resposta e um exemplo real, em vez de uma descrição única para todas.
 */
const TAG = 'Catálogo (json_db)'

const LANG = {
  name: 'lang',
  in: 'path',
  required: true,
  schema: { type: 'string', enum: ['pt', 'es'] },
  description: 'Idioma do conteúdo.',
} as const

const NOT_FOUND = {
  description: 'Chave inexistente.',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: { error: { type: 'string', example: 'Arquivo não encontrado!' } },
      },
    },
  },
} as const

const CACHE_DAY =
  'Cache: `private, max-age=86400`. Os apps acrescentam `?AAAAMMDD` (a data) à URL: ' +
  'a resposta é guardada por dia e renovada no seguinte.'

const ok = (description: string, schema: object, example: unknown) => ({
  200: { description, content: { 'application/json': { schema, example } } },
  404: NOT_FOUND,
})

const entry = (
  summary: string,
  description: string,
  parameters: readonly object[],
  responses: object,
) => ({ get: { tags: [TAG], summary, description, parameters, responses } })

const musicRow = {
  type: 'object',
  properties: {
    id_music: { type: 'integer' },
    name: { type: 'string' },
    has_instrumental_music: { type: 'integer', enum: [0, 1] },
    duration: { type: 'string', example: '00:02:17' },
    lyric: { type: 'string', description: 'Letra inteira, em texto corrido.' },
  },
} as const

export const jsonDbTag = {
  name: TAG,
  description:
    'Leitura do catálogo e da Bíblia, no formato que os apps usam. É o caminho principal: ' +
    'um arquivo JSON por chave, sem paginação, com o endereço completo de cada mídia.',
}

export const jsonDbPaths = {
  '/json_db': entry(
    'Índice de todas as chaves',
    'Lista cada chave disponível (≈18 mil, a maior parte capítulos da Bíblia), com o ' +
      '`hash` MD5 do conteúdo. Serve para saber o que mudou sem baixar tudo. ' +
      'Para instalar tudo de uma vez use `/db/bundle` ou `/db/catalog-bundle`.',
    [],
    ok(
      'Índice de chaves.',
      {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            file: { type: 'string' },
            table: { type: 'string' },
            path: { type: 'string' },
            hash: { type: 'string' },
          },
        },
      },
      [
        {
          file: 'pt_musics.json',
          table: 'pt_musics',
          path: '/db/pt_musics',
          hash: '71547d3ea192ddf87e2e42ca33e19456',
        },
      ],
    ),
  ),

  '/json_db/config': entry(
    'Versão do banco',
    'Pergunta "há banco novo?": compare `version_number` com o que o app tem. ' +
      'É a única chave sem cache (`private, no-cache`): responde o valor de agora, com ou sem ' +
      'a data na URL.',
    [],
    ok(
      'Versão atual do catálogo.',
      {
        type: 'object',
        properties: {
          version_number: { type: 'integer', example: 185 },
          version: { type: 'integer', description: 'Instante da última alteração (epoch).' },
          datetime: { type: 'string' },
          latest_updated: { type: 'string' },
        },
      },
      {
        datetime: '2026-08-26 00:00:06',
        latest_updated: '2026-08-25 20:48:43',
        version: 1787701723,
        version_number: 185,
      },
    ),
  ),

  '/json_db/{lang}_musics': entry(
    'Lista de músicas',
    `Todas as músicas do idioma (≈1.900 em \`pt\`, ≈620 em \`es\`), com a letra em texto corrido e os álbuns. Para a música completa, com as letras slide a slide e os arquivos, use \`/json_db/music_{id}\`. ${CACHE_DAY}`,
    [LANG],
    ok(
      'Lista de músicas.',
      {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ...musicRow.properties,
            albums_names: { type: 'string' },
            albums: { type: 'array', items: { type: 'object' } },
          },
        },
      },
      [
        {
          id_music: 1,
          name: 'Nosso Sol é Jesus',
          has_instrumental_music: 0,
          duration: '00:02:17',
          lyric: 'O nosso sol\r\nVeio iluminar…',
        },
      ],
    ),
  ),

  '/json_db/music_{id}': entry(
    'Música completa',
    `Uma música com a letra dividida em slides (\`lyric[]\`), as capas e os endereços de áudio. \`url_music\` e \`url_instrumental_music\` apontam direto para o armazenamento (\`files.louvorja.com.br\`): baixe de lá, não de \`/file\`. ${CACHE_DAY}`,
    [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, example: 1 }],
    ok(
      'Música com letras e mídia.',
      {
        type: 'object',
        properties: {
          id_music: { type: 'integer' },
          name: { type: 'string' },
          duration: { type: 'string' },
          instrumental_duration: { type: 'string', nullable: true },
          url_image: { type: 'string' },
          url_music: { type: 'string' },
          url_instrumental_music: { type: 'string', nullable: true },
          lyric: { type: 'array', items: { type: 'object' } },
          albums: { type: 'array', items: { type: 'object' } },
        },
      },
      {
        id_music: 1,
        name: 'Nosso Sol é Jesus',
        duration: '00:02:17',
        url_image: 'https://files.louvorja.com.br/images/hasd_132B.jpg',
        url_music:
          'https://files.louvorja.com.br/musics/pt/1992 - Brilha Jesus/Nosso Sol É Jesus.mp3',
        url_instrumental_music: null,
        lyric: [{ id_lyric: 1710, lyric: 'O nosso sol\r\nVeio iluminar' }],
      },
    ),
  ),

  '/json_db/album_{id}': entry(
    'Álbum com as faixas',
    `Um álbum com a capa, as categorias e a lista de faixas (\`musics[]\`, com \`track\`). ${CACHE_DAY}`,
    [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, example: 1 }],
    ok(
      'Álbum.',
      {
        type: 'object',
        properties: {
          id_album: { type: 'integer' },
          name: { type: 'string' },
          color: { type: 'string' },
          url_image: { type: 'string' },
          categories: { type: 'array', items: { type: 'string' } },
          musics: { type: 'array', items: { type: 'object' } },
        },
      },
      {
        id_album: 1,
        name: 'Nosso Sol é Jesus',
        color: '#C2442D',
        url_image: 'https://files.louvorja.com.br/covers/1992.jpg',
        categories: ['collection.aym'],
        musics: [
          {
            id_music: 1,
            name: 'Nosso Sol é Jesus',
            has_instrumental_music: 0,
            duration: '00:02:17',
            track: 1,
          },
        ],
      },
    ),
  ),

  '/json_db/{lang}_categories': entry(
    'Categorias com os álbuns',
    `As categorias da tela inicial (CDs oficiais, hinários, infantil…), cada uma com seus álbuns já embutidos. ${CACHE_DAY}`,
    [LANG],
    ok(
      'Categorias.',
      {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id_category: { type: 'integer' },
            name: { type: 'string' },
            slug: { type: 'string' },
            order: { type: 'integer' },
            albums: { type: 'array', items: { type: 'object' } },
          },
        },
      },
      [
        {
          id_category: 6,
          name: 'CDs Oficiais/Ano',
          slug: 'aym',
          order: 10,
          albums: [
            {
              id_album: 727,
              name: 'Meu Lugar no Mundo',
              color: '#1D1D1B',
              url_image: 'https://files.louvorja.com.br/covers/2026.jpg',
              subtitle: '2026',
              order: 90,
            },
          ],
        },
      ],
    ),
  ),

  '/json_db/{lang}_hymnal': entry(
    'Hinário corrente',
    `Os hinos, com número (\`track\`), letra e duração. ${CACHE_DAY}`,
    [LANG],
    ok(
      'Hinos.',
      {
        type: 'array',
        items: {
          type: 'object',
          properties: { ...musicRow.properties, track: { type: 'integer' } },
        },
      },
      [
        {
          id_music: 1728,
          name: 'Santo, Santo, Santo!',
          track: 1,
          has_instrumental_music: 1,
          duration: '00:02:17',
          lyric: 'Santo, santo, santo!…',
        },
      ],
    ),
  ),

  '/json_db/pt_hymnal_1996': entry(
    'Hinário de 1996',
    `Hinário anterior, só em português. Mesmo formato de \`{lang}_hymnal\`. ${CACHE_DAY}`,
    [],
    ok('Hinos.', { type: 'array', items: { type: 'object' } }, [
      { id_music: 274, name: 'Ó Deus de Amor', track: 1, has_instrumental_music: 1 },
    ]),
  ),

  '/json_db/{lang}_bible_version': entry(
    'Versões da Bíblia',
    `Versões disponíveis no idioma (≈10 em \`pt\`). O \`id_bible_version\` entra na chave dos capítulos. ${CACHE_DAY}`,
    [LANG],
    ok(
      'Versões.',
      {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id_bible_version: { type: 'integer' },
            name: { type: 'string' },
            abbreviation: { type: 'string' },
          },
        },
      },
      [{ id_bible_version: 13, name: 'Almeida Corrigida e Fiel', abbreviation: 'ACF' }],
    ),
  ),

  '/json_db/{lang}_bible_book': entry(
    'Livros da Bíblia',
    `Os 66 livros, com o número de capítulos (\`chapters\`), o testamento e a cor. O \`id_bible_book\` entra na chave dos capítulos. ${CACHE_DAY}`,
    [LANG],
    ok(
      'Livros.',
      {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id_bible_book: { type: 'integer' },
            book_number: { type: 'integer' },
            name: { type: 'string' },
            chapters: { type: 'integer' },
            testament: { type: 'integer' },
            abbreviation: { type: 'string' },
            color: { type: 'string' },
          },
        },
      },
      [
        {
          id_bible_book: 1,
          book_number: 1,
          name: 'Gênesis',
          chapters: 50,
          testament: 1,
          keywords: 'genesis',
          abbreviation: 'Gn',
          color: '#01a2d9',
        },
      ],
    ),
  ),

  '/json_db/bible_{version}_{book}_{chapter}': entry(
    'Capítulo da Bíblia',
    'Um capítulo: objeto cujas chaves são os números dos versículos. ' +
      'Monte a chave com `id_bible_version`, `id_bible_book` e o número do capítulo. ' +
      'São ≈15 mil capítulos: para a Bíblia inteira use `/db/bible-bundle` (um ZIP só). ' +
      'Há um limite de **150 capítulos por minuto por IP**; passado o limite a resposta é 429 ' +
      'depois de ~8 s, com `Retry-After`. Cache: `public, max-age=86400`.',
    [
      { name: 'version', in: 'path', required: true, schema: { type: 'integer' }, example: 1 },
      { name: 'book', in: 'path', required: true, schema: { type: 'integer' }, example: 1 },
      { name: 'chapter', in: 'path', required: true, schema: { type: 'integer' }, example: 1 },
    ],
    {
      ...ok(
        'Versículos do capítulo.',
        { type: 'object', additionalProperties: { type: 'string' } },
        {
          1: 'NO princípio criou Deus os céus e a terra.',
          2: 'E a terra era sem forma e vazia…',
        },
      ),
      429: { description: 'Mais de 150 capítulos por minuto neste IP. Use `/db/bible-bundle`.' },
    },
  ),

  '/json_db/{lang}_collections_online': entry(
    'Vídeos online (canais, playlists e vídeos)',
    `Catálogo de vídeos do YouTube: \`channels[]\`, \`playlists[]\` e \`videos[]\`. Substitui \`/{lang}/collections/online\`. ${CACHE_DAY}`,
    [LANG],
    ok(
      'Catálogo de vídeos.',
      {
        type: 'object',
        properties: {
          channels: { type: 'array', items: { type: 'object' } },
          playlists: { type: 'array', items: { type: 'object' } },
          videos: { type: 'array', items: { type: 'object' } },
        },
      },
      {
        channels: [{ channel_id: 'UC…', title: 'Feliz7Play', custom_url: '@feliz7play' }],
        playlists: [],
        videos: [],
      },
    ),
  ),

  '/json_db/{lang}_doxology_albums': entry(
    'Álbuns de doxologia',
    `Lista inteira, sem paginação. Substitui \`/{lang}/albums/category/doxology\`. ${CACHE_DAY}`,
    [LANG],
    ok('Álbuns.', { type: 'array', items: { type: 'object' } }, [
      {
        id_album: 680,
        name: 'Entrada da Plataforma',
        url_image: 'https://files.louvorja.com.br/covers/pessoas.jpg',
        color: '',
        order: 1,
      },
    ]),
  ),

  '/json_db/{lang}_children_albums': entry(
    'Álbuns infantis',
    `Lista inteira, sem paginação. Substitui \`/{lang}/albums/category/children\`. ${CACHE_DAY}`,
    [LANG],
    ok('Álbuns.', { type: 'array', items: { type: 'object' } }, [
      { id_album: 690, name: 'Músicas Infantis', color: '', order: 1 },
    ]),
  ),

  '/json_db/{key}': entry(
    'Qualquer chave do catálogo',
    'Forma genérica: devolve o JSON da chave pedida (veja as demais entradas desta seção e ' +
      '`GET /json_db` para a lista). Convenções comuns:\n\n' +
      '- **Sem autenticação.** O cabeçalho `Api-Token` é ignorado; não envie, ele só obriga o ' +
      'navegador a fazer um pré-voo `OPTIONS` antes de cada GET.\n' +
      '- **CORS aberto** (`Access-Control-Allow-Origin: *`).\n' +
      '- **Mídia:** os campos `url_*` trazem o endereço completo, direto em ' +
      '`files.louvorja.com.br`. Não monte `/file/...` (será descontinuado).\n' +
      '- **Chave inexistente:** `404` com `{"error": "Arquivo não encontrado!"}`.\n' +
      '- **Chave fora do padrão** `^[a-zA-Z0-9_-]+$`: `404`.',
    [
      {
        name: 'key',
        in: 'path',
        required: true,
        schema: { type: 'string', pattern: '^[a-zA-Z0-9_-]+$' },
        example: 'pt_categories',
      },
    ],
    { 200: { description: 'Conteúdo da chave.' }, 404: NOT_FOUND },
  ),
} as const
