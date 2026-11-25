/** Cores da mesa (canvas). A interface continua escura; só a mesa troca entre clara e escura. */
export type BedTheme = "dark" | "light";

export interface BedColors {
  outside: string;
  bed: string;
  gridMinor: string;
  gridMajor: string;
  border: string;
  label: string;
  travel: string;
  /** Linhas já gravadas (simulação e trabalho na máquina). */
  burned: string;
  /** Trecho sendo gravado agora. */
  burning: string;
  /** Contorno de destaque do que está selecionado. */
  selection: string;
  /** Trajetória ainda a gravar (trabalho na máquina). */
  todo: string;
}

const PALETTES: Record<BedTheme, BedColors> = {
  dark: {
    outside: "#101216",
    bed: "#14171c",
    gridMinor: "#1f2329",
    gridMajor: "#2c323a",
    border: "#3c4043",
    label: "#9aa0a6",
    travel: "rgba(140,150,165,.4)",
    burned: "#f1e3c8",
    burning: "#fff4d6",
    selection: "#ffffff",
    todo: "#ff7a59",
  },
  light: {
    outside: "#cfd3d9",
    bed: "#ffffff",
    gridMinor: "#eceef1",
    gridMajor: "#d0d4da",
    border: "#7d838c",
    label: "#4b5058",
    travel: "rgba(80,90,105,.45)",
    burned: "#7a4a24",
    burning: "#b5651d",
    selection: "#14171c",
    todo: "#d9480f",
  },
};

let current: BedTheme = "dark";
try {
  if (localStorage.getItem("laserlink.bed") === "light") current = "light";
} catch {
  /* armazenamento indisponível */
}
document.documentElement.dataset.bed = current;

export function bedTheme(): BedTheme {
  return current;
}

export function bedColors(): BedColors {
  return PALETTES[current];
}

/** Troca a mesa e avisa as vistas (evento "bedtheme" na janela) para redesenharem. */
export function setBedTheme(theme: BedTheme): void {
  current = theme;
  document.documentElement.dataset.bed = theme;
  try {
    localStorage.setItem("laserlink.bed", theme);
  } catch {
    /* ignorar */
  }
  window.dispatchEvent(new Event("bedtheme"));
}
