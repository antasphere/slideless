/**
 * Marks a `position: sticky` element with `data-stuck` while it is held at its
 * offset, so it can change its dress once it is a bar (square corners, an
 * opaque ground, a line under it) and go back to being part of its card when
 * released. CSS has no selector for this; the scroll container says it.
 */
export function stuck(node: HTMLElement) {
  const root = node.closest<HTMLElement>('.app-main, [data-scroll-root]');
  if (!root) return {};

  let frame = 0;
  const read = () => {
    frame = 0;
    // `top` is measured from the container's content edge, under its padding
    const top =
      (parseFloat(getComputedStyle(node).top) || 0) + (parseFloat(getComputedStyle(root).paddingTop) || 0);
    const held =
      root.scrollTop > 0 && node.getBoundingClientRect().top - root.getBoundingClientRect().top <= top + 0.5;
    node.toggleAttribute('data-stuck', held);
  };
  const onScroll = () => {
    if (!frame) frame = requestAnimationFrame(read);
  };

  root.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  read();

  return {
    destroy() {
      root.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    }
  };
}
