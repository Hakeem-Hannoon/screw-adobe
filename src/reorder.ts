/**
 * Make a list row draggable by its grip, and movable with the up and down
 * arrow keys while the grip has focus. `onReorder` runs after every move.
 *
 * During a pointer drag, neighbors swap around the row as the pointer passes
 * their midpoints. The neighbors are what move in the DOM, never the dragged
 * row, because detaching it would drop its pointer capture.
 */
export function makeSortable(li: HTMLElement, grip: HTMLElement, scroller: HTMLElement, onReorder: () => void): void {
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    li.classList.add("lifted");
    const mid = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.top + r.height / 2;
    };
    const move = (ev: PointerEvent) => {
      let prev = li.previousElementSibling;
      while (prev && ev.clientY < mid(prev)) {
        li.after(prev);
        prev = li.previousElementSibling;
      }
      let next = li.nextElementSibling;
      while (next && ev.clientY > mid(next)) {
        li.before(next);
        next = li.nextElementSibling;
      }
      // Scroll when dragging near the top or bottom edge.
      const box = scroller.getBoundingClientRect();
      if (ev.clientY < box.top + 48) scroller.scrollBy(0, -12);
      else if (ev.clientY > box.bottom - 48) scroller.scrollBy(0, 12);
    };
    const up = () => {
      li.classList.remove("lifted");
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      grip.removeEventListener("lostpointercapture", up);
      onReorder();
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
    grip.addEventListener("lostpointercapture", up);
  });

  grip.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const sib = e.key === "ArrowUp" ? li.previousElementSibling : li.nextElementSibling;
    if (!sib) return;
    // Move the neighbor, not this row, so focus stays put.
    if (e.key === "ArrowUp") li.after(sib);
    else li.before(sib);
    onReorder();
  });
}
