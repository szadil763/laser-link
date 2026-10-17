# Peças prontas: caixa, carrinho e robô bípede

Os geradores ficam na barra de ferramentas à esquerda da mesa: botão **Caixa** e botão **Peças**.
Todos são projetos próprios do LaserLink, gerados do zero a partir das medidas.
Você pode salvar o resultado como **SVG** (para abrir em outro programa) ou como **G-code**, ou mandar direto para o agente.

> **Antes de cortar a primeira vez:** meça seus componentes com paquímetro.
> Motores TT, rodas bobas e placas ESP32 mudam de fabricante para fabricante.
> Os valores padrão são um ponto de partida, não uma garantia.

## Kerf (largura do corte)

O laser remove material. Sem compensação, os encaixes ficam frouxos.

1. Desenhe um quadrado de 20 mm (ferramenta de retângulo) e corte com kerf 0.
2. Meça a peça com paquímetro. Kerf = 20 − medida da peça.
   Exemplo: deu 19,7 mm → kerf de 0,3 mm.
3. Coloque esse valor no campo **Kerf** do gerador ou no material.

Encaixe duro demais: diminua o kerf em 0,02 mm. Frouxo: aumente.

## Caixa com encaixes

- **Medidas internas** = espaço útil. **Externas** = tamanho por fora.
- Com tampa são 6 peças, sem tampa são 5. O nome de cada peça vai gravado, se você marcar a opção.
- Montagem: base no chão, frente e trás nas pontas, laterais entre elas, tampa por cima.
- Cola branca (PVA) basta. Para uma tampa removível, não cole a tampa e lixe de leve os dentes dela.

## Chassi do carrinho (2 motores TT + roda boba + ESP32)

Peças: 1 base e 4 suportes de motor.

### O que medir antes

| Item | Campo | Padrão |
|---|---|---|
| Espessura do motor TT (face a face) | Espessura | 18,8 mm |
| Fim da caixa de redução até o eixo | Fim → eixo | 11,3 mm |
| Eixo até o 1.º furo de fixação | Eixo → 1º furo | 8,5 mm |
| Entre os 2 furos de fixação | Entre furos | 17,5 mm |
| Furos da ESP32 DevKit (comprimento × largura) | Furos ESP32 (comprimento e largura) | 47 × 23,5 mm |
| Entre os 2 furos da roda boba | Furos da roda boba | 23 mm |

A ESP32 DevKit de 30 pinos tem várias versões. Algumas nem têm furos: nesse caso, prenda com fita dupla face sobre o contorno gravado.

### Montagem

1. Encaixe os 4 suportes nos rasgos da base, com as abas para cima. Os furos grandes ficam alinhados.
2. Passe o motor entre dois suportes. O eixo atravessa o furo grande de cada lado.
3. Prenda cada motor com 2 parafusos M3 × 30 mm e porcas, atravessando os dois suportes e o motor.
4. Passe os fios pelos furos redondos perto dos motores.
5. Prenda a roda boba na frente com 2 parafusos M3.
6. Prenda o suporte de pilhas sobre o contorno gravado, com abraçadeira de nylon ou velcro nos 4 rasgos.
7. Prenda a ESP32 com espaçadores M2,5 (ou fita dupla face).
8. Os suportes podem receber uma gota de cola nas abas depois que tudo estiver alinhado.

O driver dos motores (L298N, TB6612 ou similar) pode ficar com fita dupla face entre a ESP32 e as pilhas.

## Robô bípede tipo Otto (todo em MDF)

Peças (16 no total):

| Peça | Quant. |
|---|---|
| Corpo: frente (furos do sensor HC-SR04), trás (passagem do cabo), laterais, base (2 servos), tampa | 6 |
| Perna: topo (prende no chifre do servo do quadril) | 2 |
| Perna: frente (servo do tornozelo) | 2 |
| Perna: trás | 2 |
| Pé: sola | 2 |
| Pé: suporte do tornozelo | 2 |

Use 4 servos SG90 (9 g). Antes de montar, **centralize os servos em 90°** com a placa ligada. Sem isso, o robô fica torto.

### Montagem

1. **Corpo:** monte a caixa sem colar a tampa. Encaixe o HC-SR04 na frente, por dentro.
2. **Quadris:** coloque os 2 servos nos recortes da base, com o eixo para baixo. Parafuse pelas orelhas.
3. **Pernas:** encaixe a frente e a trás no topo da perna. O servo do tornozelo entra no recorte da frente, com o eixo para baixo.
4. Parafuse o chifre do servo do quadril no topo da perna: parafuso do chifre no furo central e 2 parafusos pequenos no braço.
5. **Pés:** encaixe o suporte do tornozelo na sola. Parafuse o chifre do servo do tornozelo no suporte.
6. Passe os fios pela abertura na trás de cada perna e para dentro do corpo, pela base.

Esta é a versão 1 do desenho. Corte um conjunto em papelão ou MDF fino primeiro, para conferir se as folgas servem nos seus servos.

## Ajustes e limites

- Se uma medida não couber (motor maior que o suporte, servo que não cabe na base), o gerador mostra o erro e não gera nada.
- Todas as peças saem dentro da área da mesa. Se a fileira ficar larga demais, as peças passam para uma nova fileira.
- Cada peça vira um **grupo**: clique em um furo e a peça inteira fica selecionada para mover.
