import { icons } from "./icons";

export interface RowAction {
  icon: string;
  label: string;
  run: () => void;
}

export interface Row {
  li: HTMLLIElement;
  thumb: HTMLElement;
  setMeta(text: string, error?: boolean): void;
  setSelected(on: boolean): void;
  /** Extra controls at the end of the row, before Remove. */
  slot: HTMLElement;
}

/**
 * A file in a batch: thumbnail, name, a status line, and buttons. Clicking
 * the row (not a button) selects it.
 */
export function fileRow(opts: {
  name: string;
  meta: string;
  actions?: RowAction[];
  onSelect?: () => void;
  onRemove: () => void;
}): Row {
  const li = document.createElement("li");
  li.className = "file-row batch-row";
  if (opts.onSelect) {
    li.classList.add("selectable");
    li.addEventListener("click", (e) => {
      if (!(e.target as HTMLElement).closest("button")) opts.onSelect!();
    });
  }

  const thumb = document.createElement("div");
  thumb.className = "row-thumb";

  const info = document.createElement("div");
  info.className = "row-info";
  const name = document.createElement(opts.onSelect ? "button" : "span");
  name.className = "row-name";
  name.textContent = opts.name;
  name.title = opts.name;
  if (opts.onSelect) {
    (name as HTMLButtonElement).type = "button";
    name.classList.add("row-name-btn");
    name.addEventListener("click", () => opts.onSelect!());
  }
  const meta = document.createElement("span");
  meta.className = "row-meta";
  meta.textContent = opts.meta;
  info.append(name, meta);

  const slot = document.createElement("div");
  slot.className = "row-actions";
  for (const a of opts.actions ?? []) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "icon-btn";
    b.title = a.label;
    b.setAttribute("aria-label", `${a.label}: ${opts.name}`);
    b.innerHTML = a.icon;
    b.addEventListener("click", a.run);
    slot.append(b);
  }

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "icon-btn";
  remove.title = "Remove";
  remove.setAttribute("aria-label", `Remove ${opts.name}`);
  remove.innerHTML = icons.close;
  remove.addEventListener("click", opts.onRemove);

  li.append(thumb, info, slot, remove);
  return {
    li,
    thumb,
    slot,
    setMeta(text, error = false) {
      meta.textContent = text;
      meta.classList.toggle("error", error);
    },
    setSelected(on) {
      li.classList.toggle("selected", on);
      if (opts.onSelect) name.setAttribute("aria-pressed", String(on));
    },
  };
}

/** "Report.pdf" twice in a ZIP would clash: the second becomes "Report (2).pdf". */
export function uniqueNames(names: string[]): string[] {
  const reserved = new Set(names.map((name) => name.toLowerCase()));
  const seen = new Set<string>();
  return names.map((n) => {
    const key = n.toLowerCase();
    let candidate = n;
    if (seen.has(key)) {
      const dot = n.lastIndexOf(".");
      const stem = dot > 0 ? n.slice(0, dot) : n;
      const ext = dot > 0 ? n.slice(dot) : "";
      let count = 2;
      do candidate = `${stem} (${count++})${ext}`;
      while (seen.has(candidate.toLowerCase()) || reserved.has(candidate.toLowerCase()));
    }
    seen.add(candidate.toLowerCase());
    return candidate;
  });
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

