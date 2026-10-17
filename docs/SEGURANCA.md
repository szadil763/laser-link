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
- [x] Desconexão do cliente durante trabalho: `!` e, em Hold, `0x9E` (laser desligado); cancela com reset + `M5` se ninguém reconectar em 60 s.
- [x] Heartbeat: cliente mudo por 6 s = mesma parada acima.
- [x] Parada em `error:` e `ALARM:`.
- [x] `Parar` envia reset suave (0x18) e `M5`.
- [x] Confirmação na UI antes de iniciar e de retomar (`confirmLaserOn` no protocolo).
- [x] Limite de potência (`maxSpindle`) e área útil (`workArea`) no agente: G-code fora dos limites é recusado inteiro.
- [x] Enquadrar com laser desligado por padrão; potência mínima (`framePower`, no máximo 10% de `maxSpindle`) só com confirmação.
- [x] G-code gerado pela interface passa pelas mesmas conferências de potência e área no agente.
- [x] Log de trabalhos em `apps/agent/logs/jobs.jsonl` (início, fim, resultado, motivo e recusas).

## A aba que iniciou o trabalho

O heartbeat vem da aba que iniciou (ou retomou) o trabalho. Se ela fechar, o computador dormir ou o celular apagar a tela e suspender o navegador, o agente pausa o trabalho e desliga o laser. Isso é proposital.
A interface pede para manter a tela acesa (Wake Lock) nessa aba, mas no celular nem todo navegador respeita. Para trabalhos longos, prefira um computador.

## Rede

- Use **Tailscale** ou rede local. Não faça port-forward do agente.
- Troque o token padrão. Gere um longo e aleatório.
- A interface lembra o token no navegador depois da primeira conexão aceita (opção "Lembrar o token neste computador", ligada por padrão). Em computador compartilhado, desmarque ou use "Esquecer token": aí ele fica só na aba e some quando o navegador fecha.
- Considere TLS (wss) via proxy se sair da rede local.
- O firewall do Windows (regra criada pelo `instalar-servico.ps1`) aceita a porta só do Tailscale e da rede local. Veja `WINDOWS.md`.

## Regra de ouro

Só inicie um corte se você estiver vendo a máquina ou houver alguém presente.
