/* The pointer, as the brand's living fields read it: where it is around an
   anchor, -1..1 on each axis, followed critically damped (no overshoot: a
   body that swings back is what turns the stomach), handed to one frame
   callback with the clock. It owns what every such surface needs the same
   way: nothing runs under prefers-reduced-motion, a touch does not steer,
   the aim goes home when the pointer leaves the window, and no frame is
   spent while the anchor is hidden or off screen. */
export interface Follow {
  /** the followed pointer, -1..1 from the anchor's centre */
  x: number;
  y: number;
  /** seconds since the follow began */
  t: number;
}

export function followPointer(anchor: HTMLElement, frame: (f: Follow) => void): () => void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return () => {};

  const aim = { x: 0, y: 0 };
  const onMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    const r = anchor.getBoundingClientRect();
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    aim.x = clamp((e.clientX - (r.left + r.width / 2)) / (window.innerWidth / 2));
    aim.y = clamp((e.clientY - (r.top + r.height / 2)) / (window.innerHeight / 2));
  };
  const onLeave = () => {
    aim.x = 0;
    aim.y = 0;
  };
  window.addEventListener('pointermove', onMove, { passive: true });
  document.documentElement.addEventListener('pointerleave', onLeave);

  let seen = false;
  const io = new IntersectionObserver(([e]) => {
    seen = e.isIntersecting;
  });
  io.observe(anchor);

  const at = { x: 0, y: 0, vx: 0, vy: 0 };
  const t0 = performance.now();
  let last = t0;
  let rafId = requestAnimationFrame(function tick(now) {
    rafId = requestAnimationFrame(tick);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!seen) return;
    at.vx += ((aim.x - at.x) * 18 - at.vx * 8.5) * dt;
    at.vy += ((aim.y - at.y) * 18 - at.vy * 8.5) * dt;
    at.x += at.vx * dt;
    at.y += at.vy * dt;
    frame({ x: at.x, y: at.y, t: (now - t0) / 1000 });
  });

  return () => {
    cancelAnimationFrame(rafId);
    io.disconnect();
    window.removeEventListener('pointermove', onMove);
    document.documentElement.removeEventListener('pointerleave', onLeave);
  };
}
