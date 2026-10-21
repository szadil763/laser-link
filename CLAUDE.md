# CLAUDE.md — LaserLink

Guia para o Claude Code trabalhar neste repositório.

## Contexto

Projeto do Adilson (Guarulhos/SP): controlar remotamente uma laser GRBL ligada a um PC antigo (Windows) a partir de outro PC. Idioma: **português do Brasil** em docs, mensagens de UI e commits. Código e identificadores em inglês.

## Arquitetura

Monorepo npm workspaces:

- `packages/shared`: tipos do protocolo (única fonte de verdade das mensagens cliente↔agente), validação e materiais de exemplo.
- `packages/gcode`: gerador de G-code puro (sem DOM, sem Node), com testes. Usado pela interface; o agente só confere.
- `apps/agent`: Node.js + `serialport` + `ws`. Dono da conexão com o GRBL e do streaming do G-code.
- `apps/web`: Vite + TypeScript, sem framework no MVP.

## Regras inegociáveis (segurança)

1. **Nunca** fazer streaming de G-code pela rede. O arquivo vai inteiro ao agente.
2. Se o cliente desconectar (ou ficar mudo 6 s) com trabalho em andamento: `!` (feed hold) e, já em Hold, `0x9E` para desligar o laser. Se ninguém reconectar em `reconnectGraceSec`, cancelar com reset e `M5`. Um `M5` direto durante o Hold não serve: ele fica na fila e só roda ao retomar.
3. Todo WebSocket exige token. Sem token válido, fechar a conexão.
4. Comandos de tempo real do GRBL (`!`, `~`, `?`, `0x18`, `0x9E`) passam fora da fila de linhas.
5. Não adicionar funcionalidade que ligue o laser sem confirmação explícita do usuário na UI (no protocolo: `confirmLaserOn: true`). Isso vale para a fila: o próximo trabalho nunca começa sozinho (`queueStart` exige `confirmLaserOn: true`).
6. Não expor portas na internet; documentar Tailscale ou LAN.

## Streaming GRBL

Usar *character-counting*: manter a soma dos bytes enviados e ainda não confirmados com `ok` abaixo de 127 (buffer de RX do GRBL 1.1). Tratar `error:N` e `ALARM:N` parando o trabalho.

## Comandos

```bash
npm install
npm run typecheck
npm test            # packages/gcode e apps/agent
npm run dev:agent
npm run dev:web
```

## Convenções

- TypeScript estrito. Sem `any`.
- Mudou o protocolo? Atualize `packages/shared/src/protocol.ts` e `docs/PROTOCOLO.md` juntos.
- Commits curtos em português, no imperativo.
- Não copiar código, interface, ícones ou formato de arquivo do LightBurn.
- G-code gerado precisa passar em `checkGcode` do agente (há teste em `apps/agent/test/gcode-integration.test.ts`).

## Projetos para a laser (SVG)

Para gerar peças/desenhos para a máquina, use a skill `.claude/skills/laserlink-svg` (formato do SVG, cores das operações, texto em caminhos) e publique com `node scripts/publicar-projeto.mjs` (ramo `projetos`, aparece em Arquivo > Projetos recebidos). Nunca inicie trabalho nem ligue o laser: só entregue o desenho.

## Próximos passos

Veja `docs/ROADMAP.md`. Fases 1, 2 e 3 prontas no simulador; falta validar na bancada (`docs/TESTES-NA-BANCADA.md`). Depois: câmera, nesting e editor vetorial (seção "Depois" do roadmap).
