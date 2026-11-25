/**
 * Sons de aviso gerados na hora com Web Audio (sem arquivos de áudio).
 * Navegadores só liberam o som depois de um toque ou clique na página,
 * então o contexto é criado no primeiro gesto.
 */
let ctx: AudioContext | null = null;

function unlock(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
  } catch {
    /* sem Web Audio */
  }
}
for (const ev of ["pointerdown", "keydown"] as const) window.addEventListener(ev, unlock, { capture: true });

/** `ok`: três notas subindo. `bad`: duas notas graves repetidas, para chamar atenção. */
export function chime(kind: "ok" | "bad"): void {
  if (!ctx || ctx.state !== "running") return;
  const notes: Array<[freq: number, at: number, dur: number]> =
    kind === "ok"
      ? [
          [660, 0, 0.18],
          [880, 0.2, 0.18],
          [1320, 0.4, 0.35],
        ]
      : [
          [440, 0, 0.25],
          [330, 0.3, 0.35],
          [440, 0.8, 0.25],
          [330, 1.1, 0.35],
        ];
  const t0 = ctx.currentTime + 0.02;
  for (const [freq, at, dur] of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = kind === "ok" ? "sine" : "triangle";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t0 + at);
    gain.gain.exponentialRampToValueAtTime(0.3, t0 + at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0 + at);
    osc.stop(t0 + at + dur + 0.05);
  }
}
