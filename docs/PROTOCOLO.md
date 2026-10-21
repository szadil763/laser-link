# Protocolo WebSocket

Mensagens JSON. Tipos em `packages/shared/src/protocol.ts`; validação das mensagens do cliente em `packages/shared/src/validate.ts`.
Versão atual: **0.6.0** (`PROTOCOL_VERSION`). O agente informa a versão no `hello`; a interface avisa se for diferente.

## Endereço e autenticação

O agente serve, na mesma porta, a interface compilada (`http://host:8787/`, arquivos estáticos sem segredos) e o WebSocket.
Cliente conecta em `ws://host:8787/?token=SEU_TOKEN`. Token inválido: conexão fechada com código 4401 (a interface não tenta reconectar).

## Reconexão

- **Interface:** se a conexão cair, tenta de novo sozinha após 1, 2, 4, 8 e depois a cada 10 s, até a pessoa clicar em Desconectar. Ao reconectar, o `hello` traz o trabalho atual (inclusive pausado por perda de conexão) e o último resultado (`lastResult`).
- **Serial:** se a porta não abrir ou cair, o agente tenta reabrir a cada 2 s e avisa os clientes com `serial`. Se a serial cair no meio de um trabalho, o trabalho termina com `outcome: "error"`: o GRBL perde o buffer, e o agente **nunca** retoma um trabalho por conta própria.
- **Agente reiniciado:** um trabalho que começou e não terminou (agente encerrado, PC desligado) aparece no `lastResult` do próximo `hello` com `outcome: "interrupted"`.
- **Prontidão do GRBL:** depois de abrir a serial ou de um reset, o agente só envia linhas após a mensagem `Grbl 1.1…` (ou 3 s sem ela). Trabalho enviado nesse intervalo é recusado com uma mensagem para tentar de novo.

## Heartbeat

- O cliente envia `ping` a cada **2 s** (`HEARTBEAT_INTERVAL_MS`). O agente responde `pong` com o mesmo `t`.
- Toda mensagem do cliente conta como sinal de vida.
- O **dono do trabalho** é o cliente que o iniciou ou o último que o retomou.
- Se o dono desconectar, ou ficar **6 s** sem enviar nada (`HEARTBEAT_TIMEOUT_MS`) durante um trabalho, o agente:
  1. envia `!` (feed hold);
  2. no próximo relatório com estado `Hold`, envia `0x9E` (override que desliga o laser em Hold);
  3. marca o trabalho como `connectionLost` e avisa todos os clientes.
- Um `M5` não é enviado nesse momento: ele entraria na fila do GRBL e só rodaria depois de retomar, desligando o laser no resto do trabalho.
- O trabalho fica pausado esperando alguém decidir (Retomar ou Cancelar). Se **nenhum** cliente vivo estiver conectado por `reconnectGraceSec` (padrão 60 s), o agente cancela: `!`, reset (`0x18`) e `M5`.
- A interface mostra o estado da conexão: Conectado, Conexão instável (sem `pong` há mais de 4,5 s) ou Desconectado.

## Cliente → Agente

| `type` | Campos | Efeito |
|---|---|---|
| `ping` | `t` (número) | Heartbeat; resposta `pong` |
| `jog` | `axis` (`X`/`Y`), `distance` (mm), `feed` (mm/min) | Movimento relativo (`$J=G91 G21 ...`) |
| `home` | | `$H` |
| `setOrigin` | `x`, `y` (opcionais, juntos) | `G10 L20 P1 X{x} Y{y}`: a posição atual do cabeçote vira esse ponto (sem `x`/`y`, vira X0 Y0). O ponto precisa estar na área útil; fora dela, ou com trabalho em andamento, o agente recusa com `error` |
| `hold` | | `!` |
| `resume` | `confirmLaserOn: true` | `~`. Quem retoma vira o dono do trabalho |
| `stop` | | `!` + `0x18` + `M5` (cancela o trabalho) |
| `unlock` | | `$X` |
| `job` | `name`, `gcode`, `confirmLaserOn: true` | Inicia streaming local no agente |
| `frame` | `bounds {minX,minY,maxX,maxY}`, `laser` (`"off"` ou `"min"`); com `"min"`, `confirmLaserOn: true` | Percorre o retângulo a `frameFeed`. `"off"`: laser desligado (M5). `"min"`: M4 em `framePower`. Passa pelas mesmas conferências de área de um trabalho e aparece no log como "Enquadrar" |
| `materialsSave` | `materials` (`Material[]`, até 200) | Grava a biblioteca em `materials.json` no agente e envia `materials` a todos |
| `queueAdd` | `name` (1–120 caracteres), `gcode` | Confere o arquivo e guarda na fila. **Não liga o laser** nem fala com o GRBL. Se houver problema, responde `jobRejected` e não guarda |
| `queueRemove` | `id` | Tira da fila |
| `queueMove` | `id`, `index` (inteiro; 0 = próximo) | Muda a posição na fila |
| `queueStart` | `id`, `confirmLaserOn: true` | Confere de novo (a origem pode ter mudado) e inicia como um `job`. Só sai da fila se iniciar |
| `projectsList` | | Busca no GitHub o ramo `projetos` (`git fetch` para `refs/laserlink/projetos`, sem mexer na pasta de trabalho) e responde `projects` |
| `projectGet` | `path` (da última lista) | Responde `projectFile` com o conteúdo. Caminho fora da lista é recusado com `error` |

`confirmLaserOn: true` é obrigatório em `resume`, `job`, `queueStart` e `frame` com `laser: "min"`: sem ele a mensagem é recusada. A interface só envia esse campo depois que a pessoa confirma.

## Agente → Cliente

| `type` | Campos |
|---|---|
| `hello` | `version`, `port`, `connected`, `job` (`JobInfo` ou `null`), `reconnectGraceSec`, `limits {maxSpindle, workArea {x,y}, framePower, frameFeed}`, `lastResult` (`JobResult` ou `null`) |
| `status` | `state`, `mpos {x,y,z}`, `wpos {x,y,z}` (se o WCO já é conhecido), `feed`, `spindle` |
| `log` | `level`, `text` |
| `progress` | `sent`, `total`, `running` |
| `job` | `job` (`JobInfo` ou `null`): enviado sempre que o trabalho muda de estado |
| `jobEnded` | `result` (`JobResult`) |
| `jobRejected` | `name`, `problems` (`JobProblem[]`, até 20), `bounds` (`JobBounds` ou `null`) |
| `serial` | `connected`: a porta serial abriu ou fechou |
| `materials` | `materials` (`Material[]`): enviado logo após o `hello` e sempre que alguém salva |
| `queue` | `items` (`QueueItem[]`): enviado logo após o `hello` e a cada mudança na fila |
| `projects` | `items` (`ProjectEntry[]`: `path`, `name`, `kind` `laserlink`/`svg`/`dxf`, `size`, `date`, `description` = mensagem do commit), `error?` (a busca falhou; a lista é a última baixada) |
| `projectFile` | `entry`, `content` (texto do arquivo, até 8 MB) |
| `pong` | `t` |
| `error` | `message` |

### `JobInfo`

| Campo | Descrição |
|---|---|
| `id` | identificador do trabalho |
| `name` | nome do arquivo |
| `startedAt` | ISO 8601 |
| `sent`, `total` | linhas confirmadas pelo GRBL / total |
| `state` | `running`, `paused` ou `connectionLost` |
| `ownedByYou` | `true` se quem recebe é o dono do trabalho (o heartbeat dele protege o trabalho) |
| `reason` | motivo, quando `connectionLost` |

### `JobResult`

| Campo | Descrição |
|---|---|
| `name`, `startedAt`, `endedAt` | |
| `outcome` | `completed`, `aborted`, `error` ou `interrupted` (o agente foi encerrado ou o PC desligou durante o trabalho) |
| `reason` | texto para a pessoa |

### `JobProblem` e `JobBounds`

Antes de aceitar um `job`, o agente confere o arquivo inteiro (`apps/agent/src/gcode-check.ts`):

- **Potência:** qualquer `S` acima de `maxSpindle` recusa o trabalho.
- **Área útil:** todo ponto percorrido (G0, G1 e os extremos de arcos G2/G3), em coordenadas de trabalho, precisa ficar entre `X0 Y0` e `X{workArea.x} Y{workArea.y}`. Movimentos relativos (G91) partem da posição atual do cabeçote; G20 é convertido para mm.
- **Curso da máquina (opcional):** com `machineLimits` no config e o WCO já conhecido, cada ponto também é conferido em coordenadas de máquina.
- **Recusados:** comandos `$`, G10, G28, G30, G53, G55–G59, G92, G93, G90.1, planos G18/G19 e palavras desconhecidas.

O agente não corta nem ajusta valores: qualquer problema recusa o trabalho e nada é enviado ao GRBL.

| `JobProblem` | |
|---|---|
| `line` | linha no arquivo original (1…n); `0` em resumos ("Mais N pontos fora da área") |
| `text` | trecho da linha |
| `message` | motivo, em português |

`JobBounds`: `minX`, `maxX`, `minY`, `maxY` em mm, coordenadas de trabalho.

### Fila de trabalhos (`QueueItem`)

A fila fica no agente, na memória: todos os aparelhos conectados veem a mesma. Ela **nunca inicia um trabalho sozinha**. Quando um trabalho termina, a interface avisa (som e mensagem) e mostra o próximo, mas iniciar exige `queueStart` com `confirmLaserOn: true`, depois da confirmação na tela.

Limites: até 20 trabalhos (`QUEUE_MAX_ITEMS`) e 64 MB de G-code somados. A fila se perde se o agente reiniciar.

| Campo | Descrição |
|---|---|
| `id` | identificador |
| `name` | nome do arquivo |
| `lines` | linhas de G-code (sem comentários) |
| `addedAt` | ISO 8601 |
| `estimatedSec` | tempo estimado, em segundos (aproximado: não conta aceleração) |
| `bounds` | `JobBounds` ou `null` |

O G-code não volta para a interface: só o agente guarda o arquivo.

### `Material`

A biblioteca fica no agente (`apps/agent/data/materials.json`, fora do git), para valer em qualquer aparelho. Sem o arquivo, o agente usa MDF 3 mm e MDF 6 mm de exemplo.

| Campo | Descrição |
|---|---|
| `id` | identificador único (até 64 caracteres) |
| `name` | nome (até 80 caracteres) |
| `thickness` | espessura, mm |
| `notes` | opcional |
| `presets` | lista de `MaterialPreset` |

`MaterialPreset`: `mode` (`cut`, `line`, `fill`, `detail`, `raster`), `speed` (mm/min), `power` (0–100 %), `passes` (1–50), `kerf` (mm, opcional, corte), `interval` (mm, opcional, preenchido e detalhado).

## Projetos recebidos

Arquivos publicados na pasta `projetos/` do ramo `projetos` do repositório (por exemplo pelo Claude, com `scripts/publicar-projeto.mjs`). O agente só busca e lê: não muda o código nem a pasta de trabalho, e nenhuma porta é aberta. Abrir um projeto só põe o desenho na mesa da interface; mandar para a máquina continua exigindo a confirmação de sempre.

Configuração (opcional) em `laserlink.config.json`: `"projects": { "remote": "origin", "branch": "projetos", "token": "…" }`. `"projects": false` desliga. O `token` (GitHub, só leitura) só é preciso se o repositório for privado.
