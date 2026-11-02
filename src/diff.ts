// Diffing for the Compare tool: matching pages up, word diffs, and finding
// the regions where two renders of a page differ.

/** A matched pair of pages. Either side is null when a page was added or removed. */
export interface PagePair {
  a: number | null;
  b: number | null;
}

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** How alike two pages' texts are, 0-1. Two pages with no text count as alike. */
export function similarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (!wa.length && !wb.length) return 1;
  if (!wa.length || !wb.length) return 0;
  const count = new Map<string, number>();
  for (const w of wa) count.set(w, (count.get(w) ?? 0) + 1);
  let shared = 0;
  for (const w of wb) {
    const n = count.get(w) ?? 0;
    if (n > 0) {
      shared += 1;
      count.set(w, n - 1);
    }
  }
  return (2 * shared) / (wa.length + wb.length);
}

/**
 * Line two versions' pages up, so an inserted or removed page shows as such
 * instead of making every later page look different. Pages are matched by
 * how alike their text is (a global alignment, like aligning two DNA
 * strands); pages too different to be the same page don't pair up.
 */
export function alignPages(a: string[], b: string[]): PagePair[] {
  // Aligned back to front, so when it's a toss-up (say, scanned pages with no
  // text), extra pages are reported at the end rather than the start.
  const ra = [...a].reverse();
  const rb = [...b].reverse();
  return align(ra, rb)
    .map((p) => ({ a: p.a === null ? null : a.length - 1 - p.a, b: p.b === null ? null : b.length - 1 - p.b }))
    .reverse();
}

function align(a: string[], b: string[]): PagePair[] {
  const n = a.length;
  const m = b.length;
  // Very long documents: fall back to page-by-page, which is linear.
  if (n * m > 400_000) {
    return Array.from({ length: Math.max(n, m) }, (_, i) => ({ a: i < n ? i : null, b: i < m ? i : null }));
  }
  const GAP = -0.4;
  const score = (i: number, j: number) => {
    const s = similarity(a[i], b[j]);
    return s >= 0.35 ? s : -1;
  };
  const S: Float64Array[] = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = 1; i <= n; i++) S[i][0] = i * GAP;
  for (let j = 1; j <= m; j++) S[0][j] = j * GAP;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      S[i][j] = Math.max(S[i - 1][j - 1] + score(i - 1, j - 1), S[i - 1][j] + GAP, S[i][j - 1] + GAP);
    }
  }
  const out: PagePair[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && S[i][j] === S[i - 1][j - 1] + score(i - 1, j - 1)) {
      out.push({ a: i - 1, b: j - 1 });
      i--;
      j--;
    } else if (i > 0 && S[i][j] === S[i - 1][j] + GAP) {
      out.push({ a: i - 1, b: null });
      i--;
    } else {
      out.push({ a: null, b: j - 1 });
      j--;
    }
  }
  return out.reverse();
}

export type Op = { kind: "same" | "del" | "ins"; text: string };

/** Split text into words and the whitespace between them, so a diff keeps the spacing. */
const tokens = (s: string) => s.match(/\s+|[^\s]+/g) ?? [];

/**
 * Word-level diff (Myers' algorithm, as in `git diff`). Returns runs of
 * unchanged, deleted and inserted text. If the texts are too different to
 * diff quickly, it reports the whole thing as replaced.
 */
export function diffWords(before: string, after: string): Op[] {
  const A = tokens(before);
  const B = tokens(after);
  // Compare words loosely on whitespace: a reflowed line isn't a change.
  const eq = (x: string, y: string) => x === y || (!x.trim() && !y.trim());
  const N = A.length;
  const M = B.length;
  const MAX = Math.min(N + M, 1500);
  const off = MAX + 1;
  let v: Int32Array = new Int32Array(2 * MAX + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= MAX && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && eq(A[x], B[y])) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= N && y >= M) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) {
    return merge([
      { kind: "del", text: before },
      { kind: "ins", text: after },
    ]);
  }
  // Walk the trace back to recover the edit script.
  const ops: Op[] = [];
  let x = N;
  let y = M;
  for (let d = found; d > 0; d--) {
    v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? k + 1 : k - 1;
    const prevX = v[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: "same", text: B[--y] });
      x--;
    }
    if (x === prevX) ops.push({ kind: "ins", text: B[--y] });
    else ops.push({ kind: "del", text: A[--x] });
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: "same", text: B[--y] });
    x--;
  }
  return merge(ops.reverse());
}

/** Join neighboring runs of the same kind; whitespace between two changes joins the change. */
function merge(ops: Op[]): Op[] {
  const out: Op[] = [];
  for (const op of ops) {
    if (!op.text) continue;
    const last = out[out.length - 1];
    if (last && last.kind === op.kind) last.text += op.text;
    else out.push({ ...op });
  }
  return out;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Regions where two same-sized renders differ, as boxes in pixels. Pixels are
 * grouped into cells, cells that touch are merged, and boxes are padded a
 * little so the highlight sits around the change rather than on it.
 */
export function changedRegions(a: ImageData, b: ImageData, cell = 8): Box[] {
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const cw = Math.ceil(w / cell);
  const ch = Math.ceil(h / cell);
  const hits = new Uint16Array(cw * ch);
  const pa = a.data;
  const pb = b.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ia = (y * a.width + x) * 4;
      const ib = (y * b.width + x) * 4;
      const d = Math.max(
        Math.abs(pa[ia] - pb[ib]),
        Math.abs(pa[ia + 1] - pb[ib + 1]),
        Math.abs(pa[ia + 2] - pb[ib + 2]),
      );
      if (d > 48) hits[((y / cell) | 0) * cw + ((x / cell) | 0)]++;
    }
  }
  const marked = new Uint8Array(cw * ch);
  for (let i = 0; i < hits.length; i++) marked[i] = hits[i] >= 2 ? 1 : 0;

  // Join touching cells (and ones a cell apart) into boxes.
  const seen = new Uint8Array(cw * ch);
  const boxes: Box[] = [];
  for (let start = 0; start < marked.length; start++) {
    if (!marked[start] || seen[start]) continue;
    let x0 = cw;
    let y0 = ch;
    let x1 = 0;
    let y1 = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      const cx = c % cw;
      const cy = (c / cw) | 0;
      x0 = Math.min(x0, cx);
      y0 = Math.min(y0, cy);
      x1 = Math.max(x1, cx);
      y1 = Math.max(y1, cy);
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
          const nc = ny * cw + nx;
          if (marked[nc] && !seen[nc]) {
            seen[nc] = 1;
            stack.push(nc);
          }
        }
      }
    }
    const pad = cell / 2;
    boxes.push({
      x: Math.max(0, x0 * cell - pad),
      y: Math.max(0, y0 * cell - pad),
      w: Math.min(w, (x1 + 1) * cell + pad) - Math.max(0, x0 * cell - pad),
      h: Math.min(h, (y1 + 1) * cell + pad) - Math.max(0, y0 * cell - pad),
    });
  }
  return boxes;
}
