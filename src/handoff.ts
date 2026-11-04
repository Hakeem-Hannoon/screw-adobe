import { icons } from "./icons";

/** Tools a finished PDF can be handed to without downloading it first. */
export type HandoffTarget = "editor" | "sign" | "numbers" | "merge" | "split" | "organize" | "rotate" | "compress";

const TARGETS: { target: HandoffTarget; label: string; icon: string }[] = [
  { target: "editor", label: "Redact", icon: icons.box },
  { target: "sign", label: "Sign", icon: icons.pen },
  { target: "numbers", label: "Page numbers", icon: icons.hash },
  { target: "merge", label: "Merge with other PDFs", icon: icons.merge },
  { target: "split", label: "Split", icon: icons.scissors },
  { target: "organize", label: "Organize pages", icon: icons.grid },
  { target: "rotate", label: "Rotate", icon: icons.rotate },
  { target: "compress", label: "Compress", icon: icons.compress },
];

/** Tools that take one PDF. Merge takes them all. */
const SINGLE = new Set<HandoffTarget>(["editor", "sign", "numbers", "split", "organize", "rotate", "compress"]);

let open: { close(): void } | null = null;
document.addEventListener("pointerdown", (e) => {
  if (open && !(e.target as HTMLElement).closest(".handoff")) open.close();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && open) open.close();
});

/**
 * A "Continue with" button and its menu of tools. `files()` is asked for the
 * PDFs only when a tool is picked, so it can build them then.
 */
export function handoffButton(opts: {
  label: string;
  /** How many PDFs there'll be: tools that take one PDF are left out when there are several. */
  count: () => number;
  pick: (target: HandoffTarget) => void;
  compact?: boolean;
}): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "handoff";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = opts.compact ? "icon-btn" : "btn";
  btn.setAttribute("aria-haspopup", "menu");
  btn.setAttribute("aria-expanded", "false");
  btn.title = opts.label;
  btn.innerHTML = opts.compact ? icons.arrow : `${icons.arrow}<span class="lbl">${opts.label}</span>`;
  if (opts.compact) btn.setAttribute("aria-label", opts.label);
  const menu = document.createElement("div");
  menu.className = "menu handoff-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  wrap.append(btn, menu);

  const close = () => {
    menu.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    if (open?.close === close) open = null;
  };
  btn.addEventListener("click", () => {
    if (!menu.hidden) return close();
    open?.close();
    const many = opts.count() > 1;
    menu.replaceChildren(
      Object.assign(document.createElement("p"), { className: "menu-head", textContent: "Keep working on it" }),
      ...TARGETS.filter((t) => !many || !SINGLE.has(t.target)).map((t) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "menu-item";
        item.setAttribute("role", "menuitem");
        item.innerHTML = `${t.icon}<span>${t.label}</span>`;
        item.addEventListener("click", () => {
          close();
          opts.pick(t.target);
        });
        return item;
      }),
    );
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    open = { close };
    menu.querySelector<HTMLElement>(".menu-item")?.focus();
  });
  return wrap;
}
