const LANG = {
  name: 'lang',
  in: 'path',
  required: true,
  schema: { type: 'string', enum: ['pt', 'es'] },
  description: 'Idioma do conteúdo.',
} as const

const PAGE = {
  name: 'page',
  in: 'query',
  required: false,
  schema: { type: 'integer', minimum: 1, default: 1 },
  description: 'Página, no formato de paginação do Laravel (15 por página).',
} as const

const ID = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'integer' },
} as const

const NOT_FOUND = {
  description: 'Recurso inexistente.',
  content: {
    'application/json': {
      schema: {
        type: 'object',
        properties: { error: { type: 'string', example: 'Arquivo não encontrado!' } },
      },
    },
  },
} as const

const paginated = (summary: string, tag: string) => ({
  tags: [tag],
  summary,
  parameters: [LANG, PAGE],
  responses: {
    200: {
      description: 'Página de resultados.',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              current_page: { type: 'integer' },
              data: { type: 'array', items: { type: 'object' } },
              last_page: { type: 'integer' },
              per_page: { type: 'integer', example: 15 },
              total: { type: 'integer' },
              links: { type: 'array', items: { type: 'object' } },
            },
          },
        },
      },
    },
    404: NOT_FOUND,
  },
})

const collections: Record<string, string> = {
  musics: 'Músicas do catálogo',
  albums: 'Álbuns e coletâneas',
  categories: 'Categorias',
  hymnal: 'Hinário corrente',
  lyrics: 'Letras, slide a slide',
  files: 'Registro de arquivos de mídia',
  albums_musics: 'Associações álbum-música',
  categories_albums: 'Associações categoria-álbum',
  languages: 'Idiomas disponíveis',
}

const restPaths = Object.fromEntries(
  Object.entries(collections).map(([name, summary]) => [
    `/{lang}/${name}`,
    { get: paginated(summary, 'REST') },
  ]),
)

export const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'LouvorJA API',
    version: '1.0.0',
    description: [
      'Réplica de leitura de `api.louvorja.com.br`, rodando em Cloudflare Workers',
      'com o acervo em R2.',
      '',
      '**O que esta API é.** Uma camada de leitura, rápida e sem estado. Todo o',
      'conteúdo é estático: JSONs do banco e mídia. Não há autenticação porque',
      'não há nada para escrever.',
      '',
      '**O que ela não tem.** As rotas `/auth/*`, `/admin/*` e `/tasks/*` da API',
      'original não existem aqui — elas dependem do banco relacional e continuam',
      'no servidor de origem, que também é quem gera os JSONs servidos por',
      '`/json_db` e `/db`.',
      '',
      '**Diferenças deliberadas em relação à origem:**',
      '- O áudio é servido em Opus e as capas em JPEG; URLs `.mp3` e `.bmp`',
      '  continuam resolvendo, por compatibilidade com clientes antigos.',
      '- Requisições `Range` devolvem `206` de verdade. A origem ignora o header',
      '  e manda o arquivo inteiro.',
      '- O `404` não expõe o caminho do arquivo no servidor, e `/{lang}/config`',
      '  não expõe o caminho do banco.',
      '- `Access-Control-Allow-Credentials` foi removido: junto de',
      '  `Allow-Origin: *` ele é rejeitado por qualquer navegador.',
      '- `/ftp` responde `410`: o download por FTP foi substituído por HTTPS.',
    ].join('\n'),
  },
  servers: [{ url: 'https://api.louvorja.workers.dev', description: 'Produção' }],
  tags: [
    { name: 'Banco estático', description: 'Export JSON consumido pelos apps.' },
    { name: 'Arquivos', description: 'Áudio, imagens e capas.' },
    { name: 'REST', description: 'Leitura paginada, no formato da API de origem.' },
    { name: 'Sistema', description: 'Metadados, versão e diagnóstico.' },
  ],
  paths: {
    '/json_db/{key}': {
      get: {
        tags: ['Banco estático'],
        summary: 'Tabela JSON no formato plano (legado)',
        description:
          'Formato consumido pelos apps LouvorJA. Chaves: `config`, ' +
          '`{pt,es}_{categories,musics,hymnal,bible_book,bible_version}`, ' +
          '`pt_hymnal_1996`, `album_{id}`, `music_{id}` e ' +
          '`bible_{versão}_{livro}_{capítulo}`.',
        parameters: [
          {
            name: 'key',
            in: 'path',
            required: true,
            schema: { type: 'string', pattern: '^[a-zA-Z0-9_-]+$' },
            example: 'pt_categories',
          },
        ],
        responses: { 200: { description: 'Conteúdo da tabela.' }, 404: NOT_FOUND },
      },
    },
    '/db/manifest': {
      get: {
        tags: ['Banco estático'],
        summary: 'Índice das tabelas, com hash MD5',
        description: 'Use o `hash` para sincronizar só o que mudou.',
        responses: { 200: { description: '18.060 entradas.' } },
      },
    },
    '/db/bundle': {
      get: {
        tags: ['Banco estático'],
        summary: 'ZIP com todas as tabelas',
        description: 'Uma requisição em vez de 18.060. É como a ingestão se abastece.',
        responses: { 200: { description: 'application/zip.' }, 404: NOT_FOUND },
      },
    },
    '/db/{table}': {
      get: {
        tags: ['Banco estático'],
        summary: 'Tabela JSON no formato novo, paginado',
        description: 'Mesmo conteúdo de `/json_db/{key}`, embrulhado em `{ data, meta }`.',
        parameters: [
          { name: 'table', in: 'path', required: true, schema: { type: 'string' } },
          PAGE,
          {
            name: 'per_page',
            in: 'query',
            required: false,
            schema: { type: 'integer', default: 50 },
          },
        ],
        responses: { 200: { description: 'Registros da tabela.' }, 404: NOT_FOUND },
      },
    },
    '/file/{path}': {
      get: {
        tags: ['Arquivos'],
        summary: 'Servir mídia do acervo',
        description:
          'Prefixos válidos: `covers/`, `images/` e `musics/`. Aceita `Range` e ' +
          'devolve `206`. URLs `.mp3` e `.bmp` resolvem para `.opus` e `.jpg`.',
        parameters: [
          {
            name: 'path',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            example: 'musics/pt/Adoradores 5/Digno.opus',
          },
        ],
        responses: {
          200: { description: 'Arquivo completo.' },
          206: { description: 'Trecho, em resposta a `Range`.' },
          404: NOT_FOUND,
        },
      },
    },
    '/params': {
      get: {
        tags: ['Sistema'],
        summary: 'Parâmetros da aplicação',
        description: 'JSON por padrão; `?type=env` devolve INI, como o instalador espera.',
        parameters: [
          {
            name: 'type',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['json', 'env'] },
          },
        ],
        responses: { 200: { description: 'Parâmetros.' } },
      },
    },
    '/version_log': {
      get: {
        tags: ['Sistema'],
        summary: 'Changelog do app desktop',
        responses: { 200: { description: 'HTML.' } },
      },
    },
    '/onlinevideos': {
      get: {
        tags: ['Sistema'],
        summary: 'Catálogo de vídeos online',
        responses: { 200: { description: 'Texto.' } },
      },
    },
    '/health': {
      get: {
        tags: ['Sistema'],
        summary: 'Diagnóstico',
        responses: { 200: { description: 'Status dos serviços.' } },
      },
    },
    '/version': {
      get: {
        tags: ['Sistema'],
        summary: 'Versão da API',
        responses: { 200: { description: 'Versões.' } },
      },
    },
    '/metadata': {
      get: {
        tags: ['Sistema'],
        summary: 'Metadados da Bíblia',
        responses: { 200: { description: 'Versões e contagem de versículos.' } },
      },
    },
    '/ftp': {
      get: {
        tags: ['Sistema'],
        summary: 'Descontinuado',
        description: 'Responde `410`. Baixe mídia por HTTPS em `/file/{path}`.',
        responses: { 410: { description: 'FTP descontinuado.' } },
      },
    },
    '/{lang}/config': {
      get: {
        tags: ['REST'],
        summary: 'Configurações da aplicação',
        parameters: [LANG],
        responses: { 200: { description: 'Configurações.' }, 404: NOT_FOUND },
      },
    },
    '/{lang}/musics/{id}': {
      get: {
        tags: ['REST'],
        summary: 'Música por id, com a letra slide a slide',
        parameters: [LANG, ID],
        responses: { 200: { description: 'Música.' }, 404: NOT_FOUND },
      },
    },
    '/{lang}/albums/{id}': {
      get: {
        tags: ['REST'],
        summary: 'Álbum por id',
        parameters: [LANG, ID],
        responses: { 200: { description: 'Álbum.' }, 404: NOT_FOUND },
      },
    },
    '/{lang}/albums/category/{slug}': {
      get: {
        tags: ['REST'],
        summary: 'Álbuns de uma categoria, por slug',
        parameters: [
          LANG,
          { name: 'slug', in: 'path', required: true, schema: { type: 'string' }, example: 'aym' },
          PAGE,
        ],
        responses: { 200: { description: 'Página de álbuns.' }, 404: NOT_FOUND },
      },
    },
    '/{lang}/categories/{id}/albums': {
      get: {
        tags: ['REST'],
        summary: 'Álbuns de uma categoria, por id',
        parameters: [LANG, ID, PAGE],
        responses: { 200: { description: 'Página de álbuns.' }, 404: NOT_FOUND },
      },
    },
    '/{lang}/collections/online': {
      get: {
        tags: ['REST'],
        summary: 'Catálogo de conteúdo online',
        parameters: [LANG],
        responses: { 200: { description: 'Catálogo.' } },
      },
    },
    '/{lang}/download': {
      get: {
        tags: ['Sistema'],
        summary: 'Redireciona para o instalador do desktop',
        parameters: [LANG],
        responses: {
          302: { description: 'Redirecionamento para o GitHub Releases.' },
          404: NOT_FOUND,
        },
      },
    },
    '/{lang}/hymnal/{id}': {
      get: {
        tags: ['REST'],
        summary: 'Hino por id',
        description: 'Devolve a linha do hinário, sem envelope. Id que não seja hino dá 404.',
        parameters: [LANG, ID],
        responses: { 200: { description: 'Hino.' }, 404: NOT_FOUND },
      },
    },
    '/{lang}/categories/{id}/albums-with-musics': {
      get: {
        tags: ['REST'],
        summary: 'Categoria com álbuns e suas músicas',
        description: 'Resposta única, sem paginação: `{ category, albums }`.',
        parameters: [LANG, ID],
        responses: { 200: { description: 'Categoria expandida.' }, 404: NOT_FOUND },
      },
    },
    '/player': {
      get: {
        tags: ['Sistema'],
        summary: 'Página de player do YouTube',
        description:
          'O id é validado contra o alfabeto do YouTube antes de entrar no HTML. ' +
          'A origem interpola o parâmetro cru, o que permite injeção.',
        parameters: [
          {
            name: 'v',
            in: 'query',
            required: false,
            schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,32}$' },
          },
        ],
        responses: { 200: { description: 'HTML com o iframe.' } },
      },
    },
    ...restPaths,
  },
}
