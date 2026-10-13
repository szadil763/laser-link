# Segurança

Laser sem supervisão é risco real de incêndio e de ferimento. Este documento é requisito do projeto, não sugestão.

## Hardware

- Botão de emergência físico cortando a alimentação da laser.
- Extintor (CO2 ou pó) ao alcance.
- Sensor de chama/fumaça, de preferência com corte automático.
- Câmera ao vivo apontando para a área de corte.
- Proteção ocular adequada ao comprimento de onda do laser.
- Exaustão funcionando.
- Cabo USB curto e de boa qualidade.

## Software (implementado e planejado)

- [x] Token obrigatório no WebSocket.
- [x] Desconexão do cliente durante trabalho: `!` + `M5`.
- [x] Parada em `error:` e `ALARM:`.
- [x] `Parar` envia reset suave (0x18) e `M5`.
- [ ] Confirmação extra na UI antes de iniciar o trabalho.
- [ ] Timeout de heartbeat (cliente mudo = pausa).
- [ ] Limite máximo de potência configurável no agente.
- [ ] Log de trabalhos.

## Rede

- Use **Tailscale** ou rede local. Não faça port-forward do agente.
- Troque o token padrão. Gere um longo e aleatório.
- Considere TLS (wss) via proxy se sair da rede local.

## Regra de ouro

Só inicie um corte se você estiver vendo a máquina ou houver alguém presente.
