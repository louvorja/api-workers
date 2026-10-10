# LouvorJA API — Cloudflare Workers

Substituição da API PHP do LouvorJA. O Worker mantém os contratos HTTP usados
pelos apps, o painel administra o catálogo no D1 e o R2 guarda a mídia e os
arquivos que os apps leem.

- API: `https://api.louvorja.workers.dev`
- Swagger UI: `/documentation`
- OpenAPI: `/openapi.json`
- Painel: pasta [`admin/`](admin/), publicada como o Worker estático `adm`
  (`https://adm.louvorja.workers.dev`).

Tudo roda no plano gratuito da Cloudflare. As decisões abaixo existem para
caber nele; mude-as sabendo o que cada uma protege.

## Arquitetura

| Parte | Responsabilidade |
| --- | --- |
| Worker + Hono | Rotas públicas, autenticação, CRUD administrativo e despacho de tarefas |
| D1 | Fonte da verdade do catálogo, usuários e auditoria — usado só pelo painel |
| R2 | Mídia, JSONs públicos, pacotes ZIP e parâmetros — o que os apps leem |
| GitHub Actions | Jobs longos: publicação, reconciliação, YouTube e importação de slides |

O caminho de um dado: o painel grava no D1; a publicação exporta o D1, gera os
arquivos e os envia ao R2; os apps leem do R2 através do Worker.

### As rotas públicas não tocam o D1

No plano gratuito o D1 para de responder quando a cota diária estoura (5
milhões de linhas lidas, 100 mil escritas), e as rotas públicas não têm
autenticação. Por isso:

- leitura: toda rota pública responde a partir dos snapshots do R2, inclusive
  os filtros relacionais (`id_album`, `categories_slug`, `with_albums`,
  `with_categories`) e `/onlinevideos`;
- escrita: a única exceção é o registro de `/download`, limitado a 500 por dia
  por um contador (`public_write_budget`). Passado o teto, nada mais é gravado.

`test/legacy-routes.test.ts` falha se uma rota pública voltar a consultar o
banco. `/health` faz um `SELECT 1`, que não lê linha nenhuma.

### Cache

Cada resposta sem cache é uma requisição a mais no teto diário de 100 mil do
plano gratuito (resposta `304` também conta). O catálogo fica em cache no
cliente e na borda:

| Rotas | Cache |
| --- | --- |
| `/json_db/*`, `/db/bible-bundle` | um dia |
| `/db/*`, `/{lang}/*`, `/params`, `/onlinevideos` | uma hora |
| `/file/*` | um ano (nome estável) |
| `/auth/*`, `/admin/*`, `/tasks/*`, `/health`, erros | sem cache |

O app acrescenta a data à URL de `/json_db` e um carimbo único quando o
operador pede para atualizar, então o cache não segura conteúdo velho além do
dia.

### Sem FTP e sem Bíblia no banco

- O download por FTP foi descontinuado. Workers não recebe conexões FTP, e
  manter um servidor à parte duplicaria o acervo. `/ftp` responde `410` com a
  indicação de baixar por HTTPS em `/file`. O banco SQLite do programa Delphi
  também não é gerado.
- A Bíblia não é editada pelo painel: os 404 mil versículos ficam como estão no
  R2 e a publicação não toca neles. `seed-d1.ts --bible` existe, mas carregá-los
  ocuparia cerca de 11 dias da cota de escrita e não é parte do plano.

## Contratos atendidos

As rotas públicas incluem `/params`, `/onlinevideos`, `/file/*`, `/json_db/*`,
`/db/*`, `/metadata`, `/download`, `/version`, `/version_log`, `/player` e as
coleções sob `/{pt,es}/...`.

O painel usa:

- `/auth/login`, refresh, logout, usuário atual e troca de senha;
- CRUD de usuários, categorias, vínculos, álbuns, músicas e letras em `/admin`;
- consulta de arquivos em `/admin/files`;
- `/tasks/*`, que agenda o workflow `maintenance.yml`.

As listagens públicas preservam a paginação do Laravel e os filtros legados
(`like:`, `orlike:`, `or:`, `sort_by`, `limit`, relações e idioma). As
operações administrativas exigem JWT.

## Publicação

O D1 é a fonte da verdade. Uma publicação:

1. exporta o D1 para uma réplica SQL;
2. gera os JSONs de `/json_db` e a camada REST e compara com o que está no R2;
3. envia só o que mudou, refaz o ZIP e o manifesto;
4. se o conteúdo mudou, sobe a versão em `meta/params.json` e, por último, no D1.

Sem `--write` o script só mostra o que faria.

```bash
npx wrangler d1 export louvorja --remote --output=replica.sql
npm run cutover:check -- --export=replica.sql
npm run publish -- --export=replica.sql
npm run publish -- --export=replica.sql --write
```

`publish` para antes de ler ou gravar o R2 quando a réplica não tem ao menos um
administrador com senha no formato aceito.

`npm run catalog:diff` compara o que o banco gera com o que está publicado, byte
a byte, e falha se sobrar diferença sem explicação.

## Administrador inicial e senhas do PHP

Usuários e logs são dados operacionais do D1; o `d1:seed` carrega só o catálogo.
A autenticação aceita `pbkdf2-sha256$100000`. Os hashes bcrypt do Laravel não são
compatíveis nem convertidos: contas antigas precisam de senha nova.

Antes da primeira publicação, crie um administrador. O SQL gerado deixa a senha
como temporária e não deve ser versionado:

```bash
umask 077
read -s LOUVORJA_USER_PASSWORD
export LOUVORJA_USER_PASSWORD
ADMIN_SQL="$(mktemp)"
npm run --silent d1:user -- \
  --name="Administrador" \
  --username=admin-worker \
  --email=admin-worker@example.com \
  --admin > "$ADMIN_SQL"
unset LOUVORJA_USER_PASSWORD
npx wrangler d1 execute louvorja --remote --file="$ADMIN_SQL"
rm -f "$ADMIN_SQL"
```

Depois, confirme o login e a troca obrigatória da senha temporária no painel.

## Migrations

As migrations de produção são aplicadas à mão, nunca pelo workflow:

```bash
npx wrangler d1 migrations apply louvorja --remote
```

`0002_row_counts.sql` cria gatilhos que somam uma escrita por linha inserida.
Aplique-a só depois de terminar a carga inicial das letras.

## Tarefas de manutenção

| Comando | Função |
| --- | --- |
| `npm run cutover:check` | Exige um administrador com senha válida na réplica |
| `npm run publish` | Gera e publica os snapshots |
| `npm run publish:gate` | Diz se o painel alterou algo desde a última publicação |
| `npm run catalog:diff` | Audita o que o banco gera contra o que está publicado |
| `npm run files:reconcile` | Confere tamanho no R2 e duração com `ffprobe` |
| `npm run online-videos:refresh` | Atualiza canais, playlists e vídeos do YouTube |
| `npm run slides:import` | Importa `.slja/.lja` com áudio e imagens |

O workflow `maintenance.yml` executa esses jobs fora do limite curto do Worker;
as rotas `/tasks/*` só fazem um `workflow_dispatch` autenticado. O agendamento
(de hora em hora) fica desligado até a variável `MAINTENANCE_SCHEDULE` do
repositório valer `on` — ligue depois de conferir a primeira publicação manual.

Exportar o banco não é de graça: cada export conta, na cota diária de leitura
do D1, uma linha por linha exportada (medido: 62.829 linhas lidas para 62.829
exportadas). Por isso a rotina de hora em hora começa por `publish:gate`, que
compara o maior id da auditoria com a marca deixada pela última publicação e
custa uma linha. Sem alteração do painel ela para ali; uma vez por dia roda
inteira. Carga feita direto no banco não passa pela auditoria: depois dela,
dispare a tarefa `publish` à mão.

## Desenvolvimento

Requisitos: Node 22, `zip`, `unzip` e `ffprobe` (pacote `ffmpeg`).

```bash
npm ci
cp .env.example .env
npm run dev          # API em http://localhost:8787
npm run admin:dev    # painel, apontando para a API local
npm run type-check
npm test
npm run lint
```

O runtime local usa D1 e R2 do Miniflare. Os testes `test/*.node.ts` exercitam
os scripts de publicação e manutenção (`npm run test:<nome>`).

## Configuração

Bindings declarados em `wrangler.jsonc`:

- `DB`: banco D1 `louvorja`;
- `FILES`: bucket R2 `files`;
- `RATE_LIMIT_FILES`, `RATE_LIMIT_METADATA` e `RATE_LIMIT_GENERAL`: limites por
  minuto equivalentes aos três grupos da API PHP;
- `JWT_SECRET` (obrigatório): assinatura das sessões do painel;
- `GITHUB_TASK_TOKEN` (opcional): token restrito a Actions para `/tasks`. Sem
  ele, `/tasks` responde `503` e o resto funciona.

Os jobs usam `CLOUDFLARE_API_TOKEN`, credenciais S3 do R2 e, no job mensal,
`YOUTUBE_API_KEY`. Segredos não entram em `wrangler.jsonc`, no R2 ou no Git.

`PUBLIC_API_URL` é a origem gravada nas URLs dos snapshots e vale
`https://api.louvorja.workers.dev`. O domínio `api.louvorja.com.br` pertence ao
servidor antigo; só o use se ele passar a apontar para este Worker.

## Segurança e compatibilidade HTTP

- `/file/*` aceita somente `covers/`, `images/` e `musics/`, bloqueia subida de
  diretório e responde `206` para `Range`.
- Os nomes `.mp3` e `.bmp` continuam resolvendo para os objetos Opus/JPEG; o
  `Content-Type` descreve os bytes reais.
- Respostas privadas nunca vão para o cache, e um `404` público não fica preso
  na borda.
- Entradas de rede e arquivos importados são validados antes do uso.
- Notas de versão vindas do GitHub são escapadas antes de entrar no HTML.

## Colocar em produção

1. termine a carga inicial e aplique as migrations;
2. grave o segredo: `npx wrangler secret put JWT_SECRET`;
3. crie o administrador e rode `cutover:check`;
4. publique o Worker (`npm run deploy`) e o painel (`npm run admin:deploy`);
5. confirme o login e a troca de senha no painel;
6. rode a primeira publicação à mão (`workflow_dispatch`, tarefa `publish`) e
   confira os apps;
7. ligue o agendamento com a variável `MAINTENANCE_SCHEDULE=on`.

## Licença

Projeto proprietário.
