---
name: laserlink-svg
description: Gera arquivos SVG prontos para a laser GRBL da Sapienza (app Sapienza LaserLink) e, quando possível, publica o arquivo para aparecer no app em Arquivo > Projetos recebidos. Use sempre que pedirem para desenhar, criar, gerar ou mandar uma peça, placa, painel, letreiro, chaveiro, caixa, plaquinha, bandeirola, molde ou qualquer desenho "para a laser", "para cortar", "para gravar" ou "para o LaserLink" ou "para o Sapienza LaserLink", mesmo que a pessoa não diga "SVG". Também use quando colarem um código de pedido de carimbo começando com SAP1: (kit de carimbos Stilo personalizados com caixa de MDF).
---

# SVG para a laser do Sapienza LaserLink

O LaserLink importa SVG e decide a operação pela cor. Esta skill garante que o arquivo abra com o tamanho certo, a operação certa e no lugar certo, e explica como entregá-lo.

## Regras de segurança (nunca quebrar)

- Você só **entrega o desenho**. Nunca inicie trabalho, nunca ligue o laser, nunca mexa no agente.
- O arquivo chega como desenho na mesa do app; a pessoa revisa, escolhe o material e manda cortar com confirmação.
- Não exponha portas nem tokens. A entrega é por arquivo ou pelo ramo `projetos` do GitHub.

## A máquina

- Área útil: **300 mm em X (largura) × 400 mm em Y (profundidade)**. Nada pode passar disso.
  Se a pessoa disser que mudou, confira no app: janela Máquina, abra Conexão, "Limites do agente".
- Origem (0,0) no canto de **baixo à esquerda** da mesa.
- Material mais comum: MDF 3 mm. Kerf (largura do corte) ~0,15 mm: o app compensa sozinho; desenhe na medida final.

## Formato do SVG

1. Unidade em mm, 1 unidade = 1 mm:
   `<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="100mm" viewBox="0 0 200 100">`
2. **Posição**:
   - Padrão: o app coloca o desenho a 20 mm da origem (a posição no arquivo não importa).
   - Para valer a posição exata na mesa, faça o SVG do tamanho da mesa e marque `data-laserlink="mesa"`:
     `<svg … width="300mm" height="400mm" viewBox="0 0 300 400" data-laserlink="mesa">`
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

## Preparar o repositório (Claude Code)

Repositório: `szadil763/laser-link`. Os scripts (`scripts/publicar-projeto.mjs`, `conferir-svg.mjs`, `texto-svg.mjs`) estão no ramo **`fase-3`**. O `main` pode ainda não ter. Se `scripts/publicar-projeto.mjs` não existir na pasta aberta, use uma cópia do `fase-3` ao lado, sem mexer no ramo atual:

```bash
test -f scripts/publicar-projeto.mjs || { git fetch origin fase-3 && git worktree add ../laserlink-fase3 origin/fase-3 && cd ../laserlink-fase3; }
npm ci && npm run build -w packages/gcode   # uma vez por sessão (texto-svg precisa)
```

**Atenção: a pasta `projetos/` NÃO existe nos ramos de trabalho (main, fase-3) e não deve ser criada neles.** Ela vive só no ramo `projetos` do GitHub, e o `publicar-projeto.mjs` cria ou atualiza esse ramo sozinho, mesmo que ele ainda não exista. Não procure a pasta; só rode o script.

## Texto em caminhos

Dentro do repositório do LaserLink (Claude Code), com as mesmas fontes do app:

```bash
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
node scripts/conferir-svg.mjs peca.svg --area 300x400
```

Mostra o tamanho, quantos elementos vão para cada operação e os erros (ex.: `<text>` esquecido, tamanho maior que a mesa). Só entregue quando disser "Pronto para o LaserLink".

Sem os scripts, confira à mão: width/height em mm, viewBox igual, cores da tabela, nada de `<text>`, cabe na área.

## Entregar

**No repositório do LaserLink (Claude Code):** publique no ramo `projetos` (veja "Preparar o repositório"). Não mexe no ramo atual nem precisa da pasta `projetos/`:

```bash
node scripts/publicar-projeto.mjs peca.svg --descricao "Placa da porta da sala 3, MDF 3 mm" [--nome placa-sala-3.svg]
node scripts/publicar-projeto.mjs --listar          # o que já está publicado
node scripts/publicar-projeto.mjs --remover placa-sala-3.svg
```

A descrição aparece no app. Escreva o que é e o material sugerido. Depois diga à pessoa:
"No LaserLink: **Arquivo > Projetos recebidos > Buscar novos** e clique em **Abrir**."

Se o `git push` for recusado (sem permissão de escrita no repositório), não insista: entregue o arquivo como abaixo.

**Em outro lugar (chat do claude.ai, celular) ou sem acesso de escrita ao GitHub:** entregue o arquivo `.svg` para baixar e diga: "No LaserLink: **Arquivo > Importar SVG, DXF ou imagem…**". Não diga que falta a pasta de projetos: nesse caso a entrega é só o arquivo.

Sempre termine dizendo o tamanho final, as operações (o que corta, o que grava) e que é preciso conferir com **Simular** e **Enquadrar** antes de cortar.

## Carimbos personalizados Stilo (código SAP1:)

**REGRA Nº 1: pedido de cliente é seguido EXATAMENTE como veio no código.** Mesmas linhas de texto (até 3 por carimbo), letra, ícone, lado, moldura, quantidade, modelo de caixa e nome na caixa. Se algo **não puder ser cumprido** (estojo para quantidade diferente de 2, 4 ou 6, ícone ou letra inexistente, caractere que a fonte não tem, letra pequena demais, texto que não cabe, ambiguidade), **PARE e consulte o Adilson ANTES de gerar ou publicar**: diga o que não dá e as opções. Nunca troque em silêncio por algo parecido. São pedidos de clientes reais.

**Medida do carimbo: 35 × 16 mm** (largura × altura). O **contorno vermelho de corte também é 35 × 16 mm**, sem margem extra (39 × 20 ficava justo demais na máquina de carimbo). Confira no arquivo antes de entregar (`<rect>` vermelho 35 × 16) e diga na entrega.

**REGRA Nº 3: carimbo vai com o material "borracha carimbo".** O `carimbos-N.svg` sai com `data-laserlink-material="borracha carimbo"` no `<svg>`: o LaserLink usa esse material cadastrado em **Materiais** (cortar, gravar preenchido etc. com velocidade, potência e passes dele) em vez do primeiro da lista. Se o material não existir, o app avisa. Nunca publique carimbo sem esse atributo; as caixas de MDF não levam. Qualquer arquivo pode pedir um material pelo nome com esse atributo.

**REGRA Nº 2: carimbo SEMPRE vai em NEGATIVO e ESPELHADO.** O laser queima o fundo e deixa só a arte em relevo, e a arte sai espelhada (lida ao contrário), para imprimir certo. Preto (gravar preenchido) = fundo espelhado, nunca a arte. Antes de publicar, renderize o arquivo e confirme: **fundo preto, letras e ícone vazados e espelhados**. Se a arte aparecer preta (positivo) ou em leitura normal, o arquivo está errado: não publique. Use sempre `gerar_pedido.py` (folha `carimbos-N.svg`); se rodar `carimbo_svg.py` sozinho, o padrão é `--modo fundo` (negativo espelhado), nunca use `--modo arte` para produção. Diga na entrega: "negativo e espelhado conferido".

Quando a pessoa colar um código `SAP1:...` (gerado pelo editor do folder Sapienza), gere os arquivos de corte da **caixa** e dos **carimbos**. O código é base64 de JSON: `{k: 2|4|6, s: [[linha1, linha2, fonte, ícone, lado, moldura, linha3], ...], c: nome na caixa, b: "aberta"|"estojo", u: cidade}` (a linha 3 é opcional e pode faltar nos códigos antigos). Os scripts ficam na pasta do projeto `caixa-carimbos-mdf` (fora do repositório do LaserLink); se não estiver na sessão, peça a pasta ou o repositório.

```bash
cd caixa-carimbos-mdf
python3 gerar_pedido.py "SAP1:..." --saida /tmp/pedido [--titulo "Nome do cliente"] [--margem 2.0]
```

`gerar_pedido.py` **para sozinho (código de saída 3)** e lista o que não dá para cumprir. Só use `--aceitar-desvios` depois de o Adilson autorizar cada desvio, e escreva o desvio autorizado na descrição publicada.

Saídas:
- `caixa-carimbos-N.svg` (pedido `b:"aberta"`) ou `estojo-carimbos-N-folha-1-de-2.svg` + `folha-2-de-2` (pedido `b:"estojo"`, caixa FECHADA com tampa deslizante): MDF 3 mm para N carimbos, com o ícone e as frases do pedido gravados na frente e o título atrás. Mesa 300×400, `data-laserlink="mesa"`.
- `carimbos-N.svg`: folha dos carimbos 35 × 16 mm **negativados e espelhados**. O laser queima o material em volta e deixa só a arte. Preto (gravar preenchido) = fundo espelhado dentro da peça de 35 × 16 mm; vermelho (cortar) = contorno de 35 × 16 mm de cada carimbo.
- `prova-N.png`: prova em leitura normal para o cliente confirmar. Envie ao usuário.

Os arquivos já saem com **um caminho fechado por contorno** (`vetores.py`): o LaserLink lê cada `<path>` como uma linha só, então subcaminhos grudados criam traços falsos e perdem o fechamento.

Fluxo:
1. Decodifique o código e liste o pedido (linhas, letra, ícone, lado, moldura, caixa). Rode `gerar_pedido.py`. Se ele parar, consulte o Adilson.
2. Renderize os SVG em PNG (cairosvg) e **olhe**: carimbos em **negativo espelhado** (fundo preto, letras e ícone vazados e ao contrário); ícone e frases certos.
3. **Confira o resultado contra o código decodificado** e diga isso na entrega.
4. Confira cada arquivo com `node scripts/conferir-svg.mjs arquivo.svg --area 300x400` ("Pronto para o LaserLink").
5. Publique os dois com `publicar-projeto.mjs` e mande as provas.
6. Diga só as suposições que o pedido não define (título quando não há nome, margem de 2 mm, contorno vermelho).

Ícones são originais da Sapienza: nunca copie personagens de terceiros.

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
