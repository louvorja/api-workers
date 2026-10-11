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

### FTP do Delphi e Bíblia fora do banco

- Workers não recebe conexões FTP. O que este Worker faz é o aperto de mão
  HTTPS do programa Delphi: `/params` anuncia `conn_ftp` e `/ftp` devolve host,
  porta e credenciais de um servidor de FTP que existe à parte (hoje, o do
  servidor antigo), lidos do secret `FTP_COMPAT_CONFIG`. O acervo em MP3 e o
  banco SQLite do Delphi continuam vindo desse FTP; nada disso é gerado aqui.
  Sem o secret, `/params` não anuncia `conn_ftp` e `/ftp` responde `410`.
- A Bíblia não é editada pelo painel: os 404 mil versículos ficam como estão no
  R2 e a publicação não toca neles. `seed-d1.ts --bible` existe, mas carregá-los
  ocuparia cerca de 11 dias da cota de escrita e não é parte do plano.

### Bíblia inteira em um arquivo

Quem precisa da Bíblia completa (cópia offline, busca, rotina agendada) baixa
`/db/bible-bundle`: um ZIP de cerca de 26 MB com os 15.457 capítulos de todas as
versões. Cada entrada se chama `bible_{versão}_{livro}_{capítulo}.json` e tem o
mesmo conteúdo de `/json_db/bible_{versão}_{livro}_{capítulo}`. As versões e os
livros estão em `/json_db/{pt,es}_bible_version` e `/json_db/{pt,es}_bible_book`;
os livros de 1 a 66 são os das versões em português e os de 67 a 132, os das
versões em espanhol.

O capítulo avulso em `/json_db` existe para a tela que mostra um capítulo por
vez. Varrer todos por ele são milhares de requisições na cota diária, contra
uma do pacote. Por isso o pacote aparece na página inicial, no `/openapi.json`
e na resposta de capítulo inexistente.

## O domínio da API antiga

`api.louvorja.com.br` continua apontando para o servidor PHP, mas a maior parte
das rotas é desviada para este Worker (lista em `routes`, no `wrangler.jsonc`),
para tirar a carga dele. Ficam no servidor antigo:

- `/auth`, `/admin` e `/tasks`: o painel antigo, que grava no MySQL;
- `/file/musics`: continua respondendo lá, mas o catálogo não aponta mais para
  ele (ver abaixo);
- `/health`.

Quem chama `/json_db` por esse domínio é cliente antigo: o app web em
`app.louvorja.com.br` e o app Android usam os campos `url_*` como endereço
pronto. Por isso, só nesse domínio, o catálogo sai com endereços completos e
com o áudio em `.mp3`, porque navegadores de iPhones mais velhos não tocam
Opus. Pelo `workers.dev` os apps recebem os caminhos relativos de sempre.

O áudio desses clientes sai de `LEGACY_AUDIO_URL` (`mp3.louvorja.com.br`), um
domínio ligado ao bucket `files-original`: a cópia dos 5.996 arquivos originais
da API antiga (MP3, imagens e capas), com os mesmos nomes e pastas. Assim o
áudio não passa pelo servidor PHP — que enviava o arquivo inteiro a cada
pedido — nem conta na cota de requisições deste Worker. Sem a variável, o
catálogo volta a apontar para `/file/musics` do próprio domínio.

Enquanto os dois sistemas existirem, `db_version` em `/params` precisa
acompanhar o banco que está no FTP: o Delphi compara esse número com o dele e
tenta atualizar quando o da API é maior.

## Contratos atendidos

As rotas públicas incluem `/params`, `/ftp`, `/onlinevideos`, `/file/*`, `/json_db/*`,
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
  ele, `/tasks` responde `503` e o resto funciona;
- `FTP_COMPAT_CONFIG` (opcional): JSON com o servidor de FTP entregue ao Delphi,
  por idioma — `{"pt": {"host", "port", "root", "username", "password"}, "es": {…}}`.

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
