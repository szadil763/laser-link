---
name: laserlink-svg
description: Gera arquivos SVG prontos para a laser GRBL do Adilson (LaserLink) e, quando possível, publica o arquivo para aparecer no app em Arquivo > Projetos recebidos. Use sempre que pedirem para desenhar, criar, gerar ou mandar uma peça, placa, painel, letreiro, chaveiro, caixa, plaquinha, bandeirola, molde ou qualquer desenho "para a laser", "para cortar", "para gravar" ou "para o LaserLink", mesmo que a pessoa não diga "SVG".
---

# SVG para a laser do LaserLink

O LaserLink importa SVG e decide a operação pela cor. Esta skill garante que o arquivo abra com o tamanho certo, a operação certa e no lugar certo, e explica como entregá-lo.

## Regras de segurança (nunca quebrar)

- Você só **entrega o desenho**. Nunca inicie trabalho, nunca ligue o laser, nunca mexa no agente.
- O arquivo chega como desenho na mesa do app; a pessoa revisa, escolhe o material e manda cortar com confirmação.
- Não exponha portas nem tokens. A entrega é por arquivo ou pelo ramo `projetos` do GitHub.

## A máquina

- Área útil: a do `workArea` do `laserlink.config.json` (no app: janela Máquina, abra Conexão: "Limites do agente").
  Se não souber, pergunte. O padrão do LaserLink é **400 × 400 mm**. Nada pode passar da área.
- Origem (0,0) no canto de **baixo à esquerda** da mesa.
- Material mais comum: MDF 3 mm. Kerf (largura do corte) ~0,15 mm: o app compensa sozinho; desenhe na medida final.

## Formato do SVG

1. Unidade em mm, 1 unidade = 1 mm:
   `<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="100mm" viewBox="0 0 200 100">`
2. **Posição**:
   - Padrão: o app coloca o desenho a 20 mm da origem (a posição no arquivo não importa).
   - Para valer a posição exata na mesa, faça o SVG do tamanho da mesa e marque `data-laserlink="mesa"`:
     `<svg … width="400mm" height="400mm" viewBox="0 0 400 400" data-laserlink="mesa">`
     Lembre: no SVG o y cresce **para baixo**; na mesa, para cima (y_mesa = altura − y_svg).
3. **Operação pela cor** (use exatamente estas):

   | Quero | No SVG |
   |---|---|
   | Cortar | `fill="none" stroke="#ff0000"` |
   | Gravar linha (contorno) | `fill="none" stroke="#0000ff"` |
   | Gravar preenchido (área) | `fill="#000000" stroke="none"` |

   `stroke-width` não importa (use 0.2). Qualquer vermelho forte vira corte; outras cores com contorno viram gravar linha; só preenchimento vira gravar preenchido.
4. Elementos aceitos: `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon` (com `transform` e grupos `g`).
   **Ignorados:** `<text>`, `<image>`, `<use>`, `<foreignObject>`, filtros, gradientes. Texto precisa virar caminho (abaixo).
5. Corte precisa de caminho **fechado** (`Z` no fim do `path`). Não repita linhas em cima umas das outras (o laser passaria duas vezes).

## Boas práticas de desenho para laser

- Furos e detalhes internos: desenhe normalmente; o app corta furos antes do contorno.
- Menor detalhe cortável em MDF 3 mm: ~1,5 mm (pontes e letras finas abaixo disso quebram).
- Letras para **cortar**: use fontes grossas (fredoka, baloo2, luckiest, chewy). Miolos de A, O, R caem; para não cair, use `stencil`.
- Letras para **gravar**: qualquer fonte; acima de ~5 mm de altura fica legível.
- Peça maior que a mesa: divida em partes (ex.: uma palavra por peça) e avise a pessoa.
- Encaixes: folga = espessura do material + 0,1 mm (o kerf o app compensa).
- Painéis escolares prontos (frase com contorno, bandeirolas, lápis) já existem no app: botão **Painel**. Sugira quando servir.

## Texto em caminhos

Dentro do repositório do LaserLink (Claude Code), com as mesmas fontes do app:

```bash
npm ci && npm run build -w packages/gcode   # uma vez por sessão
node scripts/texto-svg.mjs "Sala 3" --fonte fredoka --altura 25 --x 10 --y 60 --modo cortar
#   imprime um <path …> para colar no SVG (--y é a linha de base; --altura = altura das maiúsculas)
node scripts/texto-svg.mjs "Sala 3" --fonte pacifico --altura 25 --modo cortar --svg > nome.svg
#   SVG completo só com o texto
```

Fontes: `fredoka` (arredondada), `baloo2` (gordinha), `luckiest` (cartaz, só maiúsculas), `chewy` (divertida), `pacifico` e `lobster` (cursivas), `patrick` (à mão), `comic` (escolar), `bebas` (alta, só maiúsculas), `roboto` (simples), `stencil` (estêncil). Também aceita o caminho de um `.ttf/.otf/.woff`. Letras cursivas que se encostam saem unidas num contorno só.

Fora do repositório (sem os scripts): se houver Python com `fontTools`, converta o texto em caminhos com ele; se não der, entregue o SVG sem o texto e diga para a pessoa adicionar o texto no app (ferramenta **Texto**, que tem as mesmas fontes).

## Conferir antes de entregar

No repositório:

```bash
node scripts/conferir-svg.mjs peca.svg --area 400x400
```

Mostra o tamanho, quantos elementos vão para cada operação e os erros (ex.: `<text>` esquecido, tamanho maior que a mesa). Só entregue quando disser "Pronto para o LaserLink".

Sem os scripts, confira à mão: width/height em mm, viewBox igual, cores da tabela, nada de `<text>`, cabe na área.

## Entregar

**No repositório do LaserLink (Claude Code):** publique no ramo `projetos`. Não mexe no ramo atual:

```bash
node scripts/publicar-projeto.mjs peca.svg --descricao "Placa da porta da sala 3, MDF 3 mm" [--nome placa-sala-3.svg]
node scripts/publicar-projeto.mjs --listar          # o que já está publicado
node scripts/publicar-projeto.mjs --remover placa-sala-3.svg
```

A descrição aparece no app. Escreva o que é e o material sugerido. Depois diga à pessoa:
"No LaserLink: **Arquivo > Projetos recebidos > Buscar novos** e clique em **Abrir**."

**Em outro lugar (chat, celular):** entregue o arquivo `.svg` para baixar e diga: "No LaserLink: **Arquivo > Importar SVG, DXF ou imagem…**".

Sempre termine dizendo o tamanho final, as operações (o que corta, o que grava) e que é preciso conferir com **Simular** e **Enquadrar** antes de cortar.

## Exemplo mínimo

Plaquinha 120 × 60 mm, cantos arredondados, 2 furos para pendurar, borda gravada:

```xml
<svg xmlns="http://www.w3.org/2000/svg" width="120mm" height="60mm" viewBox="0 0 120 60">
  <rect x="0.5" y="0.5" width="119" height="59" rx="6" fill="none" stroke="#ff0000" stroke-width="0.2"/>
  <circle cx="10" cy="10" r="2.5" fill="none" stroke="#ff0000" stroke-width="0.2"/>
  <circle cx="110" cy="10" r="2.5" fill="none" stroke="#ff0000" stroke-width="0.2"/>
  <rect x="5" y="5" width="110" height="50" rx="4" fill="none" stroke="#0000ff" stroke-width="0.2"/>
</svg>
```
