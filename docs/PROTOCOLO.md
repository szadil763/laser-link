# Protocolo WebSocket

Mensagens JSON. Tipos em `packages/shared/src/protocol.ts`.

## Autenticação

Cliente conecta em `ws://host:8787/?token=SEU_TOKEN`. Token inválido: conexão fechada com código 4401.

## Cliente → Agente

| `type` | Campos | Efeito |
|---|---|---|
| `jog` | `axis` (`X`/`Y`), `distance` (mm), `feed` (mm/min) | Movimento relativo (`$J=G91 G21 ...`) |
| `home` | | `$H` |
| `setOrigin` | | `G10 L20 P1 X0 Y0` |
| `hold` | | `!` |
| `resume` | | `~` |
| `stop` | | `0x18` + `M5` |
| `unlock` | | `$X` |
| `job` | `name`, `gcode` | Inicia streaming local no agente |

## Agente → Cliente

| `type` | Campos |
|---|---|
| `hello` | `version`, `port`, `connected` |
| `status` | `state`, `mpos {x,y,z}`, `feed`, `spindle` |
| `log` | `level`, `text` |
| `progress` | `sent`, `total`, `running` |
| `error` | `message` |
