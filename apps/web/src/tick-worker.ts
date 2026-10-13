// Timer em um Worker: abas em segundo plano limitam setInterval da página
// (no Chrome, até uma vez por minuto), o que derrubaria o heartbeat.
const ctx = self as unknown as { postMessage(msg: number): void; onmessage: ((e: MessageEvent<number>) => void) | null };

let timer: ReturnType<typeof setInterval> | undefined;

ctx.onmessage = (e) => {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
  if (e.data > 0) timer = setInterval(() => ctx.postMessage(Date.now()), e.data);
};
