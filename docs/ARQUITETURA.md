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
- `agent.ts`: regras independentes do transporte: dono do trabalho, heartbeat, pausa por perda de conexão, cancelamento após `reconnectGraceSec`, reabertura da serial, log de trabalhos, recuperação após reinício e fila de trabalhos (na memória, conferida ao guardar e de novo ao iniciar; nunca inicia sozinha).
- `job-log.ts`: log JSON Lines em `apps/agent/logs/jobs.jsonl`.
- `static.ts`: serve a interface compilada (`apps/web/dist`) na mesma porta do WebSocket.
- `sim/fake-grbl.ts`: GRBL falso para testes e para `"serialPort": "sim"`.
- `index.ts`: liga tudo: servidor HTTP + WebSocket, token, sinais de encerramento.

**Interface (`apps/web`)**
- `connection.ts`: WebSocket com reconexão automática e ping a cada 2 s, com timer num Web Worker (`tick-worker.ts`) para não sofrer o limite de timers de abas em segundo plano.
- `main.ts`: estado da conexão e da laser, posição, jog, origem, envio de arquivo com confirmação, aviso de trabalho pausado (Retomar/Cancelar), problemas de trabalho recusado, último resultado, Wake Lock na aba dona, fila e aviso de fim de trabalho (com som de `chime.ts`).

**Gerador (`packages/gcode`)**, puro e testado
- `emit.ts`: gera o G-code do projeto (M4, S proporcional, ordem imagem → detalhado → preenchido → linhas → cortes, passes, comentários por camada, sem repetir palavras modais).
- `order.ts`: vizinho mais próximo; no corte, nada é cortado antes do que está dentro dele.
- `offset.ts`: kerf e contorno deslocado com clipper-lib (Clipper de Angus Johnson, licença Boost).
- `hatch.ts`: hachura par-ímpar em zigue-zague. `raster.ts`: limiar, Floyd-Steinberg e trechos por linha.
- `text.ts`: fonte própria de traço único. `matrix.ts`: teste potência × velocidade. `frame.ts`: enquadrar. `parse.ts`: lê G-code para pré-visualizar e simular (o agente usa para estimar o tempo dos trabalhos da fila).
- `dxf.ts`: leitura de DXF (linhas, polilinhas com bulge, círculos, arcos, elipses, splines, blocos, unidades) e exportação em DXF R12 com uma camada por operação.
- `text.ts` marca as letras com o texto escrito (`Path.text`), para a interface editar com dois cliques.
- `box.ts`: caixa com encaixes de dentes (número ímpar de dentes por borda; frente e trás ficam com os cantos). `svg.ts`: exporta o projeto em SVG (mm).
- `parts/`: peças planas (`shapes.ts`, `layout.ts`), chassi do carrinho (`car.ts`) e robô bípede (`otto.ts`). Cada peça vira um grupo na interface.

**Interface: desenho (`apps/web/src/prepare`)**
- `model.ts`: camadas, elementos (com operação própria), imagem, desfazer e conversão para o gerador.
- `importers.ts`: SVG lido pelo próprio navegador (curvas amostradas, camadas por cor), DXF (pelo `packages/gcode`) e PNG/JPG.
- `project.ts`: projeto `.laserlink` (JSON próprio com camadas, elementos e a imagem em PNG embutido).
- `workspace.ts`: mesa "Desenho", seleção, barra de medidas, faixa de operações, camadas, materiais, simular (percorre o G-code real), enquadrar e enviar.
- `bed-view.ts` (usado pelas duas mesas): câmera com zoom, arrastar, pinça, grade em mm e posição do mouse. `preview.ts`: mesa "Na máquina", com a trajetória e o cabeçote ao vivo. `theme.ts`: cores da mesa clara/escura (guardadas no navegador).
- Tela única: barra de cima, barra de medidas, ferramentas à esquerda, mesa no centro, faixa de operações, barra de envio (com Pausar e PARAR durante o trabalho), janela à direita com abas (Camadas, Máquina, Fila, Registro; pode ser ampliada sobre a mesa sem mudar o tamanho dela) e barra de status. No computador a página não rola; no celular tudo empilha.

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
| G-code gerado no navegador | O agente continua simples e só confere; o mesmo arquivo é simulado, pré-visualizado e enviado |
| clipper-lib em vez de clipper2-js | Mesmo algoritmo e licença; a clipper2-js exige o Angular como dependência |
| Materiais no agente | A biblioteca vale para o PC e o celular; arquivo JSON simples, fora do git |

## Alternativas consideradas

- **ESP32 + FluidNC**: Wi-Fi nativo, sem PC. Não substitui o editor, e este projeto cobre o lado do PC.
- **CNCjs/LaserWeb**: bons para começar; LaserLink mira integração com editor próprio e geradores paramétricos.

## Fases futuras

Câmera, nesting e editor vetorial completo. Veja `ROADMAP.md`.
