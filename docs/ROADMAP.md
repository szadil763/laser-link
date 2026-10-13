# Roadmap

## Fase 1: agente e controle (atual)
- [x] Estrutura do monorepo
- [x] Streaming GRBL com contagem de caracteres
- [x] WebSocket com token
- [x] Jog, origem, pausa, retomar, parar
- [x] Parada de segurança ao desconectar
- [ ] Testes com a laser real (bancada, potência baixa)
- [ ] Instalar agente como serviço no Windows

## Fase 2: enviar trabalhos
- [ ] Importar SVG (caminhos, camadas por cor)
- [ ] Importar imagem (limiar, dithering) para gravação
- [ ] Gerar G-code próprio (corte, gravação, passes)
- [ ] Enquadrar (frame) e simular

## Fase 3: editor
- [ ] Canvas com formas, texto, nós, offset, booleanas
- [ ] Biblioteca de materiais (potência/velocidade)
- [ ] Teste de matriz de potência x velocidade

## Fase 4: diferenciais
- [ ] Gerador paramétrico de caixas com compensação de kerf
- [ ] Peças dos projetos educacionais (carrinho RC, robô bípede)
- [ ] Fila de trabalhos e notificação no celular
- [ ] Câmera e timelapse
- [ ] Nesting
