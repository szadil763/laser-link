/**
 * Confirmação dentro da página (no lugar de window.confirm, que alguns
 * navegadores e janelas embutidas bloqueiam). Resolve true só no botão de confirmar.
 */
export function confirmDialog(title: string, text: string, confirmLabel: string, danger = false): Promise<boolean> {
  const dialog = document.getElementById("confirm-dialog") as HTMLDialogElement;
  const ok = document.getElementById("confirm-ok") as HTMLButtonElement;
  (document.getElementById("confirm-title") as HTMLElement).textContent = title;
  (document.getElementById("confirm-text") as HTMLElement).textContent = text;
  ok.textContent = confirmLabel;
  ok.className = danger ? "danger" : "warn";
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true });
    dialog.returnValue = "";
    dialog.showModal();
    (document.getElementById("confirm-cancel") as HTMLButtonElement).focus();
  });
}
