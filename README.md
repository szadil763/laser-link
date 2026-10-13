# LaserLink

Controle remoto de cortadora/gravadora a laser **GRBL**. Dois pedaços de software:

- **Agente** (`apps/agent`): roda no PC ligado à laser por USB. Fala serial com o GRBL, faz o streaming do G-code e serve a interface e um WebSocket protegido por token.
- **Interface web** (`apps/web`): abre em qualquer navegador (PC de projeto, celular). Move o cabeçote, define origem, envia o trabalho, pausa, retoma e para.

> Status: **Fase 1 (agente e controle) concluída no simulador**, aguardando os testes na laser real (`docs/TESTES-NA-BANCADA.md`). Editor e geração de G-code vêm na Fase 2 (veja `docs/ROADMAP.md`).

## Por que assim

O G-code **nunca é transmitido linha a linha pela rede**. A interface envia o arquivo inteiro ao agente e o agente faz o streaming serial localmente. Uma oscilação de Wi-Fi não interrompe o corte no meio.

```
 PC de projeto / celular (navegador)  ──WebSocket + token (Tailscale/LAN)──▶  Agente (PC da laser)  ──USB serial──▶  GRBL
```

## Segurança (leia antes de usar)

Laser remoto é risco de incêndio. Veja `docs/SEGURANCA.md`. Resumo:

- Nunca opere sem alguém por perto ou câmera ao vivo. Mantenha botão de emergência físico e extintor.
- A aba que iniciou o trabalho envia um sinal a cada 2 s. Se ela fechar, cair ou ficar 6 s muda, o agente **pausa e desliga o laser**. Se ninguém reconectar em 60 s, cancela o trabalho.
- Iniciar e retomar sempre pedem confirmação na interface.
- O agente recusa G-code com potência acima do máximo ou fora da área útil configurada.
- Acesso só por **Tailscale** ou rede local. Não exponha portas na internet.

## Como rodar

Requisitos: Node.js 20+.

```bash
npm install
npm run typecheck   # confere os tipos
npm test            # testes com o simulador de GRBL
```

### Testar sem a laser (simulador)

```bash
cp apps/agent/laserlink.config.example.json laserlink.config.json
# edite: "serialPort": "sim", um token com 16+ caracteres e a área útil
npm run build
npm run start:agent
```

Abra http://localhost:8787, informe o token e clique em **Conectar**. O simulador responde como um GRBL 1.1 de verdade (buffer de 127 bytes, `ok`, status, pausa).

### Com a laser

No PC da laser, edite `laserlink.config.json`:

| Campo | Exemplo | Descrição |
|---|---|---|
| `serialPort` | `COM3` ou `/dev/ttyUSB0` | porta da laser (`sim` = simulador) |
| `baudRate` | `115200` | |
| `wsPort` | `8787` | porta da interface e do WebSocket |
| `host` | `0.0.0.0` | onde escutar; use o IP do Tailscale para restringir |
| `token` | (16+ caracteres) | senha exigida no WebSocket |
| `maxFeed` | `6000` | velocidade máxima do jog (mm/min) |
| `maxSpindle` | `1000` | maior `S` aceito; use o valor do `$30` |
| `workArea` | `{ "x": 400, "y": 400 }` | área útil em mm a partir da origem |
| `machineLimits` | `{ "xMin": 0, "xMax": 400, "yMin": 0, "yMax": 400 }` | opcional: curso em coordenadas de máquina (com homing) |
| `reconnectGraceSec` | `60` | espera por reconexão antes de cancelar um trabalho pausado |
| `logDir` | `./logs` | opcional: pasta dos logs (padrão `apps/agent/logs`) |

```bash
npm run build
npm run start:agent
```

No Windows, instale como serviço e configure o Tailscale seguindo `docs/WINDOWS.md`.

Abra `http://IP-DO-PC-DA-LASER:8787` em qualquer aparelho da rede (ou o IP `100.x.y.z` do Tailscale), informe o token e conecte.

### Desenvolvimento da interface

```bash
npm run dev:agent   # agente com recarga (tsx)
npm run dev:web     # interface em http://localhost:5173; informe ws://localhost:8787
```

## Logs

- `apps/agent/logs/jobs.jsonl`: um registro por linha com início, fim, resultado e motivo de cada trabalho, e as recusas.
- `apps/agent/logs/agente.log`: saída do agente quando roda como serviço no Windows.

A pasta `apps/agent/logs/` fica fora do git.

## Estrutura

```
apps/agent       agente Node.js (serialport + ws)
  src/agent.ts       regras: heartbeat, perda de conexão, limites, log
  src/grbl.ts        streaming com contagem de caracteres, status, parada
  src/gcode-check.ts verificação de potência e área antes de enviar
  src/sim/           simulador de GRBL
  test/              testes (vitest)
apps/web         interface web (Vite + TypeScript)
packages/shared  tipos e validação das mensagens do protocolo
scripts/windows  instalação do agente como serviço (NSSM)
docs/            arquitetura, protocolo, segurança, Windows, testes na bancada, roadmap
```

## Licença

MIT. Este projeto é independente e não é afiliado ao LightBurn nem copia seu código, interface ou formato de arquivo.
