/* The brand's constructions as BODIES: each one built once in three
   dimensions and turned per frame, never a flat plate tilted in perspective.
   The engine draws every plate once, flat, on its canvas; a hero that turns
   toward the pointer needs the thing itself, so that a ring can pass in front
   of a body and come back behind it, and a sphere shows another face.

   The conventions are the website's (company/website, src/brand/stage.ts and
   the Hero* constructions), so the same plate turns the same way in both:
     · `turn` is the one view rotation, pitch about the level then yaw about
       the upright; y runs up, z comes toward the eye.
     · a line on a solid is walked once and broken where it changes side: the
       near run is drawn firm, the far run a ghost (or dropped where a ghost
       would only clutter), which is what makes a wireframe read as solid.
     · every radius is read off the shorter side of the box; the body is
       0.42 of it, the engine's own sphere.

   A construction is built from its seed once (`build`) and then only
   rotated, projected and stroked on each frame (`draw`). */
import { mulberry32 } from '$lib/engine/engine.js';

const TAU = Math.PI * 2;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

interface V {
  x: number;
  y: number;
  z: number;
}

export interface SolidFrame {
  ctx: CanvasRenderingContext2D;
  W: number;
  H: number;
  dpr: number;
  ink: (a: number) => string;
  /** the turn the pointer asks for, radians */
  pitch: number;
  yaw: number;
  /** seconds, for whatever life the construction has of its own */
  t: number;
}

export type Solid = (f: SolidFrame) => void;

function turn(p: V, pitch: number, yaw: number): V {
  const ct = Math.cos(pitch);
  const st = Math.sin(pitch);
  const cp = Math.cos(yaw);
  const sp = Math.sin(yaw);
  const y2 = p.y * ct - p.z * st;
  const z2 = p.y * st + p.z * ct;
  return { x: p.x * cp + z2 * sp, y: y2, z: -p.x * sp + z2 * cp };
}

/** About the construction's OWN upright, before the view turns it. */
function spinY(p: V, a: number): V {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: p.x * c + p.z * s, y: p.y, z: -p.x * s + p.z * c };
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** A circle on the unit sphere around `axis` (unit), at height `h` along it. */
function ringAround(axis: V, h: number, samples: number): V[] {
  const r = Math.sqrt(Math.max(0, 1 - h * h));
  // any vector not along the axis, to span the ring's plane
  const ref = Math.abs(axis.y) < 0.9 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  let ux = axis.y * ref.z - axis.z * ref.y;
  let uy = axis.z * ref.x - axis.x * ref.z;
  let uz = axis.x * ref.y - axis.y * ref.x;
  const ul = Math.hypot(ux, uy, uz);
  ux /= ul;
  uy /= ul;
  uz /= ul;
  const vx = axis.y * uz - axis.z * uy;
  const vy = axis.z * ux - axis.x * uz;
  const vz = axis.x * uy - axis.y * ux;
  const out: V[] = [];
  for (let k = 0; k <= samples; k++) {
    const th = (k / samples) * TAU;
    const c = Math.cos(th) * r;
    const s = Math.sin(th) * r;
    out.push({
      x: axis.x * h + c * ux + s * vx,
      y: axis.y * h + c * uy + s * vy,
      z: axis.z * h + c * uz + s * vz
    });
  }
  return out;
}

interface View {
  cx: number;
  cy: number;
  R: number;
}

/** Walk a turned line once, broken where it changes side: near firm, far a
    ghost (`far` 0 drops it). `hide` is the radius, in px, of a body at the
    centre that nothing behind it may cross. */
function strokeRuns(f: SolidFrame, v: View, pts: V[], near: number, far: number, hide = 0) {
  const { ctx } = f;
  let open = false;
  let side = false;
  const close = () => {
    if (!open) return;
    const a = side ? near : far;
    if (a > 0) {
      ctx.strokeStyle = f.ink(a);
      ctx.stroke();
    }
    open = false;
  };
  for (const p of pts) {
    const sx = v.cx + p.x * v.R;
    const sy = v.cy - p.y * v.R;
    const front = p.z >= 0;
    if (!front && hide > 0 && Math.hypot(sx - v.cx, sy - v.cy) < hide) {
      close();
      continue;
    }
    // the crossing point belongs to both runs, so they meet without a nick
    if (open && front !== side) {
      ctx.lineTo(sx, sy);
      close();
    }
    if (!open) {
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      open = true;
      side = front;
    } else {
      ctx.lineTo(sx, sy);
    }
  }
  close();
}

function outline(f: SolidFrame, v: View, a: number, w = 0.8) {
  f.ctx.lineWidth = Math.max(1, f.dpr * w);
  f.ctx.strokeStyle = f.ink(a);
  f.ctx.beginPath();
  f.ctx.arc(v.cx, v.cy, v.R, 0, TAU);
  f.ctx.stroke();
}

function view(f: SolidFrame, scale = 0.42): View {
  return { cx: f.W / 2, cy: f.H / 2, R: Math.min(f.W, f.H) * scale };
}

/* ---------- XVIII, Latitudes: parallels around a pole ---------- */
function latitudes(seed: number): Solid {
  // the engine's own draw: squash = how far the eye sits above the equator
  const squash = 0.26 + mulberry32(seed)() * 0.12;
  const lean = Math.asin(squash);
  const up = { x: 0, y: 1, z: 0 };
  const N = 13;
  const rows = Array.from({ length: N - 1 }, (_, i) => ((i + 1) / N) * 2 - 1);
  const rings = rows.map((h) => ringAround(up, h, 72));
  return (f) => {
    const v = view(f);
    outline(f, v, 0.4);
    f.ctx.lineWidth = Math.max(1, f.dpr * 0.8);
    const pitch = lean + f.pitch;
    rings.forEach((ring, i) => {
      const h = Math.abs(rows[i]);
      strokeRuns(
        f,
        v,
        ring.map((p) => turn(p, pitch, f.yaw)),
        0.2 + h * 0.12,
        0.05 + h * 0.03
      );
    });
    // the pole on the near side, north or south
    let pole = turn(up, pitch, f.yaw);
    if (pole.z < 0) pole = { x: -pole.x, y: -pole.y, z: -pole.z };
    f.ctx.fillStyle = f.ink(0.5);
    f.ctx.beginPath();
    f.ctx.arc(v.cx + pole.x * v.R, v.cy - pole.y * v.R, Math.max(1.5, f.dpr * 1.5), 0, TAU);
    f.ctx.fill();
  };
}

/* ---------- XVII, Meridians: the sphere measured, a globe ---------- */
function meridians(seed: number): Solid {
  const rnd = mulberry32(seed);
  const lean = 0.3 + rnd() * 0.14;
  const spin0 = rnd() * TAU;
  const up = { x: 0, y: 1, z: 0 };
  const GREAT = 9;
  const greats = Array.from({ length: GREAT }, (_, k) => {
    const phi = (k / GREAT) * Math.PI;
    return ringAround({ x: Math.cos(phi), y: 0, z: Math.sin(phi) }, 0, 96);
  });
  const parallels = [-0.75, -0.45, -0.15, 0.15, 0.45, 0.75].map((h) => ringAround(up, h, 72));
  return (f) => {
    const v = view(f);
    outline(f, v, 0.34);
    const spin = spin0 + f.t * 0.05;
    const pitch = lean + f.pitch;
    const place = (p: V) => turn(spinY(p, spin), pitch, f.yaw);
    f.ctx.lineWidth = Math.max(1, f.dpr * 0.7);
    for (const g of greats) strokeRuns(f, v, g.map(place), 0.3, 0.07);
    for (const p of parallels) strokeRuns(f, v, p.map(place), 0.17, 0.045);
  };
}

/* ---------- IV, Harmonic: the nodal set of Y_lm, on the sphere ---------- */
function plm(l: number, m: number, x: number) {
  let pmm = 1;
  if (m > 0) {
    const s = Math.sqrt((1 - x) * (1 + x));
    let fact = 1;
    for (let i = 1; i <= m; i++) {
      pmm *= -fact * s;
      fact += 2;
    }
  }
  if (l === m) return pmm;
  let pmmp1 = x * (2 * m + 1) * pmm;
  if (l === m + 1) return pmmp1;
  let pll = 0;
  for (let ll = m + 2; ll <= l; ll++) {
    pll = (x * (2 * ll - 1) * pmmp1 - (ll + m - 1) * pmm) / (ll - m);
    pmm = pmmp1;
    pmmp1 = pll;
  }
  return pll;
}

function harmonic(seed: number): Solid {
  const rnd = mulberry32(seed);
  const pairs = [
    [2, 1],
    [3, 2],
    [4, 2],
    [5, 3],
    [3, 1],
    [4, 3],
    [6, 4]
  ];
  const [l, m] = pairs[Math.floor(rnd() * pairs.length)];
  const lean = 0.28 + rnd() * 0.5;
  const spin0 = rnd() * TAU;
  const up = { x: 0, y: 1, z: 0 };
  // the l-m nodal circles: where P_lm changes sign between the poles
  const circles: V[][] = [];
  let prev = plm(l, m, -0.999);
  for (let i = 1; i <= 2000; i++) {
    const x = -0.999 + (1.998 * i) / 2000;
    const cur = plm(l, m, x);
    if (prev * cur < 0) circles.push(ringAround(up, x - 0.0005, 72));
    prev = cur;
  }
  // the m nodal meridians: cos(m·phi) = 0, each a great circle through the poles
  const greats = Array.from({ length: m }, (_, k) => {
    const phi = (Math.PI / 2 + k * Math.PI) / m;
    return ringAround({ x: -Math.sin(phi), y: 0, z: Math.cos(phi) }, 0, 96);
  });
  return (f) => {
    const v = view(f, 0.44);
    outline(f, v, 0.35, 1);
    const spin = spin0 + f.t * 0.05;
    const pitch = lean + f.pitch;
    const place = (p: V) => turn(spinY(p, spin), pitch, f.yaw);
    f.ctx.lineWidth = Math.max(1, f.dpr * 0.85);
    for (const c of circles) strokeRuns(f, v, c.map(place), 0.46, 0.1);
    for (const g of greats) strokeRuns(f, v, g.map(place), 0.46, 0.1);
  };
}

/* ---------- III, Lattice: golden-angle points, three nearest joined ---------- */
function lattice(seed: number): Solid {
  const rnd = mulberry32(seed);
  const tilt = 0.25 + rnd() * 0.5;
  const spin0 = rnd() * TAU;
  let built: { n: number; pts: V[]; edges: [number, number][] } | null = null;
  // the graph is computed once: a rigid rotation never changes who is near whom
  const build = (n: number) => {
    const pts: V[] = [];
    for (let k = 0; k < n; k++) {
      const z = 1 - (2 * k + 1) / n;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      pts.push({ x: r * Math.cos(k * GOLDEN), y: r * Math.sin(k * GOLDEN), z });
    }
    const edges: [number, number][] = [];
    const seen = new Set<string>();
    for (let k = 0; k < n; k++) {
      const near = pts
        .map((b, j) => ({ j, d: (pts[k].x - b.x) ** 2 + (pts[k].y - b.y) ** 2 + (pts[k].z - b.z) ** 2 }))
        .filter((o) => o.j !== k)
        .sort((p, q) => p.d - q.d)
        .slice(0, 3);
      for (const e of near) {
        const key = Math.min(k, e.j) + ':' + Math.max(k, e.j);
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push([k, e.j]);
      }
    }
    return { n, pts, edges };
  };
  return (f) => {
    const v = view(f);
    const n = Math.min(f.W, f.H) < 560 ? 140 : 260;
    if (!built || built.n !== n) built = build(n);
    const proj = built.pts.map((p) => turn(p, tilt + f.pitch, spin0 + f.t * 0.04 + f.yaw));
    const { ctx } = f;
    ctx.lineWidth = Math.max(1, f.dpr * 0.6);
    for (const [i, j] of built.edges) {
      const a = proj[i];
      const b = proj[j];
      const depth = (a.z + b.z) / 2;
      if (depth < -0.12) continue;
      ctx.strokeStyle = f.ink(0.05 + 0.2 * clamp01((depth + 1) / 2));
      ctx.beginPath();
      ctx.moveTo(v.cx + a.x * v.R, v.cy - a.y * v.R);
      ctx.lineTo(v.cx + b.x * v.R, v.cy - b.y * v.R);
      ctx.stroke();
    }
    for (const p of proj) {
      const d = clamp01((p.z + 1) / 2);
      ctx.fillStyle = f.ink(0.14 + 0.6 * d * d);
      ctx.beginPath();
      ctx.arc(v.cx + p.x * v.R, v.cy - p.y * v.R, Math.max(0.8, f.dpr * (0.5 + 1.5 * d)), 0, TAU);
      ctx.fill();
    }
    outline(f, v, 0.14);
  };
}

/* ---------- XIX, Orbits: the website's armillary ---------- */
function orbits(): Solid {
  /* Declared, not dealt: chosen against the resting view so no ring stands
     edge-on at rest (the website's HeroOrbits has the reasoning). */
  const ORBITS = [
    { mult: 1.13, incl: 1.32, node: 0.0, rate: 0.24, phase: 0.4 },
    { mult: 0.99, incl: 0.51, node: 2.7, rate: -0.4, phase: 2.1 },
    { mult: 0.86, incl: -0.44, node: 0.9, rate: 0.3, phase: 4.0 },
    { mult: 0.76, incl: 0.2, node: 1.9, rate: -0.52, phase: 1.3 }
  ];
  const SAMPLES = 128;
  const TRAIL = 0.3;
  const BASE_TILT = 0.3;
  const planes = ORBITS.map((o) => ({
    u: { x: Math.cos(o.node), y: 0, z: Math.sin(o.node) },
    v: {
      x: -Math.sin(o.node) * Math.cos(o.incl),
      y: Math.sin(o.incl),
      z: Math.cos(o.node) * Math.cos(o.incl)
    }
  }));
  return (f) => {
    const M = Math.min(f.W, f.H);
    // a little inside the website's 0.4: here a mask fades the box's edge
    const v = { cx: f.W / 2, cy: f.H / 2, R: M * 0.35 };
    const core = M * 0.135;
    const pitch = BASE_TILT + f.pitch;
    const at = (i: number, k: number) => {
      const { u, v: w } = planes[i];
      const c = Math.cos(k) * ORBITS[i].mult;
      const s = Math.sin(k) * ORBITS[i].mult;
      return turn({ x: c * u.x + s * w.x, y: c * u.y + s * w.y, z: c * u.z + s * w.z }, pitch, f.yaw);
    };
    const { ctx } = f;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1, f.dpr * 0.9);
    for (let i = 0; i < ORBITS.length; i++) {
      const ring: V[] = [];
      for (let k = 0; k <= SAMPLES; k++) ring.push(at(i, (k / SAMPLES) * TAU));
      strokeRuns(f, v, ring, 0.44, 0.17, core);
    }
    // the body: its outline alone; an empty circle nothing crosses reads as solid
    ctx.lineWidth = Math.max(1, f.dpr);
    ctx.strokeStyle = f.ink(0.55);
    ctx.beginPath();
    ctx.arc(v.cx, v.cy, core, 0, TAU);
    ctx.stroke();
    // the satellites, each with the arc it has just come along
    for (let i = 0; i < ORBITS.length; i++) {
      const th = ORBITS[i].phase + f.t * ORBITS[i].rate;
      const head = at(i, th);
      const trail: V[] = [];
      for (let k = 10; k >= 0; k--) trail.push(at(i, th - (TRAIL * k) / 10));
      ctx.lineWidth = Math.max(1, f.dpr * 1.4);
      const a = head.z >= 0 ? 0.55 : 0.18;
      strokeRuns(f, v, trail, a, a, core);
      const sx = v.cx + head.x * v.R;
      const sy = v.cy - head.y * v.R;
      if (head.z < 0 && Math.hypot(sx - v.cx, sy - v.cy) < core) continue;
      ctx.fillStyle = f.ink(head.z >= 0 ? 0.75 : 0.3);
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(2, M * 0.008), 0, TAU);
      ctx.fill();
    }
  };
}

/* ---------- XXI, Graph: nodes in space, each reaching for two ---------- */
function graph(seed: number): Solid {
  const rnd = mulberry32(seed);
  const n = 14;
  const nodes = Array.from({ length: n }, () => {
    const z = rnd() * 2 - 1;
    const th = rnd() * TAU;
    const r = Math.sqrt(1 - z * z);
    const reach = 0.45 + 0.55 * Math.cbrt(rnd());
    return {
      x: r * Math.cos(th) * reach,
      y: z * reach * 0.8,
      z: r * Math.sin(th) * reach,
      size: 0.006 + rnd() * 0.012
    };
  });
  // every edge bows a little, through a control point off its middle
  const edges: V[][] = [];
  const seen = new Set<string>();
  nodes.forEach((a, ai) => {
    nodes
      .map((b, j) => ({ j, d: Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) }))
      .filter((o) => o.j !== ai)
      .sort((p, q) => p.d - q.d)
      .slice(0, 2)
      .forEach((o) => {
        const key = Math.min(ai, o.j) + ':' + Math.max(ai, o.j);
        if (seen.has(key)) return;
        seen.add(key);
        const b = nodes[o.j];
        const c = {
          x: (a.x + b.x) / 2 + (rnd() - 0.5) * 0.14,
          y: (a.y + b.y) / 2 + (rnd() - 0.5) * 0.14,
          z: (a.z + b.z) / 2 + (rnd() - 0.5) * 0.14
        };
        const line: V[] = [];
        for (let k = 0; k <= 14; k++) {
          const u = k / 14;
          const w0 = (1 - u) * (1 - u);
          const w1 = 2 * u * (1 - u);
          const w2 = u * u;
          line.push({
            x: w0 * a.x + w1 * c.x + w2 * b.x,
            y: w0 * a.y + w1 * c.y + w2 * b.y,
            z: w0 * a.z + w1 * c.z + w2 * b.z
          });
        }
        edges.push(line);
      });
  });
  return (f) => {
    const M = Math.min(f.W, f.H);
    const v = { cx: f.W / 2, cy: f.H / 2, R: M * 0.46 };
    const pitch = 0.25 + f.pitch;
    const yaw = f.t * 0.04 + f.yaw;
    const { ctx } = f;
    ctx.lineWidth = Math.max(1, f.dpr * 0.7);
    for (const line of edges) {
      const pts = line.map((p) => turn(p, pitch, yaw));
      const d = clamp01((pts[7].z + 1) / 2);
      ctx.strokeStyle = f.ink(0.08 + 0.24 * d);
      ctx.beginPath();
      pts.forEach((p, k) =>
        k ? ctx.lineTo(v.cx + p.x * v.R, v.cy - p.y * v.R) : ctx.moveTo(v.cx + p.x * v.R, v.cy - p.y * v.R)
      );
      ctx.stroke();
    }
    // far nodes first, so a near one sits over them
    nodes
      .map((node) => ({ p: turn(node, pitch, yaw), size: node.size }))
      .sort((a, b) => a.p.z - b.p.z)
      .forEach(({ p, size }) => {
        const d = clamp01((p.z + 1) / 2);
        const r = Math.max(2, M * size) * (0.7 + 0.6 * d);
        const sx = v.cx + p.x * v.R;
        const sy = v.cy - p.y * v.R;
        ctx.fillStyle = f.ink(0.22 + 0.45 * d);
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = f.ink(0.1 + 0.24 * d);
        ctx.lineWidth = Math.max(1, f.dpr * 0.6);
        ctx.beginPath();
        ctx.arc(sx, sy, r * 2.6, 0, TAU);
        ctx.stroke();
      });
  };
}

/* ---------- XIV, Apollonian: the packing, carried onto the sphere ---------- */
function apollonian(seed: number): Solid {
  const rot = mulberry32(seed)() * TAU;
  interface Circle {
    k: number;
    x: number;
    y: number;
  }
  const base: Circle[] = [
    { k: -1, x: 0, y: 0 },
    { k: 2, x: -0.5, y: 0 },
    { k: 2, x: 0.5, y: 0 },
    { k: 3, x: 0, y: 2 / 3 }
  ];
  const out: Circle[] = [];
  const seen = new Set<string>();
  const push = (c: Circle) => {
    const key = c.x.toFixed(4) + ',' + c.y.toFixed(4) + ',' + c.k.toFixed(3);
    if (seen.has(key)) return false;
    seen.add(key);
    out.push(c);
    return true;
  };
  base.forEach(push);
  const queue: Circle[][] = [base];
  for (let head = 0, guard = 0; head < queue.length && out.length < 320 && guard < 6000; guard++) {
    const q = queue[head++];
    for (let i = 0; i < 4; i++) {
      const o = q.filter((_, j) => j !== i);
      const k = 2 * (o[0].k + o[1].k + o[2].k) - q[i].k;
      if (k <= 0 || 1 / k < 0.011) continue;
      const x = (2 * (o[0].k * o[0].x + o[1].k * o[1].x + o[2].k * o[2].x) - q[i].k * q[i].x) / k;
      const y = (2 * (o[0].k * o[0].y + o[1].k * o[1].y + o[2].k * o[2].y) - q[i].k * q[i].y) / k;
      if (Math.hypot(x, y) + 1 / k > 1.0005) continue;
      const c = { k, x, y };
      if (push(c)) queue.push([o[0], o[1], o[2], c]);
    }
  }
  /* The inverse stereographic projection carries circles to circles, so the
     packing stays a packing on the sphere. The enclosing circle lands on the
     equator: the near hemisphere carries the gasket as the plate shows it,
     and the far one carries its mirror, so the body is packed all round. */
  const cs = Math.cos(rot);
  const sn = Math.sin(rot);
  const lift = (px: number, py: number, side: number): V => {
    const X = px * cs - py * sn;
    const Y = px * sn + py * cs;
    const d = X * X + Y * Y;
    return { x: (2 * X) / (1 + d), y: (2 * Y) / (1 + d), z: (side * (1 - d)) / (1 + d) };
  };
  const rings: { pts: V[]; alpha: number }[] = [];
  for (const c of out) {
    const r = 1 / Math.abs(c.k);
    const samples = Math.max(14, Math.min(96, Math.round(r * 220)));
    const alpha = c.k < 0 ? 0.45 : Math.max(0.1, Math.min(0.44, 0.1 + r * 1.5));
    for (const side of c.k < 0 ? [1] : [1, -1]) {
      const pts: V[] = [];
      for (let k = 0; k <= samples; k++) {
        const th = (k / samples) * TAU;
        pts.push(lift(c.x + Math.cos(th) * r, c.y + Math.sin(th) * r, side));
      }
      rings.push({ pts, alpha });
    }
  }
  return (f) => {
    const v = view(f, 0.45);
    outline(f, v, 0.3);
    const pitch = 0.16 + f.pitch;
    const yaw = Math.sin(f.t * 0.1) * 0.16 + f.yaw;
    f.ctx.lineWidth = Math.max(1, f.dpr * 0.7);
    for (const ring of rings) {
      strokeRuns(
        f,
        v,
        ring.pts.map((p) => turn(p, pitch, yaw)),
        ring.alpha,
        ring.alpha * 0.14
      );
    }
  };
}

/* ---------- V, Contour: the level sets, stacked into the relief they map ---------- */
function contour(seed: number): Solid {
  const rnd = mulberry32(seed);
  const hills = Array.from({ length: 5 }, () => ({
    x: (rnd() - 0.5) * 1.3,
    y: (rnd() - 0.5) * 1.3,
    s: 0.22 + rnd() * 0.3,
    a: 0.5 + rnd() * 0.5
  }));
  const height = (x: number, y: number) => {
    let h = 0;
    for (const p of hills) h += p.a * Math.exp(-((x - p.x) ** 2 + (y - p.y) ** 2) / (2 * p.s * p.s));
    // the land falls to the rim, so every level closes inside the plate
    return h * Math.max(0, 1 - (x * x + y * y) ** 2);
  };
  const G = 72;
  const grid = new Float32Array((G + 1) * (G + 1));
  let hi = 0;
  for (let j = 0; j <= G; j++)
    for (let i = 0; i <= G; i++) {
      const h = height((i / G) * 2 - 1, (j / G) * 2 - 1);
      grid[j * (G + 1) + i] = h;
      if (h > hi) hi = h;
    }
  const RISE = 0.62;
  const N = 9;
  // marching squares, once: each level's segments, already lifted to its height
  const levels: { segs: [V, V][]; alpha: number }[] = [];
  for (let k = 1; k < N; k++) {
    const lv = (hi * k) / N;
    const y = (k / N - 0.42) * RISE;
    const segs: [V, V][] = [];
    for (let j = 0; j < G; j++)
      for (let i = 0; i < G; i++) {
        const c = [
          grid[j * (G + 1) + i],
          grid[j * (G + 1) + i + 1],
          grid[(j + 1) * (G + 1) + i + 1],
          grid[(j + 1) * (G + 1) + i]
        ];
        const corner = [
          [i, j],
          [i + 1, j],
          [i + 1, j + 1],
          [i, j + 1]
        ];
        const cuts: V[] = [];
        for (let e = 0; e < 4; e++) {
          const a = c[e];
          const b = c[(e + 1) % 4];
          if (a < lv === b < lv) continue;
          const u = (lv - a) / (b - a);
          const gx = corner[e][0] + (corner[(e + 1) % 4][0] - corner[e][0]) * u;
          const gy = corner[e][1] + (corner[(e + 1) % 4][1] - corner[e][1]) * u;
          cuts.push({ x: (gx / G) * 2 - 1, y, z: (gy / G) * 2 - 1 });
        }
        if (cuts.length >= 2) segs.push([cuts[0], cuts[1]]);
        if (cuts.length === 4) segs.push([cuts[2], cuts[3]]);
      }
    levels.push({ segs, alpha: k % 2 === 0 ? 0.36 : 0.19 });
  }
  const rim = ringAround({ x: 0, y: 1, z: 0 }, 0, 96).map((p) => ({ x: p.x, y: -0.42 * RISE, z: p.z }));
  return (f) => {
    const v = view(f, 0.45);
    // seen from above the land, a little; the relief sways, it does not spin
    const pitch = 0.62 + f.pitch;
    const yaw = Math.sin(f.t * 0.12) * 0.12 + f.yaw;
    const { ctx } = f;
    ctx.lineWidth = Math.max(1, f.dpr * 0.75);
    ctx.strokeStyle = f.ink(0.22);
    ctx.beginPath();
    rim.forEach((p, k) => {
      const q = turn(p, pitch, yaw);
      if (k) ctx.lineTo(v.cx + q.x * v.R, v.cy - q.y * v.R);
      else ctx.moveTo(v.cx + q.x * v.R, v.cy - q.y * v.R);
    });
    ctx.stroke();
    for (const level of levels) {
      ctx.strokeStyle = f.ink(level.alpha);
      ctx.beginPath();
      for (const [a, b] of level.segs) {
        const p = turn(a, pitch, yaw);
        const q = turn(b, pitch, yaw);
        ctx.moveTo(v.cx + p.x * v.R, v.cy - p.y * v.R);
        ctx.lineTo(v.cx + q.x * v.R, v.cy - q.y * v.R);
      }
      ctx.stroke();
    }
  };
}

const BUILDERS: Record<string, (seed: number) => Solid> = {
  latitudes,
  meridians,
  harmonic,
  lattice,
  orbits,
  graph,
  apollonian,
  contour
};

/** The construction as a body, or null where the brand has only the plate. */
export function buildSolid(shape: string, seed: number): Solid | null {
  return BUILDERS[shape]?.(seed) ?? null;
}
