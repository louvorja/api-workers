# LouvorJA API — Cloudflare Workers

Substituição da API PHP do LouvorJA. O Worker mantém os contratos HTTP usados
pelos apps, o painel administra o catálogo no D1 e o R2 guarda a mídia e os
arquivos que os apps leem.

- API: `https://api.louvorja.com.br` e `https://api.louvorja.workers.dev`
  (mesmo catálogo e mesmos formatos de mídia)
- Swagger UI: `/documentation`
- OpenAPI: `/openapi.json`
- Painel: `https://adm.louvorja.com.br`, no repositório
  [`louvorja/adm`](https://github.com/louvorja/adm) (GitHub Pages). Ele chama
  esta API por `https://api.louvorja.com.br`.

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
cliente; respostas iguais nos dois domínios também podem ficar na borda:

| Rotas | Cache |
| --- | --- |
| `/json_db/*`, `/db/bible-bundle` | um dia |
| `/db/*`, `/{lang}/*`, `/params`, `/onlinevideos` | uma hora |
| `/file/*` | um ano (nome estável); redirecionamentos: uma hora |
| `/auth/*`, `/admin/*`, `/tasks/*`, `/health`, erros | sem cache |

O app acrescenta a data à URL de `/json_db` e um carimbo único quando o
operador pede para atualizar, então o cache não segura conteúdo velho além do
dia.

### O programa Delphi

O Delphi lê tudo de `https://api.louvorja.com.br/params?type=env` e precisa de
endereços nesse domínio: no `workers.dev` a Cloudflare recusa a identificação
dele ("Indy Library", erro 1010), e isso não é configurável. Por isso `/params`
sempre entrega com o domínio antigo os endereços desta API (`conn_ftp`,
`coletaneas_online`, `version_log`).

**Atualização por FTP (versões anteriores do programa).** Workers não recebe
conexões FTP. O Worker só faz o aperto de mão HTTPS: `/params` anuncia
`conn_ftp` e `/ftp` devolve host, porta e credenciais de um servidor de FTP
que existe à parte (o do servidor antigo), lidos do secret
`FTP_COMPAT_CONFIG`. O que está naquele FTP não é gerado aqui: o banco de lá
parou na versão em que o PHP o deixou, e `db_version` em `/params` fica nesse
número para essas instalações não tentarem atualizar a cada abertura. Sem o
secret, `/params` não anuncia `conn_ftp` e `/ftp` responde `410`.

**Atualização por HTTPS, com suporte a Opus.** Os arquivos públicos ficam em
`files.louvorja.com.br` (bucket `files`), e `/params` diz onde:

| Chave de `/params` | O que é |
| --- | --- |
| `https_db_version` | Versão do banco disponível por HTTPS. Compare com a do banco local |
| `https_db_pt`, `https_db_es` | O banco SQLite de cada idioma (`config/<idioma>_database.db`) |
| `https_files` | Base dos arquivos. Some `dir` + `/` + `file_name` da tabela `files` do banco |
| `https_system_files` | Base dos adicionais (`files.louvorja.com.br/system`). Some `ARQUIVOS_ADICIONAIS.URL`, trocando `\` por `/` |

O banco preserva as tabelas e visões do PHP. O modo padrão `stored` usa o áudio
realmente publicado (Opus ou MP3), mantém BMP nas imagens do Delphi e confere
os tamanhos contra `files`. `npm run delphi:db` gera os bancos a partir do D1
quando o catálogo passa de `https_db_version`, e só anuncia a versão depois de
publicar ambos. O banco FTP e `db_version` permanecem independentes. As cópias
anteriores em `files-original` são preservadas; `--audio=legacy` existe apenas
para operações explícitas de compatibilidade e exige todos os originais no
destino anunciado.

Uma regeneração com `--force` pode manter o número da versão. Clientes HTTPS
que já guardaram o banco anterior com esse número precisam baixá-lo novamente;
a comparação de versão, sozinha, não invalida essa cópia local.

Os adicionais não faziam parte da migração do catálogo. Foram recuperados do
instalador oficial v26.11: executável, DLLs, fonte, ícone, áudios da Escola
Sabatina e páginas em `system/config/server/`. `system/bassopus.dll` veio da
`main` do Delphi com suporte a Opus. Isso não transforma o executável v26.11
em uma nova compilação. Também é possível baixar um adicional por
`/file/system/<caminho>`, que confirma sua existência e redireciona para `files`.

**Versão nova do programa.** As chaves de versão e de instalador saem do
último lançamento final de `louvorja/desktop` no GitHub (`npm run
delphi:version`): publicar o lançamento lá é o aviso. Pré-lançamento não é
anunciado, e a versão nunca volta para trás.

### Mídia nova

Cada arquivo existe em dois lugares: o original (MP3, BMP, JPEG) no bucket
`files-original`, com o nome antigo, e a versão dos apps atuais no bucket
`files`. Um arquivo novo chega só de um lado — o original enviado para
`files-original` no caminho que o catálogo registra
(`musics/<idioma>/<álbum>/<arquivo>.mp3`, `covers/…`, `images/…`), ou o
áudio de uma apresentação importada, gravado em `files` — e
`npm run media:normalize` completa o outro: guarda o original e gera a versão
convertida. A regra é a do cron antigo: MP3 acima de 128 kbps vira Opus
(112 kbps até 160 de origem, 128 kbps acima disso); até 128 kbps o MP3 fica
como está, porque converter não economizaria espaço e somaria uma geração de
perda; BMP vira JPEG.

### Bíblia fora do banco

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

`api.louvorja.com.br` é atendido inteiro por este Worker (rota única em
`routes`, no `wrangler.jsonc`). O registro de DNS do endereço ainda aponta
para o servidor PHP, porque as rotas precisam dele, mas nenhum pedido chega lá
por HTTP: `/auth`, `/admin`, `/tasks` e `/health` desse domínio também são
os daqui. Quem ainda fala com aquela máquina é só o Delphi, por FTP, direto no
IP.

Quem pede `/file/musics/<faixa>.mp3` recebe um redirecionamento para `files`
somente quando esse MP3 existe lá. A API não entrega Opus com nome de MP3.

### Endereços de mídia do catálogo

O catálogo é guardado com o caminho do arquivo dentro do armazenamento
(`/musics/...`, `/covers/...`, `/images/...`). Quem lê recebe o endereço
completo, e ele aponta direto para o armazenamento: arquivo entregue por
`/file` conta na cota diária de requisições do Worker. A troca é feita em
`src/lib/media-urls.ts` e vale para `/json_db`, `/db`, o pacote `/db/bundle`
e as listas/itens REST em `/pt` e `/es`, inclusive relações de álbuns e letras.
O domínio do pedido não muda o formato:

| Pedido por | Quem é | Áudio | Capas e imagens |
| --- | --- | --- | --- |
| ambos os domínios | todos os apps | `files.louvorja.com.br`, com o nome exato do arquivo (Opus ou MP3) | `files.louvorja.com.br` |

- `files.louvorja.com.br` é o bucket `files`: a melhor versão de cada arquivo.
  Metade do acervo está em Opus; a outra metade ficou em MP3 porque o original
  é de 128 kbps e converter só acrescentaria perda.
- `mp3.louvorja.com.br` é o bucket `files-original`: backup dos arquivos
  originais, com os mesmos nomes e pastas. É preservado, mas não é selecionado
  pelas respostas atuais das APIs. Não se copia o MP3 para `files` quando
  a versão desse áudio já é Opus.

As listas REST mantêm `Cache-Control: private` porque os links de paginação
preservam o domínio solicitado. O catálogo e os pacotes são iguais nos dois
domínios; nesta migração, seus tempos e políticas de cache foram preservados.

As URLs REST são conferidas contra as chaves reais do armazenamento durante
a publicação. A lista `/files` tem um retrato adicional por idioma
(`rest/{lang}_files_legacy.json`), com os tamanhos dos MP3 originais, mantido
como artefato de compatibilidade. As duas APIs usam o retrato atual, em que
`size` corresponde ao arquivo indicado em `url`.
Para corrigir só a mídia dos retratos existentes, sem publicar alterações do
D1 nem mudar `db_version`: `npm run rest:media` simula;
`npm run rest:media -- --write` grava e relê o resultado, preservando uma cópia
local dos objetos anteriores. Prepare esses retratos antes de implantar o
Worker que os utiliza. A publicação normal também os mantém atualizados.

`/file` conserva a compatibilidade entre extensões para instalações com
catálogos antigos. Os endereços diretos entregues pelo catálogo e pelo REST
usam a extensão que existe no armazenamento e não dependem dessa troca.

O pacote completo mantém `/db/bundle` e as variantes `meta/bundle-files.zip` e
`meta/bundle-legacy.zip`; `meta/bundle.zip` é a base com caminhos relativos.
`/db/catalog-bundle` entrega o catálogo sem capítulos, em ambos os domínios,
a partir de `meta/catalog-bundle-files.zip`. Os artefatos `legacy` continuam
disponíveis no armazenamento, mas não são selecionados pelo domínio da API.
`/db/bible-bundle` entrega somente capítulos.

Todos os ZIPs incluem `_bundle_manifest.json` (`schema_version: 1`, `kind`:
`full`, `catalog` ou `bible`, e `files: [{ name, bytes, sha256 }]`). O publicador
confere os capítulos esperados pelos metadados e referências de músicas/álbuns
antes de construir os pacotes. O cliente valida CRC e o conjunto exato de JSONs,
mais tamanho/SHA-256 por arquivo. Os manifestos públicos mantêm o formato antigo
com MD5, calculado sobre os bytes finais de cada domínio; `meta/manifest.json`
representa a base interna, e `meta/manifest-files.json`/`meta/manifest-legacy.json`
as variantes atual e legada; ambas as APIs selecionam a atual.

`npm run bundle:variants -- --write` regenera todos esses artefatos a partir da
base publicada, sem incrementar a versão do catálogo nem alterar os bancos FTP.
O app web `louvorja/app` lê `/json_db/{key}` individualmente e não depende do nome
do objeto ZIP. A rota `/db/bundle` continua completa para clientes existentes.

O app novo aceita endereço completo desde a beta.12; versões anteriores
montavam o endereço por conta própria e ficam sem capa e sem áudio. A versão
web precisa ter `files.louvorja.com.br` na política de conteúdo dela.

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
- consulta de arquivos em `/admin/files`.

`/tasks/*` agenda o workflow `maintenance.yml` para quem chama a API com sessão
de administrador; o painel não tem tela para isso.

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
| `npm run media:normalize` | Guarda o original e gera a versão convertida da mídia nova |
| `npm run files:reconcile` | Confere tamanho no R2 e duração com `ffprobe` |
| `npm run delphi:db` | Gera e publica os bancos SQLite do Delphi |
| `npm run delphi:version` | Anuncia a versão do Delphi lançada no GitHub |
| `npm run bundle:variants` | Regera os pacotes com endereço de mídia |
| `npm run online-videos:refresh` | Atualiza canais, playlists e vídeos do YouTube |
| `npm run slides:import` | Importa `.slja/.lja` com áudio e imagens |

O workflow `maintenance.yml` é o único cron: executa esses jobs fora do limite
curto do Worker, nesta ordem — mídia nova, reconciliação, publicação, banco do
Delphi e versão do Delphi. As rotas `/tasks/*` só fazem um `workflow_dispatch`
autenticado. A ingestão que copiava tudo da API PHP (`ingest.yml`) foi
desligada e não deve voltar: as duas gravariam os mesmos objetos. O agendamento
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

`PUBLIC_API_URL` é a origem gravada nas URLs dos snapshots quando o script
oferece essa configuração. O padrão é `https://api.louvorja.com.br`, atendido
por este mesmo Worker.

## Segurança e compatibilidade HTTP

- `/file/*` aceita somente `covers/`, `images/`, `musics/` e `system/`, bloqueia
  subida de diretório e responde `206` para `Range` nas mídias transmitidas.
- Em `/file`, o nome `.bmp` continua resolvendo para a capa JPEG e o `.opus`
  para o MP3 quando a faixa não foi convertida. MP3 e adicionais existentes
  redirecionam para `files`; MP3 ausente responde `404`. O `Content-Type`
  descreve os bytes reais.
- Respostas privadas nunca vão para o cache, e um `404` público não fica preso
  na borda.
- Entradas de rede e arquivos importados são validados antes do uso.
- Notas de versão vindas do GitHub são escapadas antes de entrar no HTML.

## Colocar em produção

1. termine a carga inicial e aplique as migrations;
2. grave o segredo: `npx wrangler secret put JWT_SECRET`;
3. crie o administrador e rode `cutover:check`;
4. publique o Worker (`npm run deploy`); o painel é publicado pelo repositório
   `louvorja/adm`, a cada commit na `main` de lá;
5. confirme o login e a troca de senha no painel;
6. rode a primeira publicação à mão (`workflow_dispatch`, tarefa `publish`) e
   confira os apps;
7. ligue o agendamento com a variável `MAINTENANCE_SCHEDULE=on`.

## Licença

Projeto proprietário.
