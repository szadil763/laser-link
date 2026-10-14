# Roadmap

## Fase 1: agente e controle (concluída no simulador; falta a bancada)
- [x] Estrutura do monorepo
- [x] Streaming GRBL com contagem de caracteres
- [x] WebSocket com token
- [x] Jog, origem, pausa, retomar, parar
- [x] Parada de segurança ao desconectar
- [x] a) Simulador de GRBL (porta serial falsa)
- [x] b) Testes: parseStatus, contagem de caracteres, abortJob, parada ao desconectar
- [x] c) Heartbeat (ping a cada 2 s, hold após 6 s mudo) e estado da conexão na UI
- [x] d) Limite de potência (S máx) e área útil configuráveis; recusar G-code fora dos limites
- [x] e) Reconexão automática da interface e da serial, sem perder o aviso de trabalho interrompido
- [x] f) Agente como serviço no Windows e passo a passo com Tailscale
- [x] g) Log de trabalhos em `apps/agent/logs`
- [ ] Testes com a laser real (ver `TESTES-NA-BANCADA.md`)
- [ ] Rodar `instalar-servico.ps1` no PC da laser (primeira execução real)

## Fase 2: enviar trabalhos (MVP) (concluída no simulador; falta a bancada)
- [x] a) Pré-visualização do G-code em canvas (trajetória, área útil, cabeçote em tempo real)
- [x] b) Importar SVG: polilinhas, camadas por cor, modo Cortar/Gravar linha, velocidade, potência, passes
- [x] c) Importar imagem: escala de cinza, limiar, Floyd-Steinberg, raster bidirecional com overscan
- [x] d) Gerador de G-code próprio em `packages/gcode` (M4 dinâmico, ordenação de caminhos, kerf)
- [x] e) Enquadrar (frame) com laser desligado ou potência mínima configurável
- [x] f) Biblioteca de materiais (JSON), com MDF 3 mm e 6 mm de exemplo
- [x] g) Teste de matriz potência × velocidade
- [x] Extra: operação por elemento (cortar, linha, preenchido, detalhado)
- [x] Extra: edição básica (mover, girar, escalar, espelhar, alinhar, duplicar, desfazer)
- [x] Extra (adiantado): texto em fonte de traço único e contorno deslocado (offset)
- [ ] Testes com a laser real (ver `TESTES-NA-BANCADA.md`, seção Fase 2)

## Fase 3: diferenciais
- [ ] a) Gerador paramétrico de caixas com encaixes (finger joints) e kerf
- [ ] b) Peças dos projetos educacionais (carrinho RC em MDF, robô bípede tipo Otto)
- [ ] c) Fila de trabalhos e notificação ao terminar

## Depois
- [ ] Câmera e timelapse
- [ ] Nesting
- [ ] Editor vetorial completo: edição de nós, booleanas (unir, subtrair, interseção), matriz de cópias
- [ ] Texto com fontes de contorno (TTF/OTF) além da fonte de traço único
- [ ] Atualizar o vitest para a versão 4+ (o npm falha ao resolver hoje; afeta só ferramentas de teste)
