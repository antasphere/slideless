/**
 * Says when a page's own header (a hero band, a PageHeader: whatever carries
 * `data-page-head`, else the first heading) has left the top of the scroll
 * container, so the shell can show the path in its top bar, and take it away
 * when the header comes back. Pages come and go under one shell, and a header
 * may arrive after its page's data: the container is watched for the first
 * header it holds, whichever that is now. A page that marks no header at all
 * counts as past it once it has scrolled a header's height.
 */
export class HeadWatch {
  gone = $state(false);

  /** A Svelte action for the scroll container (`main.app-main`). */
  attach = (root: HTMLElement) => {
    let target: Element | null = null;
    let frame = 0;

    const io = new IntersectionObserver(
      (entries) => {
        const last = entries[entries.length - 1];
        if (last && last.target === target) this.gone = !last.isIntersecting;
      },
      // gone once only a sliver of it is left under the top edge
      { root, rootMargin: '-40px 0px 0px 0px', threshold: 0 }
    );

    const find = () => {
      frame = 0;
      const next = root.querySelector('[data-page-head]') ?? root.querySelector('h1');
      if (next === target) return;
      if (target) io.unobserve(target);
      target = next;
      if (target) io.observe(target);
      else onScroll();
    };
    // no header to watch: the scroll position says it
    const onScroll = () => {
      if (!target) this.gone = root.scrollTop > 96;
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    const mo = new MutationObserver(() => {
      if (!frame) frame = requestAnimationFrame(find);
    });
    mo.observe(root, { childList: true, subtree: true });
    find();

    return {
      destroy: () => {
        root.removeEventListener('scroll', onScroll);
        mo.disconnect();
        io.disconnect();
        if (frame) cancelAnimationFrame(frame);
      }
    };
  };
}
