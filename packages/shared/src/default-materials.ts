import type { Material } from "./protocol.js";

/**
 * Exemplos para começar. Valores aproximados para laser de diodo de ~10 W:
 * ajuste com o teste de matriz na sua máquina.
 *
 * Os `id` ficam gravados no materials.json do agente: não renomeie. Material novo
 * aqui aparece sozinho para quem já tem a biblioteca salva (veja MaterialStore).
 *
 * Nunca incluir PVC/vinil, couro sintético, policarbonato, ABS ou fibra de vidro:
 * soltam gás tóxico ou corrosivo, ou pegam fogo (docs/MATERIAIS.md).
 */
export const DEFAULT_MATERIALS: Material[] = [
  {
    id: "mdf-3",
    name: "MDF 3 mm",
    thickness: 3,
    notes: "Exemplo editável. Confira com o teste de matriz antes de usar.",
    presets: [
      { mode: "cut", speed: 300, power: 85, passes: 2, kerf: 0.15 },
      { mode: "line", speed: 1500, power: 25, passes: 1 },
      { mode: "fill", speed: 3000, power: 35, passes: 1, interval: 0.2 },
      { mode: "detail", speed: 1800, power: 30, passes: 1, interval: 0.08 },
      { mode: "raster", speed: 3000, power: 40, passes: 1 },
    ],
  },
  {
    id: "mdf-6",
    name: "MDF 6 mm",
    thickness: 6,
    notes: "Exemplo editável. Confira com o teste de matriz antes de usar.",
    presets: [
      { mode: "cut", speed: 180, power: 100, passes: 4, kerf: 0.2 },
      { mode: "line", speed: 1400, power: 28, passes: 1 },
      { mode: "fill", speed: 2800, power: 38, passes: 1, interval: 0.2 },
      { mode: "detail", speed: 1700, power: 32, passes: 1, interval: 0.08 },
      { mode: "raster", speed: 2800, power: 42, passes: 1 },
    ],
  },
  {
    id: "compensado-3",
    name: "Compensado 3 mm",
    thickness: 3,
    notes: "Madeira natural: cola entre as lâminas pode exigir mais passes. Confira com o teste de matriz.",
    presets: [
      { mode: "cut", speed: 250, power: 90, passes: 3, kerf: 0.15 },
      { mode: "line", speed: 1500, power: 28, passes: 1 },
      { mode: "fill", speed: 3000, power: 38, passes: 1, interval: 0.2 },
      { mode: "detail", speed: 1800, power: 32, passes: 1, interval: 0.08 },
      { mode: "raster", speed: 3000, power: 40, passes: 1 },
    ],
  },
  {
    id: "balsa-2",
    name: "Balsa 2 mm",
    thickness: 2,
    notes: "Madeira macia: corta rápido. Bom para maquetes e aeromodelos.",
    presets: [
      { mode: "cut", speed: 600, power: 60, passes: 1, kerf: 0.15 },
      { mode: "line", speed: 2500, power: 15, passes: 1 },
      { mode: "fill", speed: 3500, power: 20, passes: 1, interval: 0.2 },
      { mode: "detail", speed: 2500, power: 18, passes: 1, interval: 0.08 },
      { mode: "raster", speed: 3500, power: 20, passes: 1 },
    ],
  },
  {
    id: "eva-2",
    name: "EVA 2 mm",
    thickness: 2,
    notes: "Espuma de EVA (sem cloro). Derrete fácil: use pouca potência e ventile bem. Teste numa sobra.",
    presets: [
      { mode: "cut", speed: 600, power: 55, passes: 1, kerf: 0.2 },
      { mode: "line", speed: 1500, power: 15, passes: 1 },
      { mode: "fill", speed: 3000, power: 20, passes: 1, interval: 0.2 },
      { mode: "detail", speed: 2000, power: 18, passes: 1, interval: 0.1 },
      { mode: "raster", speed: 3000, power: 20, passes: 1 },
    ],
  },
  {
    id: "cartao-03",
    name: "Papel cartão / cartolina (até 0,3 mm)",
    thickness: 0.3,
    notes: "Papel pega fogo rápido: corte com velocidade alta e fique olhando. Prenda bem para não voar.",
    presets: [
      { mode: "cut", speed: 1500, power: 35, passes: 1, kerf: 0.1 },
      { mode: "line", speed: 3000, power: 8, passes: 1 },
      { mode: "fill", speed: 4000, power: 12, passes: 1, interval: 0.2 },
      { mode: "detail", speed: 3000, power: 10, passes: 1, interval: 0.1 },
      { mode: "raster", speed: 4000, power: 12, passes: 1 },
    ],
  },
  {
    id: "lamicote",
    name: "Papel lamicote (cartão metalizado)",
    thickness: 0.4,
    notes: "A película metalizada reflete o laser e solta fumaça: corte com o papel virado (lado branco para cima) e ventile. Teste numa sobra.",
    presets: [
      { mode: "cut", speed: 1000, power: 50, passes: 1, kerf: 0.1 },
      { mode: "line", speed: 2500, power: 15, passes: 1 },
      { mode: "fill", speed: 3500, power: 20, passes: 1, interval: 0.2 },
      { mode: "detail", speed: 2500, power: 18, passes: 1, interval: 0.1 },
      { mode: "raster", speed: 3500, power: 20, passes: 1 },
    ],
  },
  {
    id: "parana-15",
    name: "Papel paraná 1,5 mm",
    thickness: 1.5,
    notes: "Papelão cinza rígido, bom para maquetes e moldes escolares. Pode chamuscar: fique olhando.",
    presets: [
      { mode: "cut", speed: 400, power: 80, passes: 2, kerf: 0.15 },
      { mode: "line", speed: 1500, power: 20, passes: 1 },
      { mode: "fill", speed: 3000, power: 30, passes: 1, interval: 0.2 },
      { mode: "detail", speed: 2000, power: 25, passes: 1, interval: 0.1 },
      { mode: "raster", speed: 3000, power: 35, passes: 1 },
    ],
  },
  {
    id: "papelao-3",
    name: "Papelão ondulado 3 mm",
    thickness: 3,
    notes: "Risco alto de chama nas ondas: nunca deixe sozinho, use assistência de ar e tenha um borrifador por perto.",
    presets: [
      { mode: "cut", speed: 500, power: 70, passes: 1, kerf: 0.2 },
      { mode: "line", speed: 2000, power: 15, passes: 1 },
      { mode: "fill", speed: 3500, power: 25, passes: 1, interval: 0.2 },
      { mode: "raster", speed: 3500, power: 25, passes: 1 },
    ],
  },
  {
    id: "acrilico-preto-3",
    name: "Acrílico preto 3 mm",
    thickness: 3,
    notes: "Laser de diodo NÃO corta acrílico transparente nem azul (a luz atravessa). Preto e cores escuras cortam com vários passes. Solta vapor irritante: ventile.",
    presets: [
      { mode: "cut", speed: 120, power: 100, passes: 6, kerf: 0.15 },
      { mode: "line", speed: 1000, power: 40, passes: 1 },
      { mode: "fill", speed: 2000, power: 50, passes: 1, interval: 0.15 },
      { mode: "detail", speed: 1500, power: 45, passes: 1, interval: 0.08 },
      { mode: "raster", speed: 2000, power: 50, passes: 1 },
    ],
  },
  {
    id: "couro-2",
    name: "Couro natural 2 mm",
    thickness: 2,
    notes: "Só couro natural (curtido ao vegetal). Couro sintético costuma ter PVC: não use. Cheiro forte: ventile.",
    presets: [
      { mode: "cut", speed: 300, power: 80, passes: 2, kerf: 0.2 },
      { mode: "line", speed: 2000, power: 20, passes: 1 },
      { mode: "fill", speed: 3000, power: 25, passes: 1, interval: 0.2 },
      { mode: "detail", speed: 2500, power: 22, passes: 1, interval: 0.1 },
      { mode: "raster", speed: 3000, power: 25, passes: 1 },
    ],
  },
  {
    id: "feltro-2",
    name: "Feltro 2 mm",
    thickness: 2,
    notes: "Feltro de lã ou poliéster. Borda derrete um pouco no poliéster.",
    presets: [
      { mode: "cut", speed: 800, power: 50, passes: 1, kerf: 0.2 },
      { mode: "line", speed: 2500, power: 12, passes: 1 },
      { mode: "fill", speed: 3500, power: 15, passes: 1, interval: 0.2 },
      { mode: "raster", speed: 3500, power: 15, passes: 1 },
    ],
  },
  {
    id: "cortica-3",
    name: "Cortiça 3 mm",
    thickness: 3,
    notes: "Grava muito bem. No corte, a borda escurece.",
    presets: [
      { mode: "cut", speed: 400, power: 70, passes: 2, kerf: 0.2 },
      { mode: "line", speed: 2000, power: 20, passes: 1 },
      { mode: "fill", speed: 3000, power: 25, passes: 1, interval: 0.2 },
      { mode: "detail", speed: 2500, power: 22, passes: 1, interval: 0.1 },
      { mode: "raster", speed: 3000, power: 25, passes: 1 },
    ],
  },
  {
    id: "tecido-algodao",
    name: "Tecido de algodão",
    thickness: 0.5,
    notes: "Estique e prenda o tecido. Sintéticos derretem; teste antes.",
    presets: [
      { mode: "cut", speed: 1500, power: 30, passes: 1, kerf: 0.1 },
      { mode: "line", speed: 3000, power: 10, passes: 1 },
      { mode: "fill", speed: 4000, power: 12, passes: 1, interval: 0.2 },
      { mode: "raster", speed: 4000, power: 12, passes: 1 },
    ],
  },
  {
    id: "ardosia",
    name: "Ardósia (só gravar)",
    thickness: 5,
    notes: "Só gravação: não corta. Grava em tom claro; limpe o pó depois.",
    presets: [
      { mode: "line", speed: 1500, power: 60, passes: 1 },
      { mode: "fill", speed: 2000, power: 70, passes: 1, interval: 0.1 },
      { mode: "detail", speed: 1500, power: 70, passes: 1, interval: 0.08 },
      { mode: "raster", speed: 2000, power: 70, passes: 1 },
    ],
  },
  {
    id: "aluminio-anodizado",
    name: "Alumínio anodizado (só gravar)",
    thickness: 1,
    notes: "Só gravação: tira a cor da camada anodizada. Não corta metal.",
    presets: [
      { mode: "line", speed: 1000, power: 80, passes: 1 },
      { mode: "fill", speed: 1500, power: 80, passes: 1, interval: 0.08 },
      { mode: "detail", speed: 1200, power: 80, passes: 1, interval: 0.06 },
      { mode: "raster", speed: 1500, power: 80, passes: 1 },
    ],
  },
];
