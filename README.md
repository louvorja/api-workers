# LouvorJA API — Workers

Réplica de leitura da [LouvorJA API](https://github.com/louvorja/api) em
Cloudflare Workers, servindo o acervo a partir do R2. Cobre as rotas públicas
usadas pelos apps; o CMS continua no repositório de origem.

## Documentação Interativa

- **Swagger UI:** `/documentation`
- **OpenAPI JSON:** `/openapi.json`

## Base URL

```
https://api.louvorja.workers.dev
```

## Autenticação

Nenhuma. Todo o conteúdo é público e somente leitura — não há nada para
escrever. O header `Api-Token` é aceito e ignorado, por compatibilidade.

---

## Endpoints

### Documentação

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/openapi.json` | Spec OpenAPI 3.0 (JSON) |
| GET | `/documentation` | Swagger UI (HTML) |

### Público (sem autenticação)

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/metadata` | Metadados da Bíblia |
| GET | `/player` | Página do player YouTube |
| GET | `/download` | Redirect (302) p/ download do instalador desktop |
| GET | `/version` | Versão da API |
| GET | `/version_log` | Log de versões |
| GET | `/health` | Health check |
| GET | `/file/{path}` | Abrir arquivo estático |
| GET | `/json_db` | Manifest dos bancos JSON exportados |
| GET | `/json_db/{file}` | Download de arquivo JSON exportado |
| GET | `/db/manifest` | Manifest com hash MD5 de cada tabela |
| GET | `/db/bundle` | ZIP com as 18.060 tabelas |
| GET | `/db/{table}` | Registros de uma tabela (`{ data, meta }`) |
| GET | `/params` | Parâmetros do sistema (`?type=env` devolve INI) |
| GET | `/onlinevideos` | Vídeos online (YouTube) |
| GET | `/ftp` | Descontinuado — responde 410 |

### Público por idioma (`/{lang}/...`)

Idiomas disponíveis: `pt` e `es`.

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/{lang}` | Raiz do idioma |
| GET | `/{lang}/languages` | Idiomas disponíveis |
| GET | `/{lang}/config` | Configurações |
| GET | `/{lang}/configs` | Configurações (alias) |
| GET | `/{lang}/musics` | Listar músicas |
| GET | `/{lang}/musics/{id}` | Buscar música por ID |
| GET | `/{lang}/music/{id}` | Buscar música por ID (alias) |
| GET | `/{lang}/categories` | Listar categorias |
| GET | `/{lang}/categories/{id}/albums` | Álbuns de uma categoria |
| GET | `/{lang}/categories/{id}/albums-with-musics` | Categoria com álbuns e músicas |
| GET | `/{lang}/categories_albums` | Listar categorias-álbuns |
| GET | `/{lang}/albums` | Listar álbuns |
| GET | `/{lang}/albums/{id}` | Buscar álbum por ID |
| GET | `/{lang}/album/{id}` | Buscar álbum por ID (alias) |
| GET | `/{lang}/albums/category/{slug}` | Álbuns por slug de categoria |
| GET | `/{lang}/albums_musics` | Listar associações álbum-música |
| GET | `/{lang}/hymnal` | Listar hinário |
| GET | `/{lang}/hymnal/{id}` | Buscar hino por ID |
| GET | `/{lang}/lyrics` | Listar letras |
| GET | `/{lang}/files` | Listar arquivos |
| GET | `/{lang}/collections/online` | Coleção de conteúdo online |
| GET | `/{lang}/download` | Redirect (302) por idioma |

### Fora de escopo

`/auth/*`, `/admin/*` e `/tasks/*` não existem aqui. Dependem do banco
relacional e continuam em [louvorja/api](https://github.com/louvorja/api) —
que é, inclusive, quem **gera** os JSONs servidos por `/json_db` e `/db`, via
`/tasks/generate_static_jsons`.

## Parâmetros Comuns de Query

| Parâmetro | Descrição |
|-----------|-----------|
| `page` | Paginação. Padrão: `1` |
| `per_page` | Itens por página. Somente em `/db/{table}`. Padrão: `50` |
| `type` | Somente em `/params`: `json` (padrão) ou `env` |

---

## Diferenças em relação à origem

Nenhuma é acidental; todas estão descritas no `/openapi.json`.

| Diferença | Motivo |
|-----------|--------|
| Áudio em Opus, capas em JPEG | Bitrate escolhido pelo da fonte. URLs `.mp3` e `.bmp` continuam resolvendo, para clientes com cache antigo |
| `Range` devolve `206` de verdade | A origem ignora o header e manda o arquivo inteiro |
| `404` sem o caminho do arquivo | A origem expõe o caminho absoluto no servidor |
| `/{lang}/config` sem `*_path_database` | A origem expõe o caminho do banco |
| Sem `Access-Control-Allow-Credentials` | Junto de `Allow-Origin: *` é rejeitado por qualquer navegador |
| `/player` valida o id do vídeo | A origem interpola o parâmetro cru dentro do atributo do `iframe` |
| `/ftp` responde `410` | O desktop já baixa mídia por HTTPS |

Um player fazendo 8 buscas numa faixa transferia **16,8 MB em 1.752 ms** na
origem, contra **0,4 MB em 316 ms** aqui.

## Formato de Resposta

**Sucesso:**
```json
{
  "data": { ... }
}
```

**Listagem paginada** (formato Laravel, 15 por página):
```json
{
  "current_page": 1,
  "data": [ ... ],
  "last_page": 41,
  "per_page": 15,
  "total": 601,
  "links": [ ... ]
}
```

**Erro:**
```json
{
  "error": "Arquivo não encontrado!"
}
```

## Códigos de Status HTTP

| Código | Descrição |
|--------|-----------|
| 200 | Sucesso |
| 206 | Conteúdo parcial (resposta a `Range`) |
| 302 | Redirect (`/download`) |
| 304 | Não modificado |
| 404 | Não encontrado |
| 410 | Descontinuado (`/ftp`) |
| 500 | Erro interno |

## Stack

- **Runtime:** Cloudflare Workers (`workerd`) — sem Node
- **Framework:** Hono 4
- **Armazenamento:** R2 (bucket `files`), sem banco de dados
- **Cache:** Workers Caching, com fatiamento de `Range` na borda
- **Testes:** Vitest sobre `@cloudflare/vitest-pool-workers`
- **Lint/format:** Biome

Bundle de ~87 KiB, startup de 8 ms.

```
src/
  index.ts        wiring do Hono
  features/       json-db, db, files, params, rest, legacy
  lib/            http, r2, mime, paginate
  openapi.ts      spec servida em /openapi.json
scripts/          ingestão e manutenção do acervo (Node, local)
```

O bucket guarda mídia em `covers/`, `images/` e `musics/`; o export do banco em
`json_db/`; o snapshot da camada REST em `rest/`; e `params`, `manifest` e
`bundle.zip` em `meta/`.

## Desenvolvimento Local

```bash
# Instalar dependências
npm install

# Configurar credenciais do R2
cp .env.example .env

# Iniciar servidor de desenvolvimento
npm run dev

# Acessar Swagger UI
# http://localhost:8787/documentation
```

| Comando | Descrição |
|---------|-----------|
| `npm run deploy` | Type-check e deploy |
| `npm test` | Testes sobre o runtime real |
| `npm run ingest` | Espelha o banco JSON para o R2 |
| `npm run ingest:rest` | Snapshot da camada REST |
| `npm run sync:media` | Baixa e transcodifica mídia faltante |
| `npm run covers` | Converte capas `.bmp` para `.jpg` |
| `npm run parity` | Compara resposta a resposta com a origem |
| `npm run bench` | Mede latência e banda contra a origem |

A ingestão é guiada por `/db/manifest` e se abastece do `/db/bundle`. Comparando
o MD5 de cada tabela, uma reexecução regrava só o que mudou, em vez de fazer
18.060 requisições à origem.

## Repositório

- **GitHub:** https://github.com/louvorja/api-workers
- **Issues:** https://github.com/louvorja/api-workers/issues

## Licença

Este projeto está sob licença proprietária.
