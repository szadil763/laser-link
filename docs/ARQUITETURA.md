# Arquitetura

## Visão geral

```
[Navegador / celular] ──ws + token──▶ [Agente] ──serial──▶ [GRBL]
     UI + heartbeat                  regras + fila            laser
```

## Componentes

**Agente (`apps/agent`)**
- `config.ts`: lê `laserlink.config.json` (ou o caminho em `LASERLINK_CONFIG`): porta, token, limites, pastas.
- `serial-link.ts`: interface `SerialLink` e a implementação com `serialport`. Reabre a porta criando uma instância nova.
- `grbl.ts`: streaming com contagem de caracteres (fila única para jog, comandos e trabalho), espera o `Grbl 1.1…` após cada reset, interpreta `ok`, `error:`, `ALARM:` e `<Estado|MPos:…|WCO:…>`, `abortJob` (hold, reset, `M5`) e `safetyHold` (hold e `0x9E` quando o GRBL confirma o Hold).
- `gcode-check.ts`: verificação pura do arquivo inteiro antes do envio (potência, área útil, arcos, comandos recusados).
- `agent.ts`: regras independentes do transporte: dono do trabalho, heartbeat, pausa por perda de conexão, cancelamento após `reconnectGraceSec`, reabertura da serial, log de trabalhos e recuperação após reinício.
- `job-log.ts`: log JSON Lines em `apps/agent/logs/jobs.jsonl`.
- `static.ts`: serve a interface compilada (`apps/web/dist`) na mesma porta do WebSocket.
- `sim/fake-grbl.ts`: GRBL falso para testes e para `"serialPort": "sim"`.
- `index.ts`: liga tudo: servidor HTTP + WebSocket, token, sinais de encerramento.

**Interface (`apps/web`)**
- `connection.ts`: WebSocket com reconexão automática e ping a cada 2 s, com timer num Web Worker (`tick-worker.ts`) para não sofrer o limite de timers de abas em segundo plano.
- `main.ts`: estado da conexão e da laser, posição, jog, origem, envio de arquivo com confirmação, aviso de trabalho pausado (Retomar/Cancelar), problemas de trabalho recusado, último resultado e Wake Lock na aba dona.

**Shared (`packages/shared`)**
- `protocol.ts`: tipos das mensagens e constantes do heartbeat. Única fonte de verdade.
- `validate.ts`: validação em tempo de execução das mensagens do cliente.

## Decisões

| Decisão | Motivo |
|---|---|
| Agente separado da UI | Streaming local, imune a falhas de rede |
| WebSocket | Bidirecional, simples, status em tempo real |
| Tailscale para acesso externo | VPN sem abrir portas |
| Monorepo TS | Tipos compartilhados |
| Agente serve a interface | Uma coisa só para instalar; evita o bloqueio de `ws://` em páginas `https` |
| Sem nuvem (Firebase etc.) | A laser não pode depender da internet; nada passa por servidor externo |
| Perda de conexão = hold + `0x9E`, não `M5` | `M5` entra na fila e só rodaria ao retomar; `0x9E` desliga o laser na hora sem perder o trabalho |
| Dono do trabalho | O heartbeat que importa é o de quem está acompanhando o trabalho; um celular só olhando não segura a máquina |
| Verificar o arquivo inteiro antes | Recusar é mais seguro que cortar valores no meio do trabalho |
| `confirmLaserOn: true` no protocolo | A regra "nada liga o laser sem confirmação" fica explícita também no agente |

## Alternativas consideradas

- **ESP32 + FluidNC**: Wi-Fi nativo, sem PC. Não substitui o editor, e este projeto cobre o lado do PC.
- **CNCjs/LaserWeb**: bons para começar; LaserLink mira integração com editor próprio e geradores paramétricos.

## Fases futuras

Pré-visualização, importação SVG/imagem, camadas, geração de G-code própria (`packages/gcode`), biblioteca de materiais, geradores paramétricos. Veja `ROADMAP.md`.
