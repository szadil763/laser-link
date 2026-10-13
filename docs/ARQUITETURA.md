# Arquitetura

## Visão geral

```
[Navegador / App] ──ws──▶ [Agente] ──serial──▶ [GRBL]
     UI                    fila + segurança       laser
```

## Componentes

**Agente (`apps/agent`)**
- `config.ts`: lê `laserlink.config.json` (porta, baudrate, token, porta WS).
- `grbl.ts`: abre a serial, faz streaming com contagem de caracteres, interpreta `ok`, `error:`, `ALARM:` e relatórios de status (`<Idle|MPos:...>`).
- `index.ts`: servidor WebSocket, autenticação por token, roteia mensagens e aplica a parada de segurança na desconexão.

**Interface (`apps/web`)**
- Conecta no agente, mostra estado e posição, botões de jog, origem, pausa, retomar, parar, e envio de arquivo `.gcode/.nc`.

**Shared (`packages/shared`)**
- Tipos TypeScript das mensagens. Evita divergência entre agente e interface.

## Decisões

| Decisão | Motivo |
|---|---|
| Agente separado da UI | Streaming local, imune a falhas de rede |
| WebSocket | Bidirecional, simples, status em tempo real |
| Tailscale para acesso externo | VPN sem abrir portas |
| Monorepo TS | Tipos compartilhados |

## Alternativas consideradas

- **ESP32 + FluidNC**: Wi-Fi nativo, sem PC. Não substitui o editor, e este projeto cobre o lado do PC.
- **CNCjs/LaserWeb**: bons para começar; LaserLink mira integração com editor próprio e geradores paramétricos.

## Fases futuras

Editor vetorial, importação SVG/imagem, camadas, geração de G-code própria, biblioteca de materiais, câmera. Veja `ROADMAP.md`.
