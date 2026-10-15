# LaserLink

Controle remoto de cortadora/gravadora a laser **GRBL**. Dois pedaços de software:

- **Agente** (`apps/agent`): roda no PC ligado à laser por USB. Fala serial com o GRBL, faz o streaming do G-code e serve a interface e um WebSocket protegido por token.
- **Interface web** (`apps/web`): abre em qualquer navegador (PC de projeto, celular). Uma tela só, no estilo de programa de desenho:
  - **barra de cima**: menu **Arquivo** (abrir projeto, salvar, salvar como, importar SVG/DXF/imagem, exemplo, exportar SVG/DXF/G-code), menu **Editar** (desfazer, copiar, recortar, colar, duplicar, excluir, selecionar tudo, agrupar, desagrupar, alinhar, distribuir, travar e destravar), desfazer e o estado da conexão;
  - **barra de medidas**: X, Y, largura, altura, girar, espelhar, contorno deslocado, agrupar, desagrupar, duplicar e excluir o que está selecionado;
  - **ferramentas** à esquerda: vários, área (caixa de seleção), texto, caixa, peças, teste de matriz, deslocamentos e mesa clara/escura;
  - **mesa** no centro, com **Desenho** (o projeto) ou **Na máquina** (o trabalho enviado e o cabeçote em tempo real), e o botão **Limpar mesa** para a vista que está à mostra;
  - **faixa de operações** embaixo da mesa: Cortar, Gravar linha, Preenchido, Detalhado;
  - **painel à direita** com abas Camadas, Máquina (conexão, home, origem, mover, arquivo G-code), Fila e Registro, e embaixo o resumo com Enquadrar, Simular, Enviar e Guardar na fila. Com trabalho rodando aparecem Pausar, Retomar e PARAR.
  O G-code é gerado pelo próprio LaserLink (`packages/gcode`).

> Status: **Fases 1, 2 e 3 concluídas no simulador**, aguardando os testes na laser real (`docs/TESTES-NA-BANCADA.md`). Veja `docs/ROADMAP.md`.

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
| `framePower` | `10` | S do "Enquadrar com potência mínima" (padrão 1% de `maxSpindle`, no máximo 10%) |
| `frameFeed` | `3000` | velocidade do enquadramento, mm/min |
| `dataDir` | `./data` | opcional: pasta da biblioteca de materiais (padrão `apps/agent/data`) |
| `logDir` | `./logs` | opcional: pasta dos logs (padrão `apps/agent/logs`) |

```bash
npm run build
npm run start:agent
```

No Windows, o jeito mais fácil é clicar duas vezes em **Instalar LaserLink** (e depois em **Atualizar LaserLink** a cada versão nova). O passo a passo completo, com o Tailscale, está em `docs/WINDOWS.md`.

Abra `http://IP-DO-PC-DA-LASER:8787` em qualquer aparelho da rede (ou o IP `100.x.y.z` do Tailscale), informe o token e conecte.

### Desenvolvimento da interface

```bash
npm run dev:agent   # agente com recarga (tsx)
npm run dev:web     # interface em http://localhost:5173; informe ws://localhost:8787
```

## Preparar um trabalho

1. **Importe** (Arquivo > Importar) um SVG ou DXF (cada cor ou camada do DXF vira uma camada; vermelho vira Cortar) ou uma imagem PNG/JPG, ou arraste o arquivo para a mesa. Também dá para adicionar **Texto** (fonte de traço único) ou gerar um **Teste de matriz** potência × velocidade.
2. **Escolha a operação**: cada camada tem uma operação padrão, e cada elemento pode ter a sua (selecione na mesa e use a faixa de operações embaixo dela, ou a lista "Elementos" da camada):
   - **Cortar**: atravessa o material (com compensação de kerf).
   - **Gravar linha**: marca o contorno.
   - **Gravar preenchido**: hachura dentro da forma (intervalo padrão 0,2 mm).
   - **Detalhado**: preenchimento fino (0,08 mm), para textos e detalhes pequenos.
3. **Material**: escolha na camada (MDF 3 mm e 6 mm de exemplo) ou ajuste velocidade, potência e passes à mão. O botão **Materiais** edita a biblioteca, que fica salva no agente.
4. **Edite** se precisar: arraste o elemento selecionado ou use a barra de medidas (posição, tamanho, girar, espelhar, alinhar, contorno deslocado, duplicar, excluir). Desfazer fica na barra de cima (Ctrl+Z). Roda do mouse dá zoom; arrastar o fundo move a vista. O botão **Mesa clara** troca o fundo da mesa entre claro e escuro.
5. **Simular** mostra o percurso exato do G-code que será enviado. **Enquadrar** percorre o contorno na máquina com o laser desligado (ou em potência mínima, com confirmação).
6. **Enviar para a laser** pede confirmação, manda o arquivo inteiro ao agente e troca a mesa para **Na máquina**, para acompanhar.
7. **Guardar na fila** manda o arquivo ao agente sem ligar o laser (veja abaixo).
8. **Salvar** (Ctrl+S) guarda o projeto num arquivo `.laserlink` (formato próprio, com camadas, operações e a imagem). **Arquivo > Abrir projeto** (Ctrl+O) reabre. No Chrome/Edge abertos em `localhost`, o navegador pergunta onde salvar; pelo endereço do Tailscale o arquivo vai para a pasta de downloads.

**Selecionar e agrupar:** com a ferramenta **Área** ligada (ou segurando Shift), arraste no espaço vazio da mesa para desenhar uma caixa de seleção. Arrastando para a **direita**, entra o que fica inteiro dentro da caixa; para a **esquerda**, entra também o que a caixa só encosta. **Agrupar** (Ctrl+G) faz os selecionados andarem juntos; **Desagrupar** (Ctrl+Shift+G) separa, por exemplo, os furos de uma peça para mexer em um só. Ctrl+A seleciona tudo.

**Menu Editar:** **Copiar/Recortar/Colar** (Ctrl+C/X/V; cada colagem fica 10 mm mais ao lado, na mesma camada), **Alinhar** (entre si, ou na mesa quando é uma peça só), **Distribuir** (três ou mais peças com espaços iguais, mantendo as das pontas) e **Travar peça** (Ctrl+L): a peça continua na mesa e no corte, mas não se move, não gira e não é excluída até **Destravar** (Ctrl+Shift+L). Na barra de medidas, a peça travada aparece com 🔒.

**Textos editáveis:** dê **dois cliques** num texto da mesa (o da ferramenta Texto, os nomes gravados da caixa ou o texto do carrinho) para reescrever. O texto novo fica no mesmo lugar.

**DXF:** linhas, polilinhas (com arcos), círculos, arcos, elipses, splines e blocos. Textos, cotas e hachuras do DXF ficam de fora (converta em linhas no programa de desenho). A unidade vem do arquivo; sem ela, milímetros.

### Peças prontas

- **Caixa**: caixa com encaixes de dentes, com ou sem tampa, medidas internas ou externas, kerf do material.
- **Peças**: chassi do carrinho (2 motores TT, roda boba, ESP32 DevKit) e robô bípede tipo Otto, todo em MDF.
- **Baixar SVG** e **Baixar G-code** salvam o projeto no seu computador.

Medidas, montagem e o que conferir com paquímetro: `docs/PECAS.md`.

## Fila de trabalhos

- **Guardar na fila** (embaixo do painel direito, ou na aba Máquina com um arquivo G-code escolhido): o agente confere o arquivo e guarda. Nada liga o laser. A fila fica na aba **Fila**.
- A fila fica no agente: o PC e o celular veem a mesma. Dá para subir, descer e tirar trabalhos.
- **A fila nunca começa um trabalho sozinha.** Cada **Iniciar** pede confirmação, e o agente confere o arquivo de novo (a origem pode ter mudado).
- Quando um trabalho termina, aparece um aviso no topo com som (três notas quando conclui, notas graves quando para por erro ou cancelamento), o título da aba muda e o próximo da fila aparece com o botão **Iniciar próximo da fila**. O som pode ser desligado na seção Trabalho.
- O navegador só libera o som depois do primeiro clique na página.
- A fila fica na memória do agente: se ele reiniciar, a fila se perde.

## Logs

- `apps/agent/logs/jobs.jsonl`: um registro por linha com início, fim, resultado e motivo de cada trabalho, e as recusas.
- `apps/agent/logs/agente.log`: saída do agente quando roda como serviço no Windows.
- `apps/agent/data/materials.json`: biblioteca de materiais (criada quando você salva pela interface).

As pastas `apps/agent/logs/` e `apps/agent/data/` ficam fora do git.

## Estrutura

```
apps/agent       agente Node.js (serialport + ws)
  src/agent.ts       regras: heartbeat, perda de conexão, limites, log
  src/grbl.ts        streaming com contagem de caracteres, status, parada
  src/gcode-check.ts verificação de potência e área antes de enviar
  src/sim/           simulador de GRBL
  test/              testes (vitest)
apps/web         interface web (Vite + TypeScript)
  src/prepare/       desenho: modelo, importação, mesa, edição
  src/preview.ts     mesa "Na máquina" (trabalho enviado e cabeçote)
  src/theme.ts       cores da mesa clara/escura
  src/prepare/project.ts  arquivo de projeto .laserlink
  src/chime.ts       sons de aviso (Web Audio)
packages/gcode   gerador de G-code puro, com testes (kerf, hachura, raster, texto, matriz, caixa, peças, SVG)
packages/shared  tipos e validação das mensagens do protocolo, materiais de exemplo
scripts/windows  instalação do agente como serviço (NSSM)
docs/            arquitetura, protocolo, segurança, Windows, testes na bancada, roadmap
```

## Licença

MIT. Este projeto é independente e não é afiliado ao LightBurn nem copia seu código, interface ou formato de arquivo.
