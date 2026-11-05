// Small UI helpers shared by the editor and the merge/split tools. They look
// their elements up at call time, so main.ts only has to render the markup.

import { isNative, saveNative } from "./native";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

export function showBusy(text: string | null): void {
  $("#busy").hidden = text === null;
  if (text !== null) $("#busy-text").textContent = text;
}

export function toast(message: string, detail?: string, action?: { label: string; run: () => void }): void {
  const box = $("#toasts");
  box.replaceChildren(); // one message at a time
  const el = document.createElement("div");
  el.className = "toast";
  const body = document.createElement("div");
  const title = document.createElement("p");
  // In the iOS app nothing is "downloaded": the file lands in Files.
  title.textContent = isNative ? message.replace(/^Downloaded /, "Saved ") : message;
  body.append(title);
  if (detail) {
    const small = document.createElement("p");
    small.className = "toast-detail";
    small.textContent = detail;
    body.append(small);
  }
  el.append(body);
  if (action) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = action.label;
    b.addEventListener("click", () => {
      action.run();
      el.remove();
    });
    el.append(b);
  }
  box.append(el);
  window.setTimeout(() => el.remove(), action ? 7000 : 5000);
}

/** Hand a file to the browser's download flow (or, in the iOS app, Files and the share sheet). */
export function saveFile(blob: Blob, name: string): void {
  if (isNative) {
    saveNative(blob, name).catch(() =>
      toast(`${name} couldn't be saved.`, "Your device may be out of space. Free some up and try again."),
    );
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function isPdf(file: File): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name);
}

/** "Report.PDF" -> "Report". Never empty. */
export function baseName(name: string): string {
  return name.replace(/\.pdf$/i, "").trim() || "document";
}

/** Ask for a PDF's password. Resolves with null if they cancel. */
export function askPassword(wrong: boolean, fileName?: string): Promise<string | null> {
  const dialog = $<HTMLDialogElement>("#pw-dialog");
  const input = $<HTMLInputElement>("#pw-input");
  const okBtn = $("#pw-ok");
  const cancelBtn = $("#pw-cancel");
  showBusy(null);
  const which = fileName ? `the password for ${fileName}` : "it to open the file";
  $("#pw-msg").textContent = wrong
    ? "That password didn't work. Try again."
    : `Enter ${which}. It stays on this device.`;
  input.value = "";
  dialog.showModal();
  input.focus();
  return new Promise((resolve) => {
    const done = (value: string | null) => {
      dialog.close();
      cleanup();
      if (value !== null) showBusy("Opening");
      resolve(value);
    };
    const ok = () => done(input.value);
    const cancel = () => done(null);
    const key = (e: KeyboardEvent) => {
      if (e.key === "Enter") ok();
    };
    const esc = (e: Event) => {
      e.preventDefault();
      cancel();
    };
    const cleanup = () => {
      okBtn.removeEventListener("click", ok);
      cancelBtn.removeEventListener("click", cancel);
      input.removeEventListener("keydown", key);
      dialog.removeEventListener("cancel", esc);
    };
    okBtn.addEventListener("click", ok);
    cancelBtn.addEventListener("click", cancel);
    input.addEventListener("keydown", key);
    dialog.addEventListener("cancel", esc);
  });
}
