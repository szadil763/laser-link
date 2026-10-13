# Protocolo WebSocket

Mensagens JSON. Tipos em `packages/shared/src/protocol.ts`; validação das mensagens do cliente em `packages/shared/src/validate.ts`.
Versão atual: **0.2.0** (`PROTOCOL_VERSION`). O agente informa a versão no `hello`; a interface avisa se for diferente.

## Autenticação

Cliente conecta em `ws://host:8787/?token=SEU_TOKEN`. Token inválido: conexão fechada com código 4401.

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
| `setOrigin` | | `G10 L20 P1 X0 Y0` |
| `hold` | | `!` |
| `resume` | `confirmLaserOn: true` | `~`. Quem retoma vira o dono do trabalho |
| `stop` | | `!` + `0x18` + `M5` (cancela o trabalho) |
| `unlock` | | `$X` |
| `job` | `name`, `gcode`, `confirmLaserOn: true` | Inicia streaming local no agente |

`confirmLaserOn: true` é obrigatório em `resume` e `job`: sem ele a mensagem é recusada. A interface só envia esse campo depois que a pessoa confirma.

## Agente → Cliente

| `type` | Campos |
|---|---|
| `hello` | `version`, `port`, `connected`, `job` (`JobInfo` ou `null`), `reconnectGraceSec`, `limits {maxSpindle, workArea {x,y}}` |
| `status` | `state`, `mpos {x,y,z}`, `wpos {x,y,z}` (se o WCO já é conhecido), `feed`, `spindle` |
| `log` | `level`, `text` |
| `progress` | `sent`, `total`, `running` |
| `job` | `job` (`JobInfo` ou `null`): enviado sempre que o trabalho muda de estado |
| `jobEnded` | `result` (`JobResult`) |
| `jobRejected` | `name`, `problems` (`JobProblem[]`, até 20), `bounds` (`JobBounds` ou `null`) |
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
| `reason` | motivo, quando `connectionLost` |

### `JobResult`

| Campo | Descrição |
|---|---|
| `name`, `startedAt`, `endedAt` | |
| `outcome` | `completed`, `aborted` ou `error` |
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
