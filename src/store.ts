import type { DocState, Shape } from "./types";

type Listener = () => void;

const clone = (s: DocState): DocState => ({
  shapes: s.shapes.map((sh) => ({ ...sh })),
  deleted: [...s.deleted],
});

const same = (a: DocState, b: DocState) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Document edits with snapshot-based undo/redo. Live interactions (dragging,
 * typing) mutate `state` directly and call `notify()`, then record a single
 * history entry with `record(before)` when they finish.
 */
export class Store {
  state: DocState = { shapes: [], deleted: [] };
  private past: DocState[] = [];
  private future: DocState[] = [];
  private listeners = new Set<Listener>();
  /** Bumped on every change; used to know whether the latest edits were downloaded. */
  revision = 0;

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify(): void {
    this.revision += 1;
    for (const fn of this.listeners) fn();
  }

  snapshot(): DocState {
    return clone(this.state);
  }

  /** Apply a change as one undoable step. */
  commit(mutate: (s: DocState) => void): void {
    const before = this.snapshot();
    mutate(this.state);
    if (same(before, this.state)) return;
    this.past.push(before);
    this.future = [];
    this.notify();
  }

  /** Record a finished live interaction as one undoable step. */
  record(before: DocState): void {
    if (same(before, this.state)) return;
    this.past.push(before);
    this.future = [];
    this.notify();
  }

  /** Roll back to `before` without leaving any history (e.g. an empty text box). */
  revert(before: DocState): void {
    this.state = clone(before);
    this.notify();
  }

  /** Drop the most recent history entry and restore it, leaving no redo. */
  rollbackLast(): void {
    const prev = this.past.pop();
    if (!prev) return;
    this.state = prev;
    this.notify();
  }

  undo(): void {
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(this.snapshot());
    this.state = prev;
    this.notify();
  }

  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.snapshot());
    this.state = next;
    this.notify();
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  reset(): void {
    this.state = { shapes: [], deleted: [] };
    this.past = [];
    this.future = [];
    this.notify();
  }

  get hasEdits(): boolean {
    return this.state.shapes.length > 0 || this.state.deleted.length > 0;
  }

  find(id: string | null): Shape | undefined {
    if (!id) return undefined;
    return this.state.shapes.find((s) => s.id === id);
  }
}
