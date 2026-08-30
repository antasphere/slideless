// @ts-nocheck
/* The Antasphere field engine, copied verbatim from company/brand src/lib/engine/engine.js
   (the same copy finance-app and hiring-app carry). Do not edit here: fix it in the
   brand console and re-copy. ts-nocheck because the hub runs checkJs. */
var TAU = Math.PI * 2;
var PHI = (1 + Math.sqrt(5)) / 2;
var GOLDEN = Math.PI * (3 - Math.sqrt(5));
/* SSR-safe: this module is imported by SvelteKit server renders; the
     canvas work only ever runs in the browser. */
var _dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
var DPR = Math.min(_dpr, 2);
var THUMB_DPR = Math.min(_dpr, 1.5);
var LOW_W = 116;

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}
function mulberry32(seed) {
  var a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function newSeed() {
  return Math.floor(Math.random() * 1e9);
}
function pad(n) {
  return String(n).padStart(9, '0');
}
function deg(r) {
  return Math.round((r * 180) / Math.PI);
}

/* ================= palettes ================= */
var PALETTES = {
  meadow: {
    light: false,
    base: '#22331C',
    hues: ['#16240F', '#3E5C26', '#6E8C33', '#D9A03F', '#7FA8C9', '#E4D9BC', '#C9803F']
  },
  furnace: {
    light: false,
    base: '#33261E',
    hues: ['#4A6B66', '#2E4744', '#E89B4F', '#C25C2E', '#8A3A24', '#1F1712', '#E8C088']
  },
  ember: {
    light: false,
    base: '#4A3A4E',
    hues: ['#6E5573', '#9E6B8A', '#C97B4A', '#E8A04F', '#B85C50', '#3A2B40', '#E5C08A']
  },
  tide: {
    light: false,
    base: '#3A4A52',
    hues: ['#2B3A42', '#5C7285', '#7FA3A8', '#4A6355', '#C2CCC7', '#8FA8B8', '#33413B']
  },
  basalt: {
    light: false,
    base: '#26282B',
    hues: ['#17181A', '#33373B', '#4E555C', '#6B737A', '#8C949B', '#2A3138', '#C0C4C6']
  },
  verdigris: {
    light: false,
    base: '#1F3A35',
    hues: ['#132724', '#152825', '#2C5F55', '#3E8C7A', '#7FC2AC', '#C9A227', '#0F1D1B']
  },
  aurora: {
    light: false,
    base: '#221B33',
    hues: ['#150F22', '#3A2A63', '#6C4FA8', '#B06BC4', '#4FD0C0', '#8FE3B8', '#E5C0F0']
  },
  solar: {
    light: true,
    base: '#F2E4C9',
    hues: ['#FFF6E4', '#FBE9C4', '#F3C77E', '#E8A04F', '#F5DDB0', '#FFFDF6', '#DE8B4A']
  },
  pearl: {
    light: true,
    base: '#F0EDEE',
    hues: ['#FBF9F9', '#E9E2F2', '#DFEBE6', '#F5E3E4', '#C9BBDF', '#AFCFC6', '#8E7CB8']
  },
  dawn: {
    light: true,
    base: '#F6E9DE',
    hues: ['#FDF5EC', '#F9DFC9', '#F3C7AC', '#EBA284', '#DB7D5F', '#F3D6E0', '#C9664A']
  },
  glacier: {
    light: true,
    base: '#E9F0F3',
    hues: ['#F8FBFC', '#DEEAF0', '#C6DAE5', '#A3C4D6', '#7FA9C2', '#EBF3EF', '#5D8CA9']
  },
  reef: {
    light: true,
    base: '#E5F1EB',
    hues: ['#F5FBF8', '#D4EAE0', '#B0DCCE', '#82C4B0', '#4FAB92', '#F2C9AE', '#2F8E78']
  },
  iris: {
    light: true,
    base: '#EAEBF7',
    hues: ['#F8F8FD', '#DEE0F4', '#C5C9EC', '#A2A8DE', '#7E86CE', '#E9DDF1', '#5A63BA']
  }
};
var PAL_KEYS = Object.keys(PALETTES);

/* ================= grain ================= */
function noiseTile(size, amp) {
  var c = document.createElement('canvas');
  c.width = c.height = size;
  var ctx = c.getContext('2d');
  var img = ctx.createImageData(size, size);
  var d = img.data;
  for (var i = 0; i < d.length; i += 4) {
    var v = 128 + (Math.random() - 0.5) * 255 * amp;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
/* tiles are built lazily so the module can load during SSR */
var GRAINS = {
  film: {
    label: 'Film',
    _a: 0.9,
    get tile() {
      if (!this._t && typeof document !== 'undefined') this._t = noiseTile(512, this._a);
      return this._t;
    }
  },
  fine: {
    label: 'Fine',
    _a: 0.42,
    get tile() {
      if (!this._t && typeof document !== 'undefined') this._t = noiseTile(512, this._a);
      return this._t;
    }
  }
};
var GRAIN_KEYS = Object.keys(GRAINS);

/* ================= typefaces ================= */
var FONTS = {
  cabinet: { label: 'Cabinet Grotesk', family: 'Cabinet Grotesk', weight: 500, track: -2 },
  sora: { label: 'Sora', family: 'Sora', weight: 300, track: 20 }
};
var FONT_KEYS = Object.keys(FONTS);

var JOINS = ['none', 'rule', 'dot', 'ring', 'step', 'caps'];
var JOIN_LABEL = {
  none: 'None',
  rule: 'Rule',
  dot: 'Interpunct',
  ring: 'Ring',
  step: 'Weight step',
  caps: 'Capitals'
};

/* ================= shared numerical machinery ================= */

/* Marching squares over an arbitrary scalar function of device pixels.
     Cells touching a NaN are skipped, which is how the disc-shaped and
     square-plate domains clip themselves without a mask. */
function isolines(ctx, W, H, gw, gh, fn, levels, ink) {
  var g = new Float32Array(gw * gh),
    i,
    j;
  for (j = 0; j < gh; j++) {
    var py = (j / (gh - 1)) * H;
    for (i = 0; i < gw; i++) g[j * gw + i] = fn((i / (gw - 1)) * W, py);
  }
  var sx = W / (gw - 1),
    sy = H / (gh - 1);
  ctx.lineJoin = 'round';
  for (var L = 0; L < levels.length; L++) {
    var v = levels[L].v;
    ctx.strokeStyle = ink(levels[L].a);
    ctx.lineWidth = Math.max(1, DPR * (levels[L].w || 0.7));
    ctx.beginPath();
    for (j = 0; j < gh - 1; j++) {
      for (i = 0; i < gw - 1; i++) {
        var a = g[j * gw + i],
          b = g[j * gw + i + 1];
        var c = g[(j + 1) * gw + i + 1],
          d = g[(j + 1) * gw + i];
        if (!(isFinite(a) && isFinite(b) && isFinite(c) && isFinite(d))) continue;
        var p = [];
        if (a < v !== b < v) p.push([i + (v - a) / (b - a), j]);
        if (b < v !== c < v) p.push([i + 1, j + (v - b) / (c - b)]);
        if (d < v !== c < v) p.push([i + (v - d) / (c - d), j + 1]);
        if (a < v !== d < v) p.push([i, j + (v - a) / (d - a)]);
        if (p.length === 2) {
          ctx.moveTo(p[0][0] * sx, p[0][1] * sy);
          ctx.lineTo(p[1][0] * sx, p[1][1] * sy);
        } else if (p.length === 4) {
          var mid = (a + b + c + d) / 4;
          var ord = mid < v ? [0, 1, 2, 3] : [0, 3, 2, 1];
          for (var k = 0; k < 4; k += 2) {
            ctx.moveTo(p[ord[k]][0] * sx, p[ord[k]][1] * sy);
            ctx.lineTo(p[ord[k + 1]][0] * sx, p[ord[k + 1]][1] * sy);
          }
        }
      }
    }
    ctx.stroke();
  }
}

function smooth(lum, w, h, passes) {
  var cur = lum;
  for (var p = 0; p < passes; p++) {
    var next = new Float32Array(cur.length);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var s = 0,
          n = 0;
        for (var dy = -1; dy <= 1; dy++) {
          var yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (var dx = -1; dx <= 1; dx++) {
            var xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            s += cur[yy * w + xx];
            n++;
          }
        }
        next[y * w + x] = s / n;
      }
    }
    cur = next;
  }
  return cur;
}

function bilinear(lum, w, h) {
  return function (x, y) {
    x = clamp(x, 0, w - 1.001);
    y = clamp(y, 0, h - 1.001);
    var x0 = Math.floor(x),
      y0 = Math.floor(y),
      tx = x - x0,
      ty = y - y0;
    var a = lum[y0 * w + x0],
      b = lum[y0 * w + x0 + 1];
    var c = lum[(y0 + 1) * w + x0 + 1],
      d = lum[(y0 + 1) * w + x0];
    return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + d * (1 - tx) * ty + c * tx * ty;
  };
}

function mkLine(ctx) {
  return function (x1, y1, x2, y2) {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  };
}
function circle(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
}

/* associated Legendre polynomial, standard recurrence */
function plm(l, m, x) {
  var pmm = 1;
  if (m > 0) {
    var s = Math.sqrt(Math.max(0, 1 - x * x)),
      f = 1;
    for (var i = 1; i <= m; i++) {
      pmm *= -f * s;
      f += 2;
    }
  }
  if (l === m) return pmm;
  var pmmp1 = x * (2 * m + 1) * pmm;
  if (l === m + 1) return pmmp1;
  var pll = 0;
  for (var ll = m + 2; ll <= l; ll++) {
    pll = ((2 * ll - 1) * x * pmmp1 - (ll + m - 1) * pmm) / (ll - m);
    pmm = pmmp1;
    pmmp1 = pll;
  }
  return pll;
}

/* the catenary parameter a such that a(cosh(L/a) - 1) = rise */
function solveA(L, rise) {
  var lo = L * 1e-3,
    hi = L * 1e3;
  var g = function (a) {
    return a * (Math.cosh(L / a) - 1) - rise;
  };
  for (var i = 0; i < 70; i++) {
    var m = (lo + hi) / 2;
    if (g(m) > 0) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

/* ================= the constructions (sixteen atlas plates + five round-3 studies) ================= */
/* draw(ctx, W, H, rnd, ink, env) -> array of measurement strings.
     env = { field, blobs, small } where field is the low-res luminance grid. */

var C = {};

C.graticule = {
  roman: 'I',
  group: 'sphere',
  name: 'Graticule',
  attr: 'Hipparchus, c.150 BC \u00b7 Cartography',
  def: 'A sphere seen from infinitely far away. Meridians and parallels every 15\u00b0, with the far hemisphere left faint rather than hidden.',
  couple: 'The seed sets the viewing latitude and the prime meridian.',
  formula: 'x = R cos\u03c6 sin(\u03bb \u2212 \u03bb\u2080)',
  draw: function (ctx, W, H, rnd, ink) {
    var R = Math.min(W, H) * 0.43,
      cx = W / 2,
      cy = H / 2;
    var lat0 = (0.15 + rnd() * 0.35) * (rnd() < 0.5 ? -1 : 1);
    var lon0 = (rnd() - 0.5) * 1.1;
    ctx.lineWidth = Math.max(1, DPR * 0.7);
    function P(la, lo) {
      var cosc = Math.sin(lat0) * Math.sin(la) + Math.cos(lat0) * Math.cos(la) * Math.cos(lo - lon0);
      return {
        x: cx + R * Math.cos(la) * Math.sin(lo - lon0),
        y: cy - R * (Math.cos(lat0) * Math.sin(la) - Math.sin(lat0) * Math.cos(la) * Math.cos(lo - lon0)),
        v: cosc >= 0
      };
    }
    function poly(pts, av, ah) {
      var run = [],
        vis = pts.length ? pts[0].v : true;
      function flush() {
        if (run.length > 1) {
          ctx.strokeStyle = ink(vis ? av : ah);
          ctx.beginPath();
          ctx.moveTo(run[0].x, run[0].y);
          for (var i = 1; i < run.length; i++) ctx.lineTo(run[i].x, run[i].y);
          ctx.stroke();
        }
        run = [];
      }
      for (var i = 0; i < pts.length; i++) {
        if (pts[i].v !== vis) {
          run.push(pts[i]);
          flush();
          vis = pts[i].v;
        }
        run.push(pts[i]);
      }
      flush();
    }
    var D = Math.PI / 180,
      lo,
      la,
      pts;
    for (lo = -180; lo < 180; lo += 15) {
      pts = [];
      for (la = -90; la <= 90; la += 2) pts.push(P(la * D, lo * D));
      poly(pts, 0.3, 0.06);
    }
    for (la = -75; la <= 75; la += 15) {
      pts = [];
      for (lo = -180; lo <= 180; lo += 2) pts.push(P(la * D, lo * D));
      poly(pts, 0.24, 0.05);
    }
    ctx.strokeStyle = ink(0.45);
    ctx.lineWidth = Math.max(1, DPR);
    circle(ctx, cx, cy, R);
    ctx.stroke();
    return [
      '\u03c6\u2081 <b>' + deg(lat0) + '\u00b0</b>',
      '\u03bb\u2080 <b>' + deg(lon0) + '\u00b0</b>',
      'net <b>15\u00b0</b>'
    ];
  }
};

C.wulff = {
  roman: 'II',
  group: 'sphere',
  name: 'Wulff net',
  attr: 'G. Wulff, 1902 \u00b7 Crystallography',
  def: 'The same sphere, projected from one pole onto the equatorial plane. Angles survive the projection, so a crystallographer measures on it directly.',
  couple: 'The seed rotates the net in its own plane.',
  formula: 'k = 2R / (1 + cos\u03c6 cos\u03bb)',
  draw: function (ctx, W, H, rnd, ink) {
    var R = Math.min(W, H) * 0.44,
      cx = W / 2,
      cy = H / 2;
    var spin = (rnd() - 0.5) * 0.7,
      cs = Math.cos(spin),
      sn = Math.sin(spin);
    var D = Math.PI / 180;
    function P(la, lo) {
      var k = 2 / (1 + Math.cos(la) * Math.cos(lo));
      var x = k * Math.cos(la) * Math.sin(lo) * (R / 2),
        y = k * Math.sin(la) * (R / 2);
      return { x: cx + x * cs - y * sn, y: cy - (x * sn + y * cs) };
    }
    function arc(pts, a) {
      ctx.strokeStyle = ink(a);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
    ctx.lineWidth = Math.max(1, DPR * 0.65);
    var lo,
      la,
      pts,
      n = 0;
    for (lo = -80; lo <= 80; lo += 10) {
      pts = [];
      for (la = -90; la <= 90; la += 1) pts.push(P(la * D, lo * D));
      arc(pts, lo === 0 ? 0.4 : 0.16);
      n++;
    }
    for (la = -80; la <= 80; la += 10) {
      pts = [];
      for (lo = -90; lo <= 90; lo += 1) pts.push(P(la * D, lo * D));
      arc(pts, la === 0 ? 0.4 : 0.16);
      n++;
    }
    ctx.strokeStyle = ink(0.5);
    ctx.lineWidth = Math.max(1, DPR);
    circle(ctx, cx, cy, R);
    ctx.stroke();
    ctx.strokeStyle = ink(0.45);
    var line = mkLine(ctx);
    for (var t = 0; t < 36; t++) {
      var a = t * 10 * D + spin,
        r0 = R * (t % 9 === 0 ? 0.94 : 0.97);
      line(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0, cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    }
    return ['net <b>10\u00b0</b>', 'arcs <b>' + n + '</b>', 'front hemisphere'];
  }
};

C.lattice = {
  roman: 'III',
  group: 'sphere',
  name: 'Lattice',
  attr: 'Vogel, 1979 \u00b7 Phyllotaxis',
  def: 'Points placed one golden angle apart, spiralling pole to pole. No neighbourhood repeats, so the sphere is covered as evenly as an irrational number allows.',
  couple: 'The seed sets tilt and spin. Each point joins its three nearest neighbours.',
  formula: '\u03b8_k = k \u00b7 137.508\u00b0,  z_k = 1 \u2212 2k/N',
  draw: function (ctx, W, H, rnd, ink, env) {
    var R = Math.min(W, H) * 0.42,
      cx = W / 2,
      cy = H / 2;
    var N = env.small ? 140 : 260;
    var tilt = 0.25 + rnd() * 0.5,
      spin = rnd() * TAU;
    var ct = Math.cos(tilt),
      st = Math.sin(tilt),
      cp = Math.cos(spin),
      sp = Math.sin(spin);
    var pts = [],
      k;
    for (k = 0; k < N; k++) {
      var z = 1 - (2 * k + 1) / N,
        r = Math.sqrt(Math.max(0, 1 - z * z)),
        th = k * GOLDEN;
      var x = r * Math.cos(th),
        y = r * Math.sin(th);
      var y2 = y * ct - z * st,
        z2 = y * st + z * ct;
      var x2 = x * cp + z2 * sp,
        z3 = -x * sp + z2 * cp;
      pts.push({ x: x2, y: y2, z: z3, sx: cx + x2 * R, sy: cy - y2 * R });
    }
    ctx.lineWidth = Math.max(1, DPR * 0.6);
    var seen = {},
      edges = 0;
    for (k = 0; k < N; k++) {
      var a = pts[k],
        best = [];
      for (var j = 0; j < N; j++) {
        if (j === k) continue;
        var b = pts[j];
        var dd = (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y) + (a.z - b.z) * (a.z - b.z);
        if (best.length < 3) {
          best.push({ j: j, d: dd });
          best.sort(function (p, q) {
            return p.d - q.d;
          });
        } else if (dd < best[2].d) {
          best[2] = { j: j, d: dd };
          best.sort(function (p, q) {
            return p.d - q.d;
          });
        }
      }
      for (var e = 0; e < best.length; e++) {
        var m = pts[best[e].j];
        var key = Math.min(k, best[e].j) + ':' + Math.max(k, best[e].j);
        if (seen[key]) continue;
        seen[key] = 1;
        var depth = (a.z + m.z) / 2;
        if (depth < -0.12) continue;
        edges++;
        ctx.strokeStyle = ink(0.05 + 0.2 * clamp((depth + 1) / 2, 0, 1));
        ctx.beginPath();
        ctx.moveTo(a.sx, a.sy);
        ctx.lineTo(m.sx, m.sy);
        ctx.stroke();
      }
    }
    for (k = 0; k < N; k++) {
      var p = pts[k],
        d01 = clamp((p.z + 1) / 2, 0, 1);
      ctx.fillStyle = ink(0.14 + 0.6 * d01 * d01);
      circle(ctx, p.sx, p.sy, Math.max(0.8, DPR * (0.5 + 1.5 * d01)));
      ctx.fill();
    }
    ctx.strokeStyle = ink(0.14);
    ctx.lineWidth = Math.max(1, DPR * 0.8);
    circle(ctx, cx, cy, R);
    ctx.stroke();
    return ['N <b>' + N + '</b>', '\u03b3 <b>137.508\u00b0</b>', 'edges <b>' + edges + '</b>'];
  }
};

C.harmonic = {
  roman: 'IV',
  group: 'sphere',
  name: 'Harmonic',
  attr: 'Laplace & Legendre, 1782 \u00b7 Wave mechanics',
  def: 'The shapes a sphere makes when it rings. The lines are the nodal set, where the surface stands perfectly still.',
  couple: "The seed chooses the degree l, the order m, and the sphere's orientation.",
  formula: 'Y_lm = P_lm(cos\u03b8) \u00b7 cos(m\u03c6) = 0',
  draw: function (ctx, W, H, rnd, ink, env) {
    var R = Math.min(W, H) * 0.44,
      cx = W / 2,
      cy = H / 2;
    var pairs = [
      [2, 1],
      [3, 2],
      [4, 2],
      [5, 3],
      [3, 1],
      [4, 3],
      [6, 4]
    ];
    var pr = pairs[Math.floor(rnd() * pairs.length)],
      l = pr[0],
      m = pr[1];
    var lat0 = 0.28 + rnd() * 0.5,
      lon0 = rnd() * TAU;
    function f(px, py) {
      var X = (px - cx) / R,
        Y = (cy - py) / R,
        rho = Math.hypot(X, Y);
      if (rho > 1) return NaN;
      var c = Math.asin(Math.min(1, rho)),
        lat,
        lon;
      if (rho < 1e-6) {
        lat = lat0;
        lon = lon0;
      } else {
        lat = Math.asin(
          clamp(Math.cos(c) * Math.sin(lat0) + (Y * Math.sin(c) * Math.cos(lat0)) / rho, -1, 1)
        );
        lon =
          lon0 +
          Math.atan2(X * Math.sin(c), rho * Math.cos(c) * Math.cos(lat0) - Y * Math.sin(c) * Math.sin(lat0));
      }
      return plm(l, m, Math.cos(Math.PI / 2 - lat)) * Math.cos(m * lon);
    }
    /* sign shading, coarse enough to stay cheap at thumbnail size */
    var sg = env.small ? 40 : 64,
      i,
      j;
    var cw = W / sg,
      ch = H / sg;
    ctx.fillStyle = ink(0.055);
    for (j = 0; j < sg; j++) {
      for (i = 0; i < sg; i++) {
        var v = f((i + 0.5) * cw, (j + 0.5) * ch);
        if (isFinite(v) && v > 0) ctx.fillRect(i * cw, j * ch, cw + 1, ch + 1);
      }
    }
    var g = env.small ? 110 : 190;
    isolines(ctx, W, H, g, g, f, [{ v: 0, a: 0.46, w: 0.85 }], ink);
    ctx.strokeStyle = ink(0.35);
    ctx.lineWidth = Math.max(1, DPR);
    circle(ctx, cx, cy, R);
    ctx.stroke();
    return [
      'l <b>' + l + '</b>',
      'm <b>' + m + '</b>',
      'nodal circles <b>' + (l - m) + '</b>',
      'nodal meridians <b>' + m + '</b>'
    ];
  }
};

C.contour = {
  roman: 'V',
  group: 'field',
  name: 'Contour',
  needsField: true,
  attr: 'Cruquius, 1727 \u00b7 Topography',
  def: "Nine equally spaced level sets of the field's own luminance, traced by marching squares. The field draws its own map.",
  couple: 'It reads the pixels. Every seed is a different terrain.',
  formula: 'L(x, y) = c_k',
  draw: function (ctx, W, H, rnd, ink, env) {
    var fd = env.field;
    var lum = smooth(fd.lum, fd.w, fd.h, 2);
    var lo = Infinity,
      hi = -Infinity;
    for (var i = 0; i < lum.length; i++) {
      if (lum[i] < lo) lo = lum[i];
      if (lum[i] > hi) hi = lum[i];
    }
    if (hi - lo < 0.02) return ['flat field'];
    var at = bilinear(lum, fd.w, fd.h);
    var fn = function (px, py) {
      return at((px / W) * (fd.w - 1), (py / H) * (fd.h - 1));
    };
    var N = 9,
      levels = [];
    for (var k = 1; k < N; k++) levels.push({ v: lo + ((hi - lo) * k) / N, a: k % 2 === 0 ? 0.34 : 0.17 });
    isolines(ctx, W, H, env.small ? 150 : 300, env.small ? 96 : 190, fn, levels, ink);
    return [
      'levels <b>' + (N - 1) + '</b>',
      '\u0394L <b>' + (hi - lo).toFixed(2) + '</b>',
      'L max <b>' + hi.toFixed(2) + '</b>'
    ];
  }
};

C.gradient = {
  roman: 'VI',
  group: 'field',
  name: 'Gradient',
  needsField: true,
  attr: 'Cauchy, 1847 \u00b7 Vector calculus',
  def: 'Streamlines of \u2207L, integrated in both directions from a jittered grid. Water would run these lines.',
  couple: "Line weight follows the field's own slope.",
  formula: 'dx/dt = \u2207L(x)',
  draw: function (ctx, W, H, rnd, ink, env) {
    var fd = env.field,
      gw = fd.w,
      gh = fd.h;
    var lum = smooth(fd.lum, gw, gh, 2),
      at = bilinear(lum, gw, gh);
    var sx = W / (gw - 1),
      sy = H / (gh - 1);
    var eps = 0.8;
    function grad(x, y) {
      return [(at(x + eps, y) - at(x - eps, y)) / (2 * eps), (at(x, y + eps) - at(x, y - eps)) / (2 * eps)];
    }
    ctx.lineWidth = Math.max(1, DPR * 0.7);
    ctx.lineCap = 'round';
    var cols = env.small ? 9 : 13,
      rows = env.small ? 6 : 9,
      gmax = 0,
      lines = 0;
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var x0 = ((c + 0.5) / cols + (rnd() - 0.5) * 0.05) * (gw - 1);
        var y0 = ((r + 0.5) / rows + (rnd() - 0.5) * 0.05) * (gh - 1);
        var g0 = grad(x0, y0),
          mag = Math.hypot(g0[0], g0[1]);
        if (mag > gmax) gmax = mag;
        if (mag < 0.0012) continue;
        lines++;
        for (var dir = -1; dir <= 1; dir += 2) {
          var x = x0,
            y = y0;
          ctx.strokeStyle = ink(clamp(mag * 7, 0.07, 0.4));
          ctx.beginPath();
          ctx.moveTo(x * sx, y * sy);
          for (var s = 0; s < (env.small ? 46 : 80); s++) {
            var g1 = grad(x, y),
              m1 = Math.hypot(g1[0], g1[1]);
            if (m1 < 0.0008) break;
            var hx = x + (dir * 0.28 * g1[0]) / m1,
              hy = y + (dir * 0.28 * g1[1]) / m1;
            var g2 = grad(hx, hy),
              m2 = Math.hypot(g2[0], g2[1]) || 1;
            x += (dir * 0.56 * g2[0]) / m2;
            y += (dir * 0.56 * g2[1]) / m2;
            if (x < 0 || y < 0 || x > gw - 1 || y > gh - 1) break;
            ctx.lineTo(x * sx, y * sy);
          }
          ctx.stroke();
          if (dir === 1 && (c + r) % 2 === 0) {
            var ga = grad(x, y),
              ma = Math.hypot(ga[0], ga[1]);
            if (ma > 0.0008) {
              var ux = ga[0] / ma,
                uy = ga[1] / ma,
                hd = Math.max(2.5, DPR * 2.6);
              ctx.fillStyle = ink(0.42);
              ctx.beginPath();
              ctx.moveTo(x * sx + ux * hd * 1.6, y * sy + uy * hd * 1.6);
              ctx.lineTo(x * sx - uy * hd * 0.7, y * sy + ux * hd * 0.7);
              ctx.lineTo(x * sx + uy * hd * 0.7, y * sy - ux * hd * 0.7);
              ctx.closePath();
              ctx.fill();
            }
          }
        }
      }
    }
    ctx.lineCap = 'butt';
    return ['streamlines <b>' + lines * 2 + '</b>', '|\u2207L| max <b>' + gmax.toFixed(3) + '</b>', 'RK2'];
  }
};

C.critical = {
  roman: 'VII',
  group: 'field',
  name: 'Critical',
  needsField: true,
  attr: 'Marston Morse, 1925 \u00b7 Morse theory',
  def: "The only points where the gradient vanishes: peaks, passes and pits. Counting them describes the surface's shape without measuring any of it.",
  couple: 'Each critical value also draws its own contour.',
  formula: '\u2207L = 0,  \u03c7 = M \u2212 S + m',
  draw: function (ctx, W, H, rnd, ink, env) {
    var fd = env.field,
      gw = fd.w,
      gh = fd.h;
    var lum = smooth(fd.lum, gw, gh, 4);
    var ring = [
      [-1, -1],
      [0, -1],
      [1, -1],
      [1, 0],
      [1, 1],
      [0, 1],
      [-1, 1],
      [-1, 0]
    ];
    var pts = [],
      eps = 0.0012,
      x,
      y,
      i;
    for (y = 2; y < gh - 2; y++) {
      for (x = 2; x < gw - 2; x++) {
        var c0 = lum[y * gw + x],
          changes = 0,
          above = 0,
          below = 0;
        var prev = lum[(y + ring[7][1]) * gw + (x + ring[7][0])] - c0;
        for (i = 0; i < 8; i++) {
          var d = lum[(y + ring[i][1]) * gw + (x + ring[i][0])] - c0;
          if (d > 0 !== prev > 0) changes++;
          if (d > eps) above++;
          if (d < -eps) below++;
          prev = d;
        }
        var kind = null;
        if (above === 8) kind = 'min';
        else if (below === 8) kind = 'max';
        else if (changes === 4) kind = 'saddle';
        if (!kind) continue;
        var dup = false;
        for (i = 0; i < pts.length; i++)
          if (Math.hypot(pts[i].x - x, pts[i].y - y) < 3.5) {
            dup = true;
            break;
          }
        if (!dup) pts.push({ x: x, y: y, v: c0, kind: kind });
      }
    }
    var at = bilinear(lum, gw, gh);
    var fn = function (px, py) {
      return at((px / W) * (gw - 1), (py / H) * (gh - 1));
    };
    var levels = pts.slice(0, 14).map(function (p) {
      return { v: p.v, a: 0.11 };
    });
    if (levels.length) isolines(ctx, W, H, env.small ? 140 : 260, env.small ? 90 : 165, fn, levels, ink);

    var sx = W / (gw - 1),
      sy = H / (gh - 1),
      S = Math.min(W, H);
    var rr = Math.max(2.6, S * 0.011);
    ctx.lineWidth = Math.max(1, DPR * 0.9);
    var M = 0,
      m = 0,
      Sd = 0;
    pts.forEach(function (p) {
      var px = p.x * sx,
        py = p.y * sy;
      if (p.kind === 'max') {
        M++;
        ctx.fillStyle = ink(0.7);
        circle(ctx, px, py, rr * 0.42);
        ctx.fill();
        ctx.strokeStyle = ink(0.45);
        circle(ctx, px, py, rr);
        ctx.stroke();
      } else if (p.kind === 'min') {
        m++;
        ctx.strokeStyle = ink(0.55);
        circle(ctx, px, py, rr * 0.8);
        ctx.stroke();
      } else {
        Sd++;
        ctx.strokeStyle = ink(0.6);
        var line = mkLine(ctx),
          q = rr * 0.8;
        line(px - q, py - q, px + q, py + q);
        line(px - q, py + q, px + q, py - q);
      }
    });
    return [
      'maxima <b>' + M + '</b>',
      'saddles <b>' + Sd + '</b>',
      'minima <b>' + m + '</b>',
      '\u03c7 <b>' + (M - Sd + m) + '</b>'
    ];
  }
};

C.potential = {
  roman: 'VIII',
  group: 'field',
  name: 'Potential',
  attr: 'Faraday, 1852 \u00b7 Electrostatics',
  def: "Point charges dropped on the field's own sources. Equipotentials close in loops; lines of force cross them at right angles and never each other.",
  couple: 'The charges sit at the blob centres, alternating sign.',
  formula: 'V = \u03a3 q_i/r_i,  E = \u2212\u2207V',
  draw: function (ctx, W, H, rnd, ink, env) {
    var S = Math.min(W, H);
    var ch = env.blobs.slice(0, 4).map(function (b, i) {
      return { x: clamp(b.x, 0.16, 0.84) * W, y: clamp(b.y, 0.16, 0.84) * H, q: i % 2 === 0 ? 1 : -1 };
    });
    if (ch.length < 2) return ['too few sources'];
    var soft = 0.04 * S;
    function V(x, y) {
      var s = 0;
      for (var i = 0; i < ch.length; i++) {
        var d = Math.max(soft, Math.hypot(x - ch[i].x, y - ch[i].y));
        s += ch[i].q / (d / S);
      }
      return s;
    }
    var mags = [1.6, 2.6, 4.2, 7, 12, 20],
      levels = [];
    mags.forEach(function (v, i) {
      levels.push({ v: v, a: i % 2 ? 0.16 : 0.28 });
      levels.push({ v: -v, a: i % 2 ? 0.16 : 0.28 });
    });
    isolines(ctx, W, H, env.small ? 130 : 240, env.small ? 84 : 152, V, levels, ink);

    var e = 0.9;
    function E(x, y) {
      var gx = (V(x + e, y) - V(x - e, y)) / (2 * e),
        gy = (V(x, y + e) - V(x, y - e)) / (2 * e);
      return [-gx, -gy];
    }
    ctx.lineWidth = Math.max(1, DPR * 0.7);
    ctx.strokeStyle = ink(0.3);
    var nLines = env.small ? 10 : 15,
      steps = env.small ? 380 : 820,
      h = 0.008 * S,
      drawn = 0;
    ch.forEach(function (c) {
      if (c.q < 0) return;
      for (var k = 0; k < nLines; k++) {
        var a = (k / nLines) * TAU + 0.13;
        var x = c.x + Math.cos(a) * soft * 1.1,
          y = c.y + Math.sin(a) * soft * 1.1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        for (var s = 0; s < steps; s++) {
          var v = E(x, y),
            mg = Math.hypot(v[0], v[1]);
          if (!mg) break;
          x += (h * v[0]) / mg;
          y += (h * v[1]) / mg;
          if (x < -0.1 * W || y < -0.1 * H || x > 1.1 * W || y > 1.1 * H) break;
          ctx.lineTo(x, y);
          var stop = false;
          for (var i = 0; i < ch.length; i++) {
            if (ch[i].q < 0 && Math.hypot(x - ch[i].x, y - ch[i].y) < soft * 1.1) stop = true;
          }
          if (stop) break;
        }
        ctx.stroke();
        drawn++;
      }
    });
    var line = mkLine(ctx);
    ch.forEach(function (c) {
      var r = Math.max(3, S * 0.016);
      ctx.strokeStyle = ink(0.6);
      ctx.lineWidth = Math.max(1, DPR);
      circle(ctx, c.x, c.y, r);
      ctx.stroke();
      ctx.strokeStyle = ink(0.85);
      ctx.lineWidth = Math.max(1.2, DPR * 1.2);
      line(c.x - r * 0.5, c.y, c.x + r * 0.5, c.y);
      if (c.q > 0) line(c.x, c.y - r * 0.5, c.x, c.y + r * 0.5);
    });
    var pos = ch.filter(function (c) {
      return c.q > 0;
    }).length;
    return [
      'charges <b>' + ch.length + '</b>',
      '<b>' + pos + '+</b> / <b>' + (ch.length - pos) + '\u2212</b>',
      'field lines <b>' + drawn + '</b>'
    ];
  }
};

C.chladni = {
  roman: 'IX',
  group: 'wave',
  name: 'Chladni',
  attr: 'E. F. F. Chladni, 1787 \u00b7 Acoustics',
  def: 'Bow the edge of a metal plate and sand collects wherever it does not move. Chladni drew these fifty years before anyone could explain them.',
  couple: 'The seed picks the mode numbers n and m.',
  formula: 'cos n\u03c0x cos m\u03c0y \u2212 cos m\u03c0x cos n\u03c0y = 0',
  draw: function (ctx, W, H, rnd, ink, env) {
    var S = Math.min(W, H) * 0.88,
      x0 = (W - S) / 2,
      y0 = (H - S) / 2;
    var pairs = [
      [3, 1],
      [4, 2],
      [5, 2],
      [6, 3],
      [5, 4],
      [7, 3],
      [4, 1],
      [6, 2]
    ];
    var pr = pairs[Math.floor(rnd() * pairs.length)],
      n = pr[0],
      m = pr[1];
    function f(px, py) {
      var u = (px - x0) / S,
        v = (py - y0) / S;
      if (u < 0 || u > 1 || v < 0 || v > 1) return NaN;
      return (
        Math.cos(n * Math.PI * u) * Math.cos(m * Math.PI * v) -
        Math.cos(m * Math.PI * u) * Math.cos(n * Math.PI * v)
      );
    }
    var g = env.small ? 150 : 280;
    isolines(
      ctx,
      W,
      H,
      g,
      Math.round((g * H) / W),
      f,
      [
        { v: 0.6, a: 0.07 },
        { v: -0.6, a: 0.07 },
        { v: 0, a: 0.46, w: 0.9 }
      ],
      ink
    );
    ctx.strokeStyle = ink(0.22);
    ctx.lineWidth = Math.max(1, DPR * 0.9);
    ctx.strokeRect(x0, y0, S, S);
    ctx.fillStyle = ink(0.55);
    circle(ctx, x0 + S / 2, y0 + S / 2, Math.max(2, S * 0.008));
    ctx.fill();
    return ['n <b>' + n + '</b>', 'm <b>' + m + '</b>', 'square plate', 'nodal set f = 0'];
  }
};

C.fringes = {
  roman: 'X',
  group: 'wave',
  name: 'Fringes',
  attr: 'Thomas Young, 1801 \u00b7 Wave optics',
  def: 'Two sources, one wave field. The bright fringes are hyperbolae: the loci where the path difference is a whole number of wavelengths.',
  couple: 'The two brightest blobs become the sources.',
  formula: 'r\u2081 \u2212 r\u2082 = n\u03bb',
  draw: function (ctx, W, H, rnd, ink, env) {
    var S = Math.min(W, H);
    var b = env.blobs;
    var s1 = { x: clamp(b[0].x, 0.2, 0.8) * W, y: clamp(b[0].y, 0.2, 0.8) * H };
    var s2 = { x: clamp(b[1 % b.length].x, 0.2, 0.8) * W, y: clamp(b[1 % b.length].y, 0.2, 0.8) * H };
    var sep = Math.hypot(s1.x - s2.x, s1.y - s2.y);
    if (sep < 0.24 * S) {
      var a = rnd() * TAU,
        push = (0.24 * S - sep) / 2 + 1;
      s1.x -= Math.cos(a) * push;
      s1.y -= Math.sin(a) * push;
      s2.x += Math.cos(a) * push;
      s2.y += Math.sin(a) * push;
      sep = Math.hypot(s1.x - s2.x, s1.y - s2.y);
    }
    var lam = 0.052 * S;
    function g(x, y) {
      return (Math.hypot(x - s1.x, y - s1.y) - Math.hypot(x - s2.x, y - s2.y)) / lam;
    }
    var levels = [];
    for (var k = -7; k <= 7; k++) {
      levels.push({ v: k, a: k === 0 ? 0.36 : 0.28 });
      levels.push({ v: k + 0.5, a: 0.09 });
    }
    isolines(ctx, W, H, env.small ? 150 : 280, env.small ? 96 : 178, g, levels, ink);
    [s1, s2].forEach(function (s) {
      ctx.fillStyle = ink(0.8);
      circle(ctx, s.x, s.y, Math.max(2, S * 0.009));
      ctx.fill();
      ctx.strokeStyle = ink(0.3);
      ctx.lineWidth = Math.max(1, DPR * 0.7);
      for (var i = 1; i <= 2; i++) {
        circle(ctx, s.x, s.y, S * 0.009 * (1 + i * 1.8));
        ctx.stroke();
      }
    });
    return ['\u03bb <b>0.052</b>', 'd <b>' + (sep / S).toFixed(2) + '</b>', 'orders <b>\u00b17</b>'];
  }
};

C.caustic = {
  roman: 'XI',
  group: 'wave',
  name: 'Caustic',
  attr: 'Tschirnhaus, 1682 \u00b7 Geometric optics',
  def: 'Parallel light reflected once inside a circle. Every chord is straight; their envelope is a nephroid, the bright cusp in the bottom of a cup.',
  couple: 'The seed sets the angle the light arrives from.',
  formula: 'd\u2032 = d \u2212 2(d\u00b7n)n',
  draw: function (ctx, W, H, rnd, ink, env) {
    var R = Math.min(W, H) * 0.41,
      cx = W / 2,
      cy = H / 2;
    var a0 = rnd() * TAU,
      d = { x: Math.cos(a0), y: Math.sin(a0) },
      p = { x: -d.y, y: d.x };
    var N = env.small ? 60 : 112;
    var line = mkLine(ctx);
    ctx.lineWidth = Math.max(1, DPR * 0.55);
    for (var i = 0; i < N; i++) {
      var bb = (-0.985 + (1.97 * (i + 0.5)) / N) * R;
      var q = Math.sqrt(Math.max(0, R * R - bb * bb));
      var P1x = cx + bb * p.x - q * d.x,
        P1y = cy + bb * p.y - q * d.y;
      var nx = (P1x - cx) / R,
        ny = (P1y - cy) / R;
      var dot = d.x * nx + d.y * ny;
      var rx = d.x - 2 * dot * nx,
        ry = d.y - 2 * dot * ny;
      var relx = P1x - cx,
        rely = P1y - cy;
      var t = -2 * (relx * rx + rely * ry);
      ctx.strokeStyle = ink(0.045);
      line(P1x - d.x * R * 0.8, P1y - d.y * R * 0.8, P1x, P1y);
      ctx.strokeStyle = ink(0.135);
      line(P1x, P1y, P1x + t * rx, P1y + t * ry);
    }
    ctx.strokeStyle = ink(0.42);
    ctx.lineWidth = Math.max(1, DPR);
    circle(ctx, cx, cy, R);
    ctx.stroke();
    return [
      'rays <b>' + N + '</b>',
      '\u03b8 <b>' + deg(a0) + '\u00b0</b>',
      'envelope <b>nephroid</b>',
      'cusps <b>2</b>'
    ];
  }
};

C.epicycles = {
  roman: 'XII',
  group: 'wave',
  name: 'Epicycles',
  attr: 'Ptolemy c.150, Fourier 1822 \u00b7 Harmonic analysis',
  def: 'Six circles, each riding the rim of the last. Any closed curve is a sum of rotations, and the tip of the chain traces this one.',
  couple: 'The seed sets the phases. The frequencies alternate sign.',
  formula: 'z(t) = \u03a3 c_k exp(i k t)',
  draw: function (ctx, W, H, rnd, ink, env) {
    var cx = W / 2,
      cy = H / 2,
      S = Math.min(W, H);
    var freqs = [1, -2, 3, -4, 5, -6],
      K = freqs.length;
    var amp = [],
      sum = 0,
      i;
    for (i = 0; i < K; i++) {
      amp.push(1 / Math.pow(Math.abs(freqs[i]), 1.15));
      sum += amp[i];
    }
    for (i = 0; i < K; i++) amp[i] = (amp[i] / sum) * S * 0.46;
    var ph = [];
    for (i = 0; i < K; i++) ph.push(rnd() * TAU);
    function z(t) {
      var x = 0,
        y = 0;
      for (var k = 0; k < K; k++) {
        x += amp[k] * Math.cos(freqs[k] * t + ph[k]);
        y += amp[k] * Math.sin(freqs[k] * t + ph[k]);
      }
      return [cx + x, cy + y];
    }
    var Ns = env.small ? 700 : 1500;
    ctx.strokeStyle = ink(0.48);
    ctx.lineWidth = Math.max(1, DPR * 0.85);
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (i = 0; i <= Ns; i++) {
      var q = z((i / Ns) * TAU);
      if (i === 0) ctx.moveTo(q[0], q[1]);
      else ctx.lineTo(q[0], q[1]);
    }
    ctx.closePath();
    ctx.stroke();
    var t0 = rnd() * TAU,
      px = cx,
      py = cy;
    ctx.lineWidth = Math.max(1, DPR * 0.6);
    for (var k = 0; k < K; k++) {
      ctx.strokeStyle = ink(0.13);
      circle(ctx, px, py, amp[k]);
      ctx.stroke();
      var nx = px + amp[k] * Math.cos(freqs[k] * t0 + ph[k]),
        ny = py + amp[k] * Math.sin(freqs[k] * t0 + ph[k]);
      ctx.strokeStyle = ink(0.24);
      mkLine(ctx)(px, py, nx, ny);
      px = nx;
      py = ny;
    }
    ctx.fillStyle = ink(0.8);
    circle(ctx, px, py, Math.max(2, S * 0.009));
    ctx.fill();
    return [
      'K <b>' + K + '</b>',
      'freqs <b>1, \u22122, 3, \u22124, 5, \u22126</b>',
      'samples <b>' + Ns + '</b>'
    ];
  }
};

C.catenary = {
  roman: 'XIII',
  group: 'structure',
  name: 'Catenary',
  needsField: true,
  attr: 'Robert Hooke, 1675 \u00b7 Statics',
  latin: 'Ut pendet continuum flexile, sic stabit contiguum rigidum inversum.',
  def: 'As hangs a flexible chain, so, inverted, stands the rigid arch. The chain is drawn faint below its own arch, and a parabola faintest of all, because it is not the same curve.',
  couple: "The field's mean luminance sets the rise. Two antae carry it.",
  formula: 'y = a cosh(x/a)',
  draw: function (ctx, W, H, rnd, ink, env) {
    var fd = env.field,
      mean = 0,
      i;
    for (i = 0; i < fd.lum.length; i++) mean += fd.lum[i];
    mean /= fd.lum.length;
    var baseY = H * 0.9,
      capY = H * 0.44,
      xl = W * 0.18,
      xr = W * 0.82;
    var cw = Math.min(W, H) * 0.05,
      mid = (xl + xr) / 2,
      L = (xr - xl) / 2;
    var rise = H * (0.16 + 0.16 * clamp(mean * 1.6, 0, 1));
    var a = solveA(L, rise);
    var line = mkLine(ctx);

    ctx.lineWidth = Math.max(1, DPR * 0.6);
    ctx.strokeStyle = ink(0.1);
    ctx.beginPath();
    for (i = 0; i <= 120; i++) {
      var xp = xl + ((xr - xl) * i) / 120,
        u = xp - mid;
      var yp = capY + a * (Math.cosh(L / a) - Math.cosh(u / a));
      if (i === 0) ctx.moveTo(xp, yp);
      else ctx.lineTo(xp, yp);
    }
    ctx.stroke();
    ctx.fillStyle = ink(0.14);
    for (i = 0; i <= 16; i++) {
      var xc = xl + ((xr - xl) * i) / 16,
        uc = xc - mid;
      circle(ctx, xc, capY + a * (Math.cosh(L / a) - Math.cosh(uc / a)), Math.max(1.2, DPR * 1.1));
      ctx.fill();
    }

    ctx.strokeStyle = ink(0.11);
    ctx.setLineDash([DPR * 3, DPR * 4]);
    ctx.beginPath();
    for (i = 0; i <= 120; i++) {
      var xq = xl + ((xr - xl) * i) / 120,
        uq = (xq - mid) / L;
      var yq = capY - rise * (1 - uq * uq);
      if (i === 0) ctx.moveTo(xq, yq);
      else ctx.lineTo(xq, yq);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = ink(0.55);
    ctx.lineWidth = Math.max(1.2, DPR * 1.3);
    ctx.beginPath();
    for (i = 0; i <= 200; i++) {
      var xa = xl + ((xr - xl) * i) / 200,
        ua = xa - mid;
      var ya = capY - a * (Math.cosh(L / a) - Math.cosh(ua / a));
      if (i === 0) ctx.moveTo(xa, ya);
      else ctx.lineTo(xa, ya);
    }
    ctx.stroke();

    [xl, xr].forEach(function (x) {
      ctx.strokeStyle = ink(0.42);
      ctx.lineWidth = Math.max(1, DPR);
      line(x - cw / 2, capY, x - cw / 2, baseY);
      line(x + cw / 2, capY, x + cw / 2, baseY);
      ctx.strokeStyle = ink(0.16);
      ctx.lineWidth = Math.max(1, DPR * 0.6);
      for (var f = 1; f <= 3; f++) {
        var fx = x - cw / 2 + (cw * f) / 4;
        line(fx, capY + cw * 0.5, fx, baseY - cw * 0.4);
      }
      ctx.strokeStyle = ink(0.5);
      ctx.lineWidth = Math.max(1, DPR * 1.1);
      ctx.strokeRect(x - cw * 0.82, capY - cw * 0.34, cw * 1.64, cw * 0.34);
      ctx.strokeRect(x - cw * 0.82, baseY, cw * 1.64, cw * 0.3);
    });
    ctx.strokeStyle = ink(0.3);
    ctx.lineWidth = Math.max(1, DPR * 0.7);
    line(0, baseY + cw * 0.3, W, baseY + cw * 0.3);
    return [
      'a <b>' + (a / L).toFixed(2) + 'L</b>',
      'rise/span <b>' + (rise / (2 * L)).toFixed(2) + '</b>',
      'mean L <b>' + mean.toFixed(2) + '</b>'
    ];
  }
};

C.apollonian = {
  roman: 'XIV',
  group: 'structure',
  name: 'Apollonian',
  attr: 'Apollonius c.200 BC, Descartes 1643 \u00b7 Circle packing',
  def: 'Three mutually tangent circles determine a fourth. Do it again in every gap they leave and the gaps never close.',
  couple: 'The seed rotates the gasket inside the field.',
  formula: '(\u03a3k)\u00b2 = 2\u03a3k\u00b2',
  draw: function (ctx, W, H, rnd, ink, env) {
    var R = Math.min(W, H) * 0.45,
      cx = W / 2,
      cy = H / 2,
      rot = rnd() * TAU;
    var minR = env.small ? 0.018 : 0.0055,
      CAP = env.small ? 180 : 620;
    var base = [
      { k: -1, x: 0, y: 0 },
      { k: 2, x: -0.5, y: 0 },
      { k: 2, x: 0.5, y: 0 },
      { k: 3, x: 0, y: 2 / 3 }
    ];
    var out = [],
      seen = {},
      kmax = 0;
    function key(c) {
      return c.x.toFixed(4) + ',' + c.y.toFixed(4) + ',' + c.k.toFixed(3);
    }
    function push(c) {
      var kk = key(c);
      if (seen[kk]) return false;
      seen[kk] = 1;
      out.push(c);
      if (c.k > kmax) kmax = c.k;
      return true;
    }
    base.forEach(push);
    var queue = [base],
      head = 0,
      guard = 0;
    while (head < queue.length && out.length < CAP && guard++ < 6000) {
      var q = queue[head++];
      for (var i = 0; i < 4; i++) {
        var o = [],
          j;
        for (j = 0; j < 4; j++) if (j !== i) o.push(q[j]);
        var k = 2 * (o[0].k + o[1].k + o[2].k) - q[i].k;
        if (k <= 0) continue;
        var r = 1 / k;
        if (r < minR) continue;
        var x = (2 * (o[0].k * o[0].x + o[1].k * o[1].x + o[2].k * o[2].x) - q[i].k * q[i].x) / k;
        var y = (2 * (o[0].k * o[0].y + o[1].k * o[1].y + o[2].k * o[2].y) - q[i].k * q[i].y) / k;
        if (Math.hypot(x, y) + r > 1.0005) continue;
        var c = { k: k, x: x, y: y };
        if (push(c)) queue.push([o[0], o[1], o[2], c]);
      }
    }
    var cs = Math.cos(rot),
      sn = Math.sin(rot);
    ctx.lineWidth = Math.max(1, DPR * 0.7);
    out.forEach(function (c) {
      var r = 1 / Math.abs(c.k);
      var X = cx + (c.x * cs - c.y * sn) * R,
        Y = cy + (c.x * sn + c.y * cs) * R;
      ctx.strokeStyle = ink(c.k < 0 ? 0.45 : clamp(0.1 + r * 1.5, 0.1, 0.44));
      circle(ctx, X, Y, r * R);
      ctx.stroke();
    });
    return [
      'circles <b>' + out.length + '</b>',
      'k max <b>' + Math.round(kmax) + '</b>',
      'r min <b>' + minR.toFixed(3) + 'R</b>'
    ];
  }
};

C.voronoi = {
  roman: 'XV',
  group: 'structure',
  name: 'Voronoi',
  attr: 'Dirichlet 1850, Voronoi 1908 \u00b7 Computational geometry',
  def: 'Every point belongs to the site nearest it. The faint dual is the Delaunay triangulation: the territory and the network are one object, seen twice.',
  couple: "The sites are the field's blob centres, filled out to twenty.",
  formula: 'V(p_i) = { x : |x\u2212p_i| \u2264 |x\u2212p_j| }',
  draw: function (ctx, W, H, rnd, ink, env) {
    var sites = env.blobs.map(function (b) {
      return { x: b.x * W, y: b.y * H };
    });
    var n0 = sites.length;
    while (sites.length < 20) {
      sites.push({ x: (0.06 + rnd() * 0.88) * W, y: (0.06 + rnd() * 0.88) * H });
    }
    var n = sites.length,
      tris = [],
      i,
      j,
      k,
      p;
    for (i = 0; i < n; i++)
      for (j = i + 1; j < n; j++)
        for (k = j + 1; k < n; k++) {
          var A = sites[i],
            B = sites[j],
            Cc = sites[k];
          var dd = 2 * (A.x * (B.y - Cc.y) + B.x * (Cc.y - A.y) + Cc.x * (A.y - B.y));
          if (Math.abs(dd) < 1e-6) continue;
          var a2 = A.x * A.x + A.y * A.y,
            b2 = B.x * B.x + B.y * B.y,
            c2 = Cc.x * Cc.x + Cc.y * Cc.y;
          var ux = (a2 * (B.y - Cc.y) + b2 * (Cc.y - A.y) + c2 * (A.y - B.y)) / dd;
          var uy = (a2 * (Cc.x - B.x) + b2 * (A.x - Cc.x) + c2 * (B.x - A.x)) / dd;
          var rad = Math.hypot(A.x - ux, A.y - uy),
            ok = true;
          for (p = 0; p < n; p++) {
            if (p === i || p === j || p === k) continue;
            if (Math.hypot(sites[p].x - ux, sites[p].y - uy) < rad - 1e-6) {
              ok = false;
              break;
            }
          }
          if (ok) tris.push({ i: i, j: j, k: k, cx: ux, cy: uy });
        }
    var line = mkLine(ctx);
    ctx.lineWidth = Math.max(1, DPR * 0.6);
    ctx.strokeStyle = ink(0.12);
    var edges = {};
    tris.forEach(function (t, ti) {
      [
        [t.i, t.j, t.k],
        [t.j, t.k, t.i],
        [t.k, t.i, t.j]
      ].forEach(function (e) {
        var a = Math.min(e[0], e[1]),
          b = Math.max(e[0], e[1]),
          kk = a + ':' + b;
        if (!edges[kk]) edges[kk] = { a: a, b: b, tris: [], opp: [] };
        edges[kk].tris.push(ti);
        edges[kk].opp.push(e[2]);
      });
    });
    Object.keys(edges).forEach(function (kk) {
      var e = edges[kk];
      line(sites[e.a].x, sites[e.a].y, sites[e.b].x, sites[e.b].y);
    });

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();
    ctx.lineWidth = Math.max(1, DPR * 0.85);
    ctx.strokeStyle = ink(0.42);
    var far = Math.hypot(W, H) * 2,
      vEdges = 0;
    Object.keys(edges).forEach(function (kk) {
      var e = edges[kk];
      if (e.tris.length === 2) {
        var t1 = tris[e.tris[0]],
          t2 = tris[e.tris[1]];
        line(t1.cx, t1.cy, t2.cx, t2.cy);
        vEdges++;
      } else if (e.tris.length === 1) {
        var t = tris[e.tris[0]],
          A = sites[e.a],
          B = sites[e.b],
          O = sites[e.opp[0]];
        var mx = (A.x + B.x) / 2,
          my = (A.y + B.y) / 2;
        var nx = -(B.y - A.y),
          ny = B.x - A.x,
          len = Math.hypot(nx, ny) || 1;
        nx /= len;
        ny /= len;
        if ((O.x - mx) * nx + (O.y - my) * ny > 0) {
          nx = -nx;
          ny = -ny;
        }
        line(t.cx, t.cy, t.cx + nx * far, t.cy + ny * far);
        vEdges++;
      }
    });
    ctx.restore();

    var S = Math.min(W, H);
    sites.forEach(function (s, i2) {
      ctx.fillStyle = ink(i2 < n0 ? 0.72 : 0.4);
      circle(ctx, s.x, s.y, Math.max(1.6, S * (i2 < n0 ? 0.008 : 0.005)));
      ctx.fill();
    });
    return [
      'sites <b>' + n + '</b>',
      'sources <b>' + n0 + '</b>',
      'triangles <b>' + tris.length + '</b>',
      'cell edges <b>' + vEdges + '</b>'
    ];
  }
};

C.penrose = {
  roman: 'XVI',
  group: 'structure',
  name: 'Penrose',
  attr: 'Roger Penrose, 1974 \u00b7 Aperiodic order',
  def: 'Two rhombs, five-fold symmetry, and a plane that never repeats itself. Order without period, which crystallography said could not exist.',
  couple: 'The seed rotates the wheel the subdivision starts from.',
  formula: '\u03c6 = (1+\u221a5)/2',
  draw: function (ctx, W, H, rnd, ink, env) {
    var R = Math.hypot(W, H) * 0.52,
      cx = W / 2,
      cy = H / 2,
      rot = rnd() * TAU;
    function cis(a) {
      return { x: Math.cos(a), y: Math.sin(a) };
    }
    function add(a, b) {
      return { x: a.x + b.x, y: a.y + b.y };
    }
    function sub(a, b) {
      return { x: a.x - b.x, y: a.y - b.y };
    }
    function mul(a, s) {
      return { x: a.x * s, y: a.y * s };
    }
    var tris = [],
      i;
    for (i = 0; i < 10; i++) {
      var B = cis(((2 * i - 1) * Math.PI) / 10),
        Cc = cis(((2 * i + 1) * Math.PI) / 10);
      if (i % 2 === 0) {
        var tmp = B;
        B = Cc;
        Cc = tmp;
      }
      tris.push([0, { x: 0, y: 0 }, B, Cc]);
    }
    var levels = env.small ? 4 : 6;
    for (var g = 0; g < levels; g++) {
      var next = [];
      for (i = 0; i < tris.length; i++) {
        var t = tris[i],
          col = t[0],
          A = t[1],
          Bp = t[2],
          Cp = t[3];
        if (col === 0) {
          var P = add(A, mul(sub(Bp, A), 1 / PHI));
          next.push([0, Cp, P, Bp], [1, P, Cp, A]);
        } else {
          var Q = add(Bp, mul(sub(A, Bp), 1 / PHI));
          var Rr = add(Bp, mul(sub(Cp, Bp), 1 / PHI));
          next.push([1, Rr, Cp, A], [1, Q, Rr, Bp], [0, Rr, Q, A]);
        }
      }
      tris = next;
    }
    var cs = Math.cos(rot),
      sn = Math.sin(rot);
    function S(p) {
      return { x: cx + (p.x * cs - p.y * sn) * R, y: cy + (p.x * sn + p.y * cs) * R };
    }
    ctx.lineWidth = Math.max(1, DPR * 0.6);
    ctx.lineJoin = 'round';
    [0, 1].forEach(function (col) {
      ctx.strokeStyle = ink(col === 0 ? 0.26 : 0.13);
      ctx.beginPath();
      tris.forEach(function (t) {
        if (t[0] !== col) return;
        var a = S(t[1]),
          b = S(t[2]),
          c = S(t[3]);
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.lineTo(c.x, c.y);
      });
      ctx.stroke();
    });
    return [
      'rhombs <b>' + tris.length + '</b>',
      'levels <b>' + levels + '</b>',
      '\u03c6 <b>1.61803</b>',
      'aperiodic'
    ];
  }
};

/* ---- five studies promoted from round 3, redrawn as static plates ---- */

C.meridians = {
  roman: 'XVII',
  group: 'sphere',
  name: 'Meridians',
  attr: 'Eratosthenes, c.240 BC · Geodesy',
  def: 'The sphere measured, seen flat. Meridians run the full height of the plate and pinch toward a pole below the frame; the parallels sag across them like slack survey lines.',
  couple: "The seed sets each meridian's pinch and each parallel's sag.",
  formula: 'λ = const',
  draw: function (ctx, W, H, rnd, ink) {
    var n = 17,
      i,
      pinchSum = 0;
    ctx.lineWidth = Math.max(1, DPR * 0.7);
    for (i = 0; i <= n; i++) {
      var x0 = (W * i) / n;
      var pinch = 0.42 + rnd() * 0.1;
      pinchSum += pinch;
      var xm = W / 2 + (x0 - W / 2) * pinch;
      ctx.strokeStyle = ink(0.28);
      ctx.beginPath();
      ctx.moveTo(x0, -2);
      ctx.bezierCurveTo(x0, H * 0.3, xm, H * 0.55, xm, H + 2);
      ctx.stroke();
    }
    for (var j = 1; j < 7; j++) {
      var y0 = (H * j) / 7,
        sag = (rnd() - 0.3) * H * 0.12;
      ctx.strokeStyle = ink(0.16);
      ctx.beginPath();
      ctx.moveTo(-2, y0);
      ctx.bezierCurveTo(W * 0.33, y0 + sag, W * 0.66, y0 + sag, W + 2, y0);
      ctx.stroke();
    }
    return [
      'meridians <b>' + (n + 1) + '</b>',
      'parallels <b>6</b>',
      'pinch <b>' + (pinchSum / (n + 1)).toFixed(2) + '</b>'
    ];
  }
};

C.latitudes = {
  roman: 'XVIII',
  group: 'sphere',
  name: 'Latitudes',
  attr: 'Ptolemy, c.150 · Geography',
  def: 'The sphere sliced. Every parallel is a circle of constant latitude, and seen edge-on the stack of circles becomes a stack of ellipses inside one shared outline.',
  couple: 'The seed sets the squash — how far the eye sits above the equator.',
  formula: 'φ = const',
  draw: function (ctx, W, H, rnd, ink) {
    var cx = W / 2,
      cy = H / 2,
      R = Math.min(W, H) * 0.42;
    ctx.lineWidth = Math.max(1, DPR * 0.8);
    ctx.strokeStyle = ink(0.4);
    circle(ctx, cx, cy, R);
    ctx.stroke();
    var n = 13,
      squash = 0.26 + rnd() * 0.12;
    for (var i = 1; i < n; i++) {
      var t = (i / n) * 2 - 1;
      var y = cy + t * R;
      var rx = Math.sqrt(Math.max(0, 1 - t * t)) * R;
      ctx.strokeStyle = ink(0.16 + Math.abs(t) * 0.12);
      ctx.beginPath();
      ctx.ellipse(cx, y, rx, rx * squash, 0, 0, TAU);
      ctx.stroke();
    }
    return [
      'parallels <b>' + (n - 1) + '</b>',
      'squash <b>' + squash.toFixed(2) + '</b>',
      'tilt <b>' + deg(Math.asin(squash)) + '°</b>'
    ];
  }
};

C.orbits = {
  roman: 'XIX',
  group: 'sphere',
  name: 'Orbits',
  attr: 'Kepler, 1609 · Celestial mechanics',
  def: 'Paths around the sphere — the study of motion. Each orbit is an inclined ellipse around the central body, and each carries one satellite, frozen where the seed left it.',
  couple: 'The seed sets the count, the tilts, and where each satellite sits.',
  formula: 'r = a(1 − e²)/(1 + e cosθ)',
  draw: function (ctx, W, H, rnd, ink) {
    var cx = W / 2,
      cy = H / 2;
    ctx.lineWidth = Math.max(1, DPR * 0.8);
    ctx.strokeStyle = ink(0.42);
    circle(ctx, cx, cy, H * 0.24);
    ctx.stroke();
    var n = 3 + Math.floor(rnd() * 2),
      eSum = 0;
    for (var i = 0; i < n; i++) {
      var tilt = (rnd() - 0.5) * Math.PI * 0.7,
        rx = H * (0.34 + rnd() * 0.14);
      var ry = rx * (0.22 + rnd() * 0.14);
      eSum += Math.sqrt(1 - (ry * ry) / (rx * rx));
      ctx.strokeStyle = ink(0.16 + rnd() * 0.14);
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, tilt, 0, TAU);
      ctx.stroke();
      var th = rnd() * TAU;
      var px = cx + Math.cos(th) * rx * Math.cos(tilt) - Math.sin(th) * ry * Math.sin(tilt);
      var py = cy + Math.cos(th) * rx * Math.sin(tilt) + Math.sin(th) * ry * Math.cos(tilt);
      ctx.fillStyle = ink(0.75);
      circle(ctx, px, py, Math.max(2, H * 0.008));
      ctx.fill();
    }
    return ['orbits <b>' + n + '</b>', 'e mean <b>' + (eSum / n).toFixed(2) + '</b>', 'body R <b>0.24H</b>'];
  }
};

C.interference = {
  roman: 'XX',
  group: 'wave',
  name: 'Interference',
  attr: 'Lord Rayleigh, 1874 · Wave optics',
  def: 'Two sources, one moiré. Each emits nothing but concentric circles at a fixed spacing; wherever the two families cross, the beat between them becomes visible.',
  couple: 'The seed places the two sources and phases their rings.',
  formula: 'cos(k r₁) + cos(k r₂)',
  draw: function (ctx, W, H, rnd, ink) {
    ctx.lineWidth = Math.max(1, DPR * 0.6);
    var sources = [
      { x: W * (0.3 + rnd() * 0.1), y: H * (0.4 + rnd() * 0.2) },
      { x: W * (0.62 + rnd() * 0.1), y: H * (0.4 + rnd() * 0.2) }
    ];
    var spacing = H * 0.035,
      frac = rnd(),
      total = 0;
    sources.forEach(function (s, si) {
      var rings = Math.ceil(Math.hypot(W, H) / spacing) + 1;
      total += rings;
      for (var i = 0; i < rings; i++) {
        var r = (i + frac) * spacing;
        ctx.strokeStyle = ink(si === 0 ? 0.2 : 0.14);
        circle(ctx, s.x, s.y, r);
        ctx.stroke();
      }
    });
    sources.forEach(function (s) {
      ctx.fillStyle = ink(0.7);
      circle(ctx, s.x, s.y, Math.max(2, H * 0.009));
      ctx.fill();
    });
    var d = Math.hypot(sources[0].x - sources[1].x, sources[0].y - sources[1].y);
    return [
      'sources <b>2</b>',
      'rings <b>' + total + '</b>',
      'd <b>' + (d / Math.min(W, H)).toFixed(2) + '</b>',
      'λ <b>0.035H</b>'
    ];
  }
};

C.graph = {
  roman: 'XXI',
  group: 'structure',
  name: 'Graph',
  attr: 'Euler, 1736 · Graph theory',
  def: 'What we actually build: agents, edges, handoffs. Each node reaches for its two nearest neighbours, the connections bow slightly, and every node keeps a halo of its own reach.',
  couple: 'The seed scatters the nodes and bends every edge.',
  formula: 'G = (V, E)',
  draw: function (ctx, W, H, rnd, ink) {
    var n = 14,
      nodes = [],
      i;
    for (i = 0; i < n; i++) {
      nodes.push({
        x: W * (0.08 + rnd() * 0.84),
        y: H * (0.12 + rnd() * 0.76),
        r: Math.max(2, H * (0.006 + rnd() * 0.012))
      });
    }
    ctx.lineWidth = Math.max(1, DPR * 0.7);
    var seen = {},
      edges = 0;
    nodes.forEach(function (a, ai) {
      var dists = nodes
        .map(function (b, j) {
          return { j: j, d: Math.hypot(a.x - b.x, a.y - b.y) };
        })
        .filter(function (o) {
          return o.j !== ai;
        })
        .sort(function (p, q) {
          return p.d - q.d;
        });
      dists.slice(0, 2).forEach(function (o) {
        var key = Math.min(ai, o.j) + ':' + Math.max(ai, o.j);
        if (!seen[key]) {
          seen[key] = 1;
          edges++;
        }
        var b = nodes[o.j];
        ctx.strokeStyle = ink(0.14 + rnd() * 0.12);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        var mx = (a.x + b.x) / 2 + (rnd() - 0.5) * H * 0.06;
        var my = (a.y + b.y) / 2 + (rnd() - 0.5) * H * 0.06;
        ctx.quadraticCurveTo(mx, my, b.x, b.y);
        ctx.stroke();
      });
    });
    nodes.forEach(function (a) {
      ctx.fillStyle = ink(0.62);
      circle(ctx, a.x, a.y, a.r);
      ctx.fill();
      ctx.strokeStyle = ink(0.3);
      ctx.lineWidth = Math.max(1, DPR * 0.6);
      circle(ctx, a.x, a.y, a.r * 2.6);
      ctx.stroke();
    });
    return ['nodes <b>' + n + '</b>', 'edges <b>' + edges + '</b>', 'degree <b>≥ 2</b>'];
  }
};

var KEYS = [
  'graticule',
  'wulff',
  'lattice',
  'harmonic',
  'contour',
  'gradient',
  'critical',
  'potential',
  'chladni',
  'fringes',
  'caustic',
  'epicycles',
  'catenary',
  'apollonian',
  'voronoi',
  'penrose',
  'meridians',
  'latitudes',
  'orbits',
  'interference',
  'graph'
];

/* How each construction is coupled to the seeded world it sits on. */
var READS = {
  graticule: 'Takes from the seed:',
  wulff: 'Takes from the seed:',
  lattice: 'Takes from the seed:',
  harmonic: 'Takes from the seed:',
  contour: 'Reads the field:',
  gradient: 'Reads the field:',
  critical: 'Reads the field:',
  potential: 'Reads the sources:',
  chladni: 'Takes from the seed:',
  fringes: 'Reads the sources:',
  caustic: 'Takes from the seed:',
  epicycles: 'Takes from the seed:',
  catenary: 'Reads the field:',
  apollonian: 'Takes from the seed:',
  voronoi: 'Reads the sources:',
  penrose: 'Takes from the seed:',
  meridians: 'Takes from the seed:',
  latitudes: 'Takes from the seed:',
  orbits: 'Takes from the seed:',
  interference: 'Takes from the seed:',
  graph: 'Takes from the seed:'
};

/* ================= field engine ================= */
function buildBlobs(seed, palName) {
  var pal = PALETTES[palName],
    rnd = mulberry32(seed);
  var count = 7 + Math.floor(rnd() * 4),
    blobs = [];
  for (var i = 0; i < count; i++) {
    blobs.push({
      color: pal.hues[Math.floor(rnd() * pal.hues.length)],
      x: rnd(),
      y: rnd(),
      r: 0.22 + rnd() * 0.4,
      alpha: 0.75 + rnd() * 0.25,
      px: 0.5 + rnd() * 1.5,
      py: 0.5 + rnd() * 1.5,
      ax: 0.02 + rnd() * 0.05,
      ay: 0.02 + rnd() * 0.05,
      ph: rnd() * TAU
    });
  }
  return blobs;
}

function renderLow(blobs, palName, W, H, t) {
  var pal = PALETTES[palName];
  var lw = LOW_W,
    lh = Math.max(8, Math.round((LOW_W * H) / W));
  var low = document.createElement('canvas');
  low.width = lw;
  low.height = lh;
  var c = low.getContext('2d', { willReadFrequently: true });
  c.fillStyle = pal.base;
  c.fillRect(0, 0, lw, lh);
  blobs.forEach(function (b) {
    var x = (b.x + Math.sin(t * b.px + b.ph) * b.ax) * lw;
    var y = (b.y + Math.cos(t * b.py + b.ph) * b.ay) * lh;
    var r = b.r * lw;
    var g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, b.color);
    g.addColorStop(1, b.color.slice(0, 7) + '00');
    c.fillStyle = g;
    c.globalAlpha = b.alpha;
    c.beginPath();
    c.arc(x, y, r, 0, TAU);
    c.fill();
    c.globalAlpha = 1;
  });
  return low;
}

function lumField(low) {
  var c = low.getContext('2d', { willReadFrequently: true });
  var w = low.width,
    h = low.height;
  var d = c.getImageData(0, 0, w, h).data;
  var lum = new Float32Array(w * h);
  for (var i = 0, p = 0; i < d.length; i += 4, p++) {
    lum[p] = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
  }
  return { w: w, h: h, lum: lum };
}

/* Draws one full field. Returns the construction's own measurements. */
function paint(ctx, W, H, s, t, grainOffset) {
  var pal = PALETTES[s.palette];
  var rnd = mulberry32(s.seed);
  var low = renderLow(s.blobs, s.palette, W, H, t || 0);

  ctx.clearRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.filter = 'blur(' + Math.max(4, Math.round(W * 0.018)) + 'px)';
  ctx.drawImage(low, -W * 0.06, -H * 0.06, W * 1.12, H * 1.12);
  ctx.filter = 'none';

  var meta = null;
  var con = s.linework ? C[s.study] : null;
  if (con) {
    var inkRGB = pal.light ? '28,25,21' : '247,244,236';
    var boost = s.inkBoost || 1;
    var ink = function (a) {
      return 'rgba(' + inkRGB + ',' + Math.min(0.96, a * boost).toFixed(3) + ')';
    };
    ctx.save();
    meta = con.draw(ctx, W, H, rnd, ink, {
      field: con.needsField ? lumField(low) : null,
      blobs: s.blobs,
      small: W < 560
    });
    ctx.restore();
  }

  var grain = GRAINS[s.grain];
  if (grain && s.grainAlpha > 0) {
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = s.grainAlpha;
    var pattern = ctx.createPattern(grain.tile, 'repeat');
    var m = new DOMMatrix();
    m = m.translate(grainOffset ? grainOffset.x : 0, grainOffset ? grainOffset.y : 0).scale(s.grainSize);
    pattern.setTransform(m);
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
  return meta;
}

function sizeTo(canvas, ratio) {
  var r = canvas.getBoundingClientRect();
  var W = Math.max(2, Math.round(r.width * ratio));
  var H = Math.max(2, Math.round(r.height * ratio));
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W;
    canvas.height = H;
  }
  return { W: W, H: H };
}

/* ================= module exports (added at extraction) ================= */
export {
  TAU,
  PHI,
  GOLDEN,
  DPR,
  THUMB_DPR,
  LOW_W,
  clamp,
  mulberry32,
  newSeed,
  pad,
  deg,
  PALETTES,
  PAL_KEYS,
  noiseTile,
  GRAINS,
  GRAIN_KEYS,
  FONTS,
  FONT_KEYS,
  JOINS,
  JOIN_LABEL,
  C,
  buildBlobs,
  renderLow,
  lumField,
  paint,
  sizeTo
};
