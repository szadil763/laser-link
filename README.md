# LaserLink

Controle remoto de cortadora/gravadora a laser **GRBL**. Dois pedaços de software:

- **Agente** (`apps/agent`): roda no PC ligado à laser por USB. Fala serial com o GRBL e expõe um WebSocket seguro.
- **Interface web** (`apps/web`): abre em qualquer navegador (PC de projeto, celular). Move o cabeçote, define origem, envia o trabalho, pausa e para.

> Status: **MVP em construção (v0.1)**. Hoje: conexão, jog, comandos de controle (pausa/retomar/parar), envio de G-code com streaming no agente, autenticação por token e parada de segurança ao perder a conexão. Editor de design vem nas próximas fases (veja `docs/ROADMAP.md`).

## Por que assim

O G-code **nunca é transmitido linha a linha pela rede**. A interface envia o arquivo inteiro ao agente e o agente faz o streaming serial localmente. Uma oscilação de Wi-Fi não interrompe o corte no meio.

```
 PC de projeto (navegador)  ──WebSocket (Tailscale/LAN)──▶  Agente (PC da laser)  ──USB serial──▶  GRBL
```

## Segurança (leia antes de usar)

Laser remoto é risco de incêndio. Veja `docs/SEGURANCA.md`. Resumo:

- Nunca opere sem alguém por perto ou câmera ao vivo.
- Mantenha botão de emergência físico e extintor.
- Se o cliente desconectar durante um trabalho, o agente faz *feed hold* e desliga o laser (`M5`).
- Acesso só por **Tailscale** ou rede local. Não exponha portas na internet.

## Como rodar

Requisitos: Node.js 20+.

```bash
npm install
npm run build -w @laserlink/shared

# Agente (no PC da laser)
cp apps/agent/laserlink.config.example.json laserlink.config.json
# edite: porta serial (COM3 no Windows, /dev/ttyUSB0 no Linux), baudrate e token
npm run dev:agent

# Interface (qualquer PC)
npm run dev:web
```

Abra a interface, informe `ws://IP-DO-PC-DA-LASER:8787` e o token.

## Estrutura

```
apps/agent     agente Node.js (serialport + ws)
apps/web       interface web (Vite + TypeScript)
packages/shared tipos e mensagens do protocolo
docs/          arquitetura, protocolo, segurança, roadmap
```

## Licença

MIT. Este projeto é independente e não é afiliado ao LightBurn nem copia seu código, interface ou formato de arquivo.
