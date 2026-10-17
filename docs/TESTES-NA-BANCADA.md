# Testes na bancada

O que os testes automáticos (com o simulador) **não** conseguem provar e precisa ser conferido na laser real.

**Regras para todos os testes**
- Use óculos de proteção para o comprimento de onda do laser, exaustão ligada e extintor por perto.
- Faça cada teste **primeiro com o laser desligado** (`S0` no G-code, ou com o módulo laser desconectado/coberto) e só depois com **potência baixa** (S10 a S50, ou 1% a 5% do `$30`), sobre papelão ou MDF de sobra.
- Fique ao lado da máquina com a mão perto do botão de emergência físico.
- Anote o resultado de cada item (data, ✅/❌, observação) no fim deste arquivo.

## 0. Preparação

- [ ] Ler os parâmetros do GRBL com `$$` (pelo LaserGRBL ou monitor serial, antes de instalar o agente) e anotar: `$30` (S máx), `$32` (modo laser, deve ser `1`), `$10` (relatório de status), `$20`/`$21`/`$22` (soft/hard limits, homing).
- [ ] Ajustar `maxSpindle` = `$30` e `workArea` = área útil real no `laserlink.config.json`.
- [ ] Rodar o agente com `"serialPort": "sim"` no PC da laser e abrir a interface de outro PC pelo Tailscale. Confirmar que tudo funciona antes de conectar a máquina.

## 1. Conexão e status (laser desligado)

- [ ] Agente abre a porta COM; a interface mostra "Laser conectada" e o estado `Idle`.
- [ ] Posição X/Y muda ao mover com o jog (passo de 1 mm e de 10 mm, nos quatro sentidos). O sentido bate com a máquina?
- [ ] "Definir origem aqui" zera X/Y na interface (coordenadas de trabalho).
- [ ] "Origem pelo desenho" com o ponto **Centro**: leve o carrinho ao meio de um retalho, clique e confira que X/Y viram o centro do desenho. **Enquadrar** (laser desligado) deve percorrer o contorno em volta do carrinho.
- [ ] Repita com um canto (ex.: canto de cima, à direita): o enquadramento deve começar a partir do carrinho para baixo e para a esquerda.
- [ ] "Home" (se houver chaves de fim de curso) e "Destravar" após um alarme.
- [ ] Desconectar o cabo USB: a interface mostra "Laser desconectada" em até 2 s. Reconectar: volta sozinha.

## 2. Streaming (laser desligado, depois potência baixa)

- [ ] Arquivo pequeno (um quadrado de 20 mm) termina com "concluído" e o cabeçote volta parado; o log mostra `M5` no fim.
- [ ] Arquivo grande (milhares de linhas, ex.: gravação raster) roda sem engasgar: o movimento é contínuo, sem paradas entre linhas.
- [ ] Barra de progresso acompanha o trabalho.
- [ ] Com potência baixa: o quadrado sai marcado de forma uniforme.

## 3. Pausa, retomada e PARAR (laser desligado, depois potência baixa)

- [ ] **Pausar** no meio de uma linha: o cabeçote desacelera e para. Com potência baixa, **o laser apaga durante a pausa** (olhe o ponto: não pode ficar queimando parado).
- [ ] **Retomar** pede confirmação e continua do ponto em que parou, sem falha visível na marcação.
- [ ] **PARAR**: o cabeçote para, o laser apaga, o trabalho é cancelado. Depois do PARAR o GRBL pode entrar em `Alarm` (reset em movimento); "Destravar" resolve.

## 4. Perda de conexão (o mais importante)

Faça com o laser desligado, depois com potência baixa.

- [ ] **Fechar a aba** que iniciou o trabalho: em menos de 1 s o cabeçote para. Com potência baixa, **o laser apaga** em até ~0,5 s depois de parar (o agente envia `0x9E` quando o GRBL confirma o Hold).
- [ ] Reabrir a interface: aparece o aviso "Trabalho pausado" com o motivo. **Retomar** pede confirmação, o laser volta a acender e o trabalho continua.
  - [ ] Conferir se ao retomar o GRBL espera o laser religar antes de andar (o GRBL 1.1 tem um pequeno atraso de restauração).
- [ ] **Tirar o cabo de rede/desligar o Wi-Fi** do PC de projeto: em ~6 s o agente pausa (heartbeat). A interface mostra "Conexão instável" e depois "Reconectando…".
- [ ] Deixar **60 s sem nenhum cliente** com o trabalho pausado: o agente cancela (reset + `M5`) e, ao reconectar, a interface mostra "Último trabalho: … cancelado".
- [ ] Com o celular só observando e o PC dono caindo: o trabalho pausa mesmo assim.
- [ ] **Celular como dono:** iniciar pelo celular e apagar a tela. Anotar se o navegador mantém a conexão (Wake Lock) ou se pausa. Isso define se dá para usar o celular em trabalhos longos.
- [ ] **Aba em segundo plano no PC:** iniciar um trabalho de 10 min ou mais e trocar de aba ou minimizar o navegador. O trabalho **não** pode pausar.

## 5. Limites (laser desligado)

- [ ] Arquivo com `S` acima de `maxSpindle`: recusado, a interface lista a linha, **nada se move**.
- [ ] Arquivo maior que a área útil: recusado com a linha e as coordenadas.
- [ ] Origem definida perto da borda e arquivo que passaria do limite a partir dela: recusado (movimentos G91).
- [ ] Arquivo de outros programas que você usa (LaserGRBL, Inkscape, etc.): aceito? Se for recusado por algum G-code legítimo, anote qual para ajustarmos o verificador.

## 6. Serviço no Windows

- [ ] `scripts\windows\instalar-servico.ps1` roda sem erro no PowerShell como Administrador (é a primeira execução real do script; acentos aparecem certos?).
- [ ] Após reiniciar o PC, o serviço sobe sozinho e a interface conecta pelo Tailscale **sem ninguém logar no Windows**.
- [ ] `nssm stop LaserLink` com trabalho em andamento (laser desligado): a máquina para e o log de trabalhos registra "Agente encerrado".
- [ ] Matar o processo `node.exe` pelo Gerenciador de Tarefas durante um trabalho: o serviço volta em ~5 s e a interface mostra "Último trabalho: … interrompido (o agente reiniciou)".
  - [ ] ⚠️ Observar o que a **máquina** faz nesse caso: o processo morre sem enviar hold. Ao reabrir a porta, a maioria das placas reinicia o GRBL (DTR), o que para o movimento. Anote se o laser apagou e em quanto tempo.
- [ ] Firewall: de um aparelho fora do Tailscale e fora da rede local, a porta 8787 não responde.

## 7. Fase 2: trabalhos gerados pelo LaserLink

Primeiro sempre com **Simular**, depois **Enquadrar com laser desligado**, depois potência baixa em retalho.

- [ ] **Enquadrar (laser desligado)**: o cabeçote percorre o retângulo do trabalho e volta ao canto. Confere com a peça?
- [ ] **Enquadrar com potência mínima** (S`framePower`): o ponto fica visível mas **não marca** o material. Se marcar, reduza `framePower`.
- [ ] **Teste de matriz** em MDF 3 mm (potência baixa primeiro): os quadrados saem na ordem certa (potência sobe para cima, velocidade para a direita) e os rótulos ficam legíveis. Anote a melhor combinação e salve no material.
- [ ] **M4 dinâmico**: nos cantos de um quadrado, a marca não fica mais escura que no meio da linha (confirma `$32=1`, modo laser).
- [ ] **Kerf**: corte um quadrado de 20 mm e um furo de 10 mm com kerf 0. Meça com paquímetro: kerf = 20 − medida do quadrado. Ajuste o kerf no material e corte de novo: as medidas devem bater (±0,1 mm).
- [ ] **Ordem do corte**: com uma peça com furos, os furos são cortados antes do contorno (a peça não cai antes).
- [ ] **Preenchido e detalhado**: o preenchimento fica uniforme, sem listras; o detalhado (0,08 mm) não queima demais (se queimar, aumente a velocidade ou o intervalo).
- [ ] **Imagem**: gravação nos dois sentidos sem "fantasma" (linhas de ida e volta alinhadas). Se desalinhar, aumente o overscan ou reduza a velocidade. O overscan não pode passar da borda da mesa.
- [ ] **SVG do Inkscape** (mm) e de outro programa (px): o tamanho importado bate com o desenho original.
- [ ] **Texto**: altura de 5 mm legível em linha; acentos viram letras sem acento.

## 8. Fase 3: peças prontas e fila

Antes de tudo, meça kerf, motores, servos e a placa ESP32 com paquímetro (`PECAS.md`).

- [ ] **Caixa com encaixes** (100 × 80 × 60, MDF 3 mm, kerf medido): as peças encaixam firmes, sem martelo e sem folga. Ajuste o kerf em 0,02 mm se precisar.
- [ ] **Caixa com medidas internas**: o espaço interno bate com o pedido (±0,3 mm).
- [ ] **Carrinho**: os 4 suportes entram nos rasgos da base; o motor TT passa entre dois suportes e os furos dele batem com os do suporte; o eixo gira livre no furo grande.
- [ ] **Carrinho**: os furos da roda boba e da ESP32 batem com as suas peças.
- [ ] **Otto** (montagem de teste, papelão ou MDF): o SG90 entra justo nos recortes da base e da perna; os furos das orelhas batem; o chifre do servo encaixa no topo da perna e no suporte do pé; o HC-SR04 entra nos furos da frente.
- [ ] **Fila**: guarde dois trabalhos curtos; inicie o primeiro. Ao terminar, o aviso aparece com som e **o segundo não começa sozinho** (espere 1 minuto).
- [ ] **Fila com origem mudada**: guarde um trabalho, mude a origem para perto da borda e tente iniciar. O agente deve recusar se o trabalho passar da área.
- [ ] **Som**: toca no PC e no celular (lembre de tocar na página uma vez antes).

## Resultados

| Data | Item | Resultado | Observação |
|---|---|---|---|
| | | | |
