# Materiais

A biblioteca de materiais fica no agente (`apps/agent/data/materials.json`) e vale para todos os aparelhos. Os valores de exemplo são para laser de **diodo de ~10 W**: confira cada material com o **Teste de matriz** (potência × velocidade) numa sobra antes do trabalho de verdade e ajuste em **Materiais**.

Na camada, ao escolher o material, aparecem os cuidados dele embaixo do seletor.

## Exemplos que vêm com o app

| Material | Corta? | Observações |
|---|---|---|
| MDF 3 mm / 6 mm | sim | o mais usado; 6 mm precisa de mais passes |
| Compensado 3 mm | sim | a cola entre as lâminas pode pedir mais passes |
| Balsa 2 mm | sim | corta rápido; maquetes e aeromodelos |
| EVA 2 mm | sim | derrete fácil: pouca potência, ventile bem |
| Papel cartão / cartolina (até 0,3 mm) | sim | pega fogo rápido: velocidade alta, prenda o papel |
| Papel lamicote (cartão metalizado) | sim | corte com o lado branco para cima (a película reflete o laser) e ventile |
| Papel paraná 1,5 mm | sim | papelão cinza rígido para maquetes e moldes |
| Papelão ondulado 3 mm | sim | **risco alto de chama** nas ondas: nunca deixe sozinho |
| Acrílico preto 3 mm | sim, com vários passes | diodo **não corta acrílico transparente nem azul**; ventile |
| Couro natural 2 mm | sim | só couro natural (curtido ao vegetal) |
| Feltro 2 mm | sim | o de poliéster derrete um pouco na borda |
| Cortiça 3 mm | sim | grava muito bem |
| Tecido de algodão | sim | estique e prenda |
| Ardósia | **não**, só gravar | grava em tom claro |
| Alumínio anodizado | **não**, só gravar | tira a cor da camada anodizada |

Se a camada tem cortes e o material é só para gravar, o app avisa.

## Nunca coloque na laser

Estes materiais soltam gás tóxico ou corrosivo (que também estraga a máquina) ou pegam fogo com facilidade:

- **PVC e vinil** (inclusive adesivo vinílico, lona, "couro sintético" e muitos EVA "emborrachados" com cloro): soltam cloro.
- **Policarbonato** (parece acrílico, mas amarela e pega fogo).
- **ABS** (plástico de brinquedo e de impressão 3D).
- **Fibra de vidro e placas de circuito**.
- **Espuma de poliestireno (isopor)** e **espuma de poliuretano**: pegam fogo.
- Qualquer material que você não sabe o que é.

Na dúvida, não corte. E sempre: alguém olhando a máquina, ventilação ligada e um borrifador ou extintor por perto.

## Biblioteca já salva

Se você já salvou materiais antes, os exemplos novos de uma atualização entram sozinhos no fim da lista. O que você editou continua como está, e um exemplo que você apagou não volta (o agente anota em `apps/agent/data/materiais-padrao.json` quais exemplos já ofereceu).
