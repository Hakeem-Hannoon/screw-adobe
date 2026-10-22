import type { RenderTask } from "pdfjs-dist";
import type { PdfSource } from "./source";

interface Item {
  el: HTMLElement;
  src: PdfSource;
  index: number;
  fit: number; // CSS pixels per page point
  visible: boolean;
  done: boolean;
  task: RenderTask | null;
}

/**
 * Small page previews. `sheet()` returns a correctly sized placeholder right
 * away; the page is drawn into it once it scrolls near the viewport, one at a
 * time, on-screen pages first.
 */
export class Thumbs {
  private io: IntersectionObserver;
  private items = new Map<HTMLElement, Item>();
  private queue: Item[] = [];
  private pumping = false;

  constructor(root: HTMLElement, private box: { w: number; h: number }) {
    this.io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const item = this.items.get(entry.target as HTMLElement);
          if (!item) continue;
          item.visible = entry.isIntersecting;
          if (item.visible && !item.done && !this.queue.includes(item)) this.queue.push(item);
        }
        void this.pump();
      },
      { root, rootMargin: "600px 0px" },
    );
  }

  sheet(src: PdfSource, index: number): HTMLElement {
    const size = src.sizes[index];
    const fit = Math.min(this.box.w / size.w, this.box.h / size.h);
    const el = document.createElement("div");
    el.className = "thumb-sheet";
    el.style.width = `${Math.max(1, Math.round(size.w * fit))}px`;
    el.style.height = `${Math.max(1, Math.round(size.h * fit))}px`;
    this.items.set(el, { el, src, index, fit, visible: false, done: false, task: null });
    this.io.observe(el);
    return el;
  }

  forget(el: HTMLElement): void {
    const item = this.items.get(el);
    if (!item) return;
    item.task?.cancel();
    this.io.unobserve(el);
    this.items.delete(el);
    this.queue = this.queue.filter((q) => q !== item);
  }

  clear(): void {
    for (const el of [...this.items.keys()]) this.forget(el);
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        this.queue.sort((a, b) => Number(b.visible) - Number(a.visible));
        const item = this.queue.shift()!;
        if (item.done || !this.items.has(item.el)) continue;
        await this.draw(item);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async draw(item: Item): Promise<void> {
    try {
      const page = await item.src.doc.getPage(item.index + 1);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const viewport = page.getViewport({ scale: item.fit * dpr });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      item.task = page.render({ canvas, viewport });
      await item.task.promise;
      if (!this.items.has(item.el)) return;
      item.el.replaceChildren(canvas);
      item.done = true;
    } catch {
      // Cancelled, or the file was closed mid-render. Nothing to show.
    } finally {
      item.task = null;
    }
  }
}
