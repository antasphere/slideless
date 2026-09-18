// @ts-nocheck
/* The brand's hover pattern cards, copied verbatim from company/brand
   src/lib/animations.js (itself the twin of the website's patterns.ts). Do not
   edit here: fix it in the brand console and re-copy. ts-nocheck because the
   dashboard runs checkJs. */
/* =====================================================================
   The animation library — the brand's hover pattern cards, gathered.

   Two sources, both ported verbatim:
   - antasphere-website `apps/website/src/brand/patterns.ts` (the home
     trio / products / services / partner cards), minus the TypeScript;
     change those there and here together.
   - the round-6 console deck on slideless ("The Console", rebranding
     seed), section CARD_PATTERNS: the original sixteen-card hand the
     website's set was standardised from. Thirteen live here; petal,
     plus and cog stay behind as ancestors of Bloom, Cross and Gear.

   The website has since ported eleven of the thirteen back into its
   patterns.ts (all but portico and chevron), so EVERY draw shared with
   the site now changes there and here together; the site assigns one
   draw per card with no repeats across its pages.

   Every animation lives on ONE shared system so any two cards read as
   one family: the same 5 x 3 grid, the same resting size (0.40 of the
   cell), the same resting and hovered ink (0.30 -> 0.44), the same turn
   rate (0.35), the same breathe (sin at 1.3, 3%), and on every card
   either a nested inner form or a hidden detail fading in on hover.
   Every bloom reaches past the half-cell line, so transformed
   neighbours touch and slightly overlap. Only the shape and what it
   blooms into differ.

   One deliberate difference from the website: there a card's ground is
   its own four-hue tile palette ("the pattern IS the card's identity");
   here every card grounds on the ACTIVE THEME's field, because in the
   console the theme is the variable under audition and the animation is
   the only thing a card is allowed to vary.

   The draw contract: draw(ctx, W, H, u) with u = { t, hover, seed, rnd,
   DPR, TAU, lerp, ease, ink } — t in seconds, hover eased 0..1, rnd a
   fresh seeded PRNG per frame, ink(alpha) the field's ink color.
   ===================================================================== */

/* ── The shared constants ─────────────────────────────────────────────── */

const GRID = { cols: 5, rows: 3 };
const SIZE = 0.4; /* of the cell's short side */
const TURN = 0.35; /* radians per second while hovered */
const REST_A = 0.3;
const HOVER_A = 0.44;
const INNER_A = 0.24;
const BREATHE = (t, ph, hover) => 1 + Math.sin(t * 1.3 + ph) * 0.03 * hover;

const eachCell = (W, H, u, fn) => {
  const cellW = W / GRID.cols;
  const cellH = H / GRID.rows;
  const base = Math.min(cellW, cellH) * SIZE;
  for (let j = -1; j <= GRID.rows; j++)
    for (let i = -1; i <= GRID.cols; i++) {
      const ph = u.rnd() * u.TAU;
      fn(
        {
          cx: (i + 0.5) * cellW,
          cy: (j + 0.5) * cellH,
          ph,
          parity: (i + j) & 1 ? 1 : -1,
        },
        base * BREATHE(u.t, ph, u.hover),
      );
    }
};

const setStroke = (ctx, u) => {
  ctx.lineWidth = Math.max(1, u.DPR * 0.9);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
};

/** A closed polygon with rounded corners, from the deck's plus card. */
const roundPath = (ctx, pts, rad) => {
  const n = pts.length;
  for (let m = 0; m < n; m++) {
    const p0 = pts[(m - 1 + n) % n];
    const p1 = pts[m];
    const p2 = pts[(m + 1) % n];
    const v1x = p0.x - p1.x;
    const v1y = p0.y - p1.y;
    const v2x = p2.x - p1.x;
    const v2y = p2.y - p1.y;
    const l1 = Math.hypot(v1x, v1y);
    const l2 = Math.hypot(v2x, v2y);
    const r = Math.min(rad, l1 * 0.5, l2 * 0.5);
    const a1x = p1.x + (v1x / l1) * r;
    const a1y = p1.y + (v1y / l1) * r;
    const a2x = p1.x + (v2x / l2) * r;
    const a2y = p1.y + (v2y / l2) * r;
    if (m === 0) ctx.moveTo(a1x, a1y);
    else ctx.lineTo(a1x, a1y);
    ctx.quadraticCurveTo(p1.x, p1.y, a2x, a2y);
  }
  ctx.closePath();
};

const rectPts = (cx, cy, hw, hh) => [
  { x: cx - hw, y: cy - hh },
  { x: cx + hw, y: cy - hh },
  { x: cx + hw, y: cy + hh },
  { x: cx - hw, y: cy + hh },
];

/* ── The draws ────────────────────────────────────────────────────────── */

/* SQUARE · CROSS */
const crosses = (ctx, W, H, u) => {
  setStroke(ctx, u);
  const alpha = u.lerp(REST_A, HOVER_A, u.hover);
  const innerA = u.ease(u.hover) * INNER_A;
  const grow = u.lerp(1.0, 1.5, u.hover); /* arms cross the cell edge */
  const wFrac = u.lerp(0.94, 0.34, u.hover); /* square -> cross */
  const rrFrac = u.lerp(0.28, 0.14, u.hover);
  const crossPts = (R, w) => [
    { x: -w, y: -R },
    { x: w, y: -R },
    { x: w, y: -w },
    { x: R, y: -w },
    { x: R, y: w },
    { x: w, y: w },
    { x: w, y: R },
    { x: -w, y: R },
    { x: -w, y: w },
    { x: -R, y: w },
    { x: -R, y: -w },
    { x: -w, y: -w },
  ];
  eachCell(W, H, u, (c, R) => {
    const Rb = R * grow;
    const rot = u.ease(u.hover) * (u.TAU / 8) + u.t * TURN * u.hover;
    const wig = Math.sin(u.t * 0.6 + c.ph) * 0.05 * u.hover;
    ctx.save();
    ctx.translate(c.cx, c.cy);
    ctx.rotate(rot + wig);
    ctx.beginPath();
    roundPath(ctx, crossPts(Rb, wFrac * Rb), rrFrac * Rb);
    ctx.strokeStyle = u.ink(alpha);
    ctx.stroke();
    if (innerA > 0.005) {
      ctx.beginPath();
      roundPath(ctx, crossPts(Rb * 0.5, wFrac * Rb * 0.5), rrFrac * Rb * 0.5);
      ctx.strokeStyle = u.ink(innerA);
      ctx.stroke();
    }
    ctx.restore();
  });
};

/* CIRCLE · BLOOM */
const blooms = (ctx, W, H, u) => {
  setStroke(ctx, u);
  const steps = 128;
  const amp = u.lerp(0.0, 0.46, u.hover);
  const alpha = u.lerp(REST_A, HOVER_A, u.hover);
  const innerA = u.ease(u.hover) * INNER_A;
  eachCell(W, H, u, (c, R) => {
    const spin = (u.t * TURN + c.ph) * u.hover;
    const lobe = (radius) => {
      ctx.beginPath();
      for (let s = 0; s <= steps; s++) {
        const th = (s / steps) * u.TAU;
        const pr = radius * (1 + amp * Math.cos(4 * (th - spin)));
        const x = c.cx + pr * Math.cos(th);
        const y = c.cy + pr * Math.sin(th);
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    };
    ctx.strokeStyle = u.ink(alpha);
    lobe(R);
    if (innerA > 0.005) {
      ctx.strokeStyle = u.ink(innerA);
      lobe(R * 0.5);
    }
  });
};

/* HEXAGON · GEAR */
const gears = (ctx, W, H, u) => {
  setStroke(ctx, u);
  const steps = 240; /* 8 teeth need finer sampling than a star would */
  const teeth = 8;
  const toothAmp = 0.13;
  const alpha = u.lerp(REST_A, HOVER_A, u.hover);
  const innerA = u.ease(u.hover) * INNER_A;
  const grow = u.lerp(1.0, 1.32, u.hover); /* teeth cross the cell edge */
  const mix = u.ease(u.hover); /* hexagon -> gear */
  /* Polar hexagon, unit outer radius, and a polar gear of mean radius 1:
   * a tanh-squared sine, so the teeth are flat-topped rather than wavy. */
  const hexR = (th) => {
    const a = ((th % (u.TAU / 6)) + u.TAU / 6) % (u.TAU / 6);
    return Math.cos(Math.PI / 6) / Math.cos(a - Math.PI / 6);
  };
  const gearR = (th) => 1 + toothAmp * (Math.tanh(4 * Math.sin(teeth * th)) / Math.tanh(4));
  eachCell(W, H, u, (c, R) => {
    const spin = u.t * TURN * u.hover * c.parity;
    const shape = (radius) => {
      ctx.beginPath();
      for (let s = 0; s <= steps; s++) {
        const th = (s / steps) * u.TAU;
        const phi = th - spin;
        const r = radius * grow * u.lerp(hexR(phi), gearR(phi), mix);
        const x = c.cx + r * Math.cos(th);
        const y = c.cy + r * Math.sin(th);
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    };
    ctx.strokeStyle = u.ink(alpha);
    shape(R);
    if (innerA > 0.005) {
      ctx.strokeStyle = u.ink(innerA);
      shape(R * 0.5);
    }
  });
};

/* FRAME · FAN */
const slides = (ctx, W, H, u) => {
  setStroke(ctx, u);
  const alpha = u.lerp(REST_A, HOVER_A, u.hover);
  const innerA = u.ease(u.hover) * INNER_A;
  const grow = u.lerp(1.0, 1.42, u.hover);
  eachCell(W, H, u, (c, R) => {
    const hw = R * 1.18 * grow;
    const hh = R * 0.84 * grow;
    const rr = R * 0.2;
    const fan = u.ease(u.hover) * (1 + 0.12 * Math.sin(u.t * 1.3 + c.ph));
    const wig = Math.sin(u.t * 0.6 + c.ph) * 0.05 * u.hover;
    ctx.save();
    ctx.translate(c.cx, c.cy);
    ctx.rotate(wig);
    if (innerA > 0.005) {
      for (const k of [-1, 1]) {
        ctx.save();
        ctx.rotate(k * 0.3 * fan * c.parity);
        ctx.beginPath();
        roundPath(ctx, rectPts(0, 0, hw, hh), rr);
        ctx.strokeStyle = u.ink(innerA);
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.beginPath();
    roundPath(ctx, rectPts(0, 0, hw, hh), rr);
    ctx.strokeStyle = u.ink(alpha);
    ctx.stroke();
    ctx.restore();
  });
};

/* PANE · SPLIT */
const panes = (ctx, W, H, u) => {
  setStroke(ctx, u);
  const alpha = u.lerp(REST_A, HOVER_A, u.hover);
  const innerA = u.ease(u.hover) * INNER_A;
  const growV = u.lerp(1.0, 1.45, u.hover);
  eachCell(W, H, u, (c, R) => {
    const S = R * 0.95; /* half side of the resting block */
    const hw = S / 3; /* half width of one pane */
    const gap = u.ease(u.hover) * R * 0.34;
    const hh = S * growV;
    const rr = hw * 0.55;
    ctx.save();
    ctx.translate(c.cx, c.cy);
    for (let k = -1; k <= 1; k++) {
      const x = k * (hw * 2 + gap);
      const bob = Math.sin(u.t * 1.4 + c.ph + k * 2.1) * R * 0.16 * u.hover * c.parity;
      ctx.beginPath();
      roundPath(ctx, rectPts(x, bob, hw, hh), rr);
      ctx.strokeStyle = u.ink(alpha);
      ctx.stroke();
      if (k === 0 && innerA > 0.005) {
        ctx.beginPath();
        roundPath(ctx, rectPts(x, bob, hw * 0.5, hh * 0.5), rr * 0.5);
        ctx.strokeStyle = u.ink(innerA);
        ctx.stroke();
      }
    }
    ctx.restore();
  });
};

/* RING · MESH */
const rings = (ctx, W, H, u) => {
  setStroke(ctx, u);
  const alpha = u.lerp(REST_A, HOVER_A, u.hover);
  const innerA = u.ease(u.hover) * INNER_A;
  const grow = u.lerp(1.0, 1.45, u.hover);
  eachCell(W, H, u, (c, R) => {
    const breathe = (k) => 1 + 0.05 * Math.sin(u.t * 1.3 + c.ph - k * 1.2) * u.hover;
    const Rg = R * grow;
    const ring = (radius) => {
      ctx.beginPath();
      ctx.arc(c.cx, c.cy, radius, 0, u.TAU);
      ctx.stroke();
    };
    ctx.strokeStyle = u.ink(alpha);
    ring(Rg * breathe(0));
    if (innerA > 0.005) {
      ctx.strokeStyle = u.ink(innerA);
      ring(Rg * 0.66 * breathe(1));
      ring(Rg * 0.33 * breathe(2));
      ctx.fillStyle = u.ink(innerA * 1.5);
      ctx.beginPath();
      ctx.arc(c.cx, c.cy, Math.max(1.5, R * 0.07), 0, u.TAU);
      ctx.fill();
    }
  });
};

/* ── The console deck's cards ─────────────────────────────────────────
   The original, pre-standardisation library: round 6 of the rebranding
   seed published as "The Console" on slideless, section CARD_PATTERNS,
   "the system dealt as a hand". Thirteen of its sixteen cards, verbatim;
   the other three (petal, plus, cog) are the direct ancestors of Bloom,
   Cross and Gear above and would double them. Same draw contract, so
   they run on the same harness; each drew on its own engine palette in
   the deck and grounds on the active theme here like everything else. */

/* GRID · MORPH — Cushion */
const portico = function(ctx,W,H,u){
    var hover=u.hover;
    // grid tuned to ~5x3 for the 16:10 card (near-square cells)
    var cols=5, rows=3;
    var cellW=W/cols, cellH=H/rows;
    ctx.lineWidth=Math.max(1,u.DPR*0.9);
    ctx.lineJoin="round"; ctx.lineCap="round";
    // superellipse exponent morphs squircle -> pinched cushion/star
    var n=u.lerp(4.5,0.7,hover);
    var e=2/n;
    var steps=112;
    var grow=u.lerp(1.0,1.12,hover);              // cells swell slightly to interlock
    var fill=0.9;                                  // half-extent as fraction of half-cell
    var aBase=cellW*0.5*fill*grow;
    var bBase=cellH*0.5*fill*grow;
    var alpha=u.lerp(0.26,0.44,hover);
    var sgn=function(v){return v<0?-1:v>0?1:0;};
    // one extra ring on every side so the field bleeds past the edges
    for(var j=-1;j<=rows;j++){
      for(var i=-1;i<=cols;i++){
        var cx=(i+0.5)*cellW;
        var cy=(j+0.5)*cellH;
        var ph=u.rnd()*u.TAU;                       // stable per-cell breathing phase
        var breathe=1+Math.sin(u.t*1.3+ph)*0.03*hover;
        var a=aBase*breathe, b=bBase*breathe;
        ctx.strokeStyle=u.ink(alpha);
        ctx.beginPath();
        for(var s=0;s<=steps;s++){
          var th=(s/steps)*u.TAU;
          var ct=Math.cos(th), st=Math.sin(th);
          var x=a*sgn(ct)*Math.pow(Math.abs(ct),e);
          var y=b*sgn(st)*Math.pow(Math.abs(st),e);
          if(s===0)ctx.moveTo(cx+x,cy+y); else ctx.lineTo(cx+x,cy+y);
        }
        ctx.closePath(); ctx.stroke();
        // faint nested inner cushion fades in on hover
        if(hover>0.01){
          var isc=u.lerp(0.8,0.5,hover);
          var ia=a*isc, ib=b*isc;
          ctx.strokeStyle=u.ink(alpha*0.34*hover);
          ctx.beginPath();
          for(var s2=0;s2<=steps;s2++){
            var th2=(s2/steps)*u.TAU;
            var c2=Math.cos(th2), t2=Math.sin(th2);
            var x2=ia*sgn(c2)*Math.pow(Math.abs(c2),e);
            var y2=ib*sgn(t2)*Math.pow(Math.abs(t2),e);
            if(s2===0)ctx.moveTo(cx+x2,cy+y2); else ctx.lineTo(cx+x2,cy+y2);
          }
          ctx.closePath(); ctx.stroke();
        }
      }
    }
  };

/* WAVE · SHIFT — Weave */
const weave = function(ctx,W,H,u){
    var hover=u.hover;
    var SQ=Math.SQRT1_2;                 // 1/sqrt(2)
    var dx=SQ, dy=SQ;                     // diagonal run: top-left -> bottom-right
    var pxn=SQ, pyn=-SQ;                  // perpendicular (spacing axis)
    var cx=W/2, cy=H/2;
    ctx.lineWidth=Math.max(1,u.DPR*0.8);
    ctx.lineJoin="round"; ctx.lineCap="round";
    var span=(W+H)*SQ;                    // perpendicular extent to blanket
    var spacing=span/13;                 // even gaps (unchanged by hover)
    var half=Math.ceil(span/spacing/2)+2;
    var L=(W+H)*0.85;                     // half length along the diagonal
    var segs=88;
    var lam=u.lerp(W*0.44,W*0.34,hover);  // waves shorten -> S-curves steepen
    var freq=u.TAU/lam;
    var amp=spacing*u.lerp(0.15,0.45,hover); // waves deepen, gaps stay put
    var drift=u.t*hover*70*freq;          // crest slides diagonally while hovered
    var alpha=u.lerp(0.30,0.46,hover);
    ctx.strokeStyle=u.ink(alpha);
    for(var k=-half;k<=half;k++){
      var o=k*spacing;
      var jit=(u.rnd()-0.5)*0.5;          // stable faint per-line phase jitter
      var phase=k*0.55 + jit + drift;     // per-line offset -> undulates as a sheet
      ctx.beginPath();
      for(var s=0;s<=segs;s++){
        var t=-L+(2*L)*(s/segs);
        var disp=o+amp*Math.sin(freq*t+phase);
        var X=cx+t*dx+disp*pxn;
        var Y=cy+t*dy+disp*pyn;
        if(s===0)ctx.moveTo(X,Y); else ctx.lineTo(X,Y);
      }
      ctx.stroke();
    }
  };

/* LINE · BEND — Blinds */
const chevron = function(ctx,W,H,u){
    var lw=Math.max(1,u.DPR*0.8);
    var N=14;                              // evenly spaced columns
    var sp=W/N;                            // even column spacing (constant)
    var amp=sp*0.44*u.hover;               // bend amplitude, grows with hover
    var cyc=2.6;                           // zigzag cycles down the height
    var k=u.TAU*cyc/H;                     // vertical angular frequency
    var colStep=0.80;                      // static phase shear per column
    var travel=u.t*1.7*u.hover;            // cascade left->right, frozen at rest
    var steps=52;
    var yTop=-H*0.08, yBot=H*1.08;         // bleed past top/bottom edges
    function tri(p){return Math.asin(Math.sin(p))*(2/Math.PI);} // [-1,1] chevron
    ctx.lineWidth=lw; ctx.lineJoin="round"; ctx.lineCap="round";
    for(var i=-1;i<=N+1;i++){
      var x0=(i+0.5)*sp;
      var phase=i*colStep - travel;
      // crest of this column's wave sits near the middle; subtle brightness lift on bend
      var a=0.30+0.20*u.hover;
      ctx.strokeStyle=u.ink(a);
      ctx.beginPath();
      for(var s=0;s<=steps;s++){
        var y=yTop+(yBot-yTop)*s/steps;
        var dx=amp*tri(y*k+phase);
        if(s===0) ctx.moveTo(x0+dx,y); else ctx.lineTo(x0+dx,y);
      }
      ctx.stroke();
    }
  };

/* BAND · CASCADE — Bands */
const aurora = function(ctx,W,H,u){
    var lw=Math.max(1,u.DPR*0.85);
    var M=11;                              // evenly spaced horizontal bands
    var sp=H/M;                            // even vertical spacing (constant)
    var restAmp=sp*0.12;                   // gentle sine at rest
    var maxAmp=sp*0.50;                    // swell reach on hover
    var cyc=1.55;                          // horizontal sine cycles across width
    var kx=u.TAU*cyc/W;
    var steps=64;
    var xL=-W*0.06, xR=W*1.06;             // bleed past left/right edges
    ctx.lineWidth=lw; ctx.lineJoin="round"; ctx.lineCap="round";
    for(var i=-1;i<=M+1;i++){
      var y0=(i+0.5)*sp;
      var yNorm=i/M;
      // rolling swell envelope travels top->bottom as t advances (frozen at rest)
      var roll=0.5+0.5*Math.sin(yNorm*u.TAU*1.5 - u.t*1.25*u.hover);
      var amp=restAmp + u.hover*(maxAmp*(0.32+0.68*roll));
      var drift=i*0.55 + u.t*0.9*u.hover;  // static per-band offset + hover phase drift
      var a=0.22 + u.hover*(0.10+0.34*roll); // brighter where the band crests
      ctx.strokeStyle=u.ink(a);
      ctx.beginPath();
      for(var s=0;s<=steps;s++){
        var x=xL+(xR-xL)*s/steps;
        var dy=amp*Math.sin(x*kx+drift);
        if(s===0) ctx.moveTo(x,y0+dy); else ctx.lineTo(x,y0+dy);
      }
      ctx.stroke();
    }
  };

/* GRID · REVEAL — Stagger */
const stagger = function(ctx,W,H,u){
    function cl(v){return v<0?0:v>1?1:v;}
    function rr(x,y,w,h,r){r=Math.min(r,w*0.5,h*0.5);ctx.beginPath();
      if(ctx.roundRect){ctx.roundRect(x,y,w,h,r);}else{
        ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);
        ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();}}
    var cols=10, s=W/cols, rows=Math.ceil(H/s)+1;
    var cx=W*0.5, cy=H*0.5, maxD=Math.sqrt(cx*cx+cy*cy);
    var band=0.5, thr=u.hover*(1+band);
    var speed=2.1, k=6.5, pad=s*0.10;
    ctx.lineWidth=Math.max(1,u.DPR*0.8);
    for(var row=-1;row<rows;row++){
      for(var col=-1;col<=cols;col++){
        var jit=u.rnd();                          // consumed every cell -> deterministic
        var x=col*s, y=row*s;
        var dx=(x+s*0.5-cx), dy=(y+s*0.5-cy);
        var d=Math.sqrt(dx*dx+dy*dy)/maxD;        // 0..1 from centre
        var reveal=u.ease(cl((thr-d)/band));      // staggered radial arrival
        var ox=x+pad, oy=y+pad, os=s-pad*2;
        if(os<=0.5) continue;
        rr(ox,oy,os,os,Math.min(6*u.DPR,os*0.18));
        ctx.strokeStyle=u.ink(0.10+0.12*reveal);  // outlines always faintly present
        ctx.stroke();
        if(reveal>0.002){
          var shimmer=0.55+0.45*Math.sin(u.t*speed - d*k + jit*1.3); // breathes in & out
          var a=reveal*shimmer*0.42;
          var inset=u.lerp(os*0.34, os*0.05, reveal);  // fill blooms open as it arrives
          var fs=os-inset*2;
          if(fs>0.6 && a>0.004){
            rr(ox+inset, oy+inset, fs, fs, Math.min(5*u.DPR,fs*0.22));
            ctx.fillStyle=u.ink(a);
            ctx.fill();
          }
        }
      }
    }
  };

/* CELL · SWEEP — Departures */
const checker = function(ctx,W,H,u){
    function cl(v){return v<0?0:v>1?1:v;}
    function rr(x,y,w,h,r){r=Math.min(r,w*0.5,h*0.5);ctx.beginPath();
      if(ctx.roundRect){ctx.roundRect(x,y,w,h,r);}else{
        ctx.moveTo(x+r,y);ctx.arcTo(x+w,y,x+w,y+h,r);ctx.arcTo(x+w,y+h,x,y+h,r);
        ctx.arcTo(x,y+h,x,y,r);ctx.arcTo(x,y,x+w,y,r);ctx.closePath();}}
    var cols=8, s=W/cols, rows=Math.ceil(H/s)+1;
    var maxDiag=(cols-1)+(rows-1);
    var band=0.5, thr=u.hover*(1+band);
    var speed=0.8, bw=0.13, range=1.4, pad=s*0.055, rad=Math.min(5*u.DPR,s*0.16);
    var f=((u.t*speed)%range)-0.2;                // travelling diagonal front, loops
    for(var row=-1;row<rows;row++){
      for(var col=-1;col<=cols;col++){
        var parity=(((col+row)%2)+2)%2;
        var diag=(col+row)/maxDiag;               // 0..1 corner->corner
        var base=parity?0.11:0.035;               // faint resting checker
        var reveal=u.ease(cl((thr-diag)/band));    // staggered diagonal arrival
        var dist=diag-f, pulse=Math.exp(-(dist*dist)/(2*bw*bw)); // bright travelling band
        var a=cl(base + reveal*0.20 + pulse*u.hover*0.30);
        var x=col*s+pad, y=row*s+pad, w=s-pad*2;
        if(w<=0.6||a<=0.003) continue;
        rr(x,y,w,w,rad);
        ctx.fillStyle=u.ink(a);
        ctx.fill();
      }
    }
  };

/* DOT · WAVEFRONT — Wavefront */
const wavefront = function(ctx,W,H,u){
    var gap  = Math.max(14, Math.round(22 * u.DPR));   // dot pitch
    var base = Math.max(1, 1.45 * u.DPR);              // resting dot radius
    var speed = 0.42;                                  // wavefront loops / sec
    var bandW = 0.16;                                  // crest half-width (phase units)
    var hv = u.hover;
    var front = (u.t * speed) % 1;                     // travelling crest, loops while hovered
    for (var y = -gap; y <= H + gap; y += gap) {
      for (var x = -gap; x <= W + gap; x += gap) {
        var jitter = (u.rnd() - 0.5) * 0.03;           // soften the front into an organic ripple
        var phase  = (x + y) / (W + H) + jitter;       // diagonal position, top-left -> bottom-right
        var d = front - phase;
        d = d - Math.round(d);                         // circular distance, [-0.5, 0.5]
        var a = 0;
        if (Math.abs(d) < bandW) a = 0.5 * (1 + Math.cos(Math.PI * d / bandW)); // smooth pulse
        a *= hv;                                        // gated by hover -> still at rest
        var r     = base * (1 + a * 2.4);              // crest dots swell
        var alpha = 0.10 + a * 0.50;                   // crest dots brighten
        ctx.fillStyle = u.ink(alpha);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, u.TAU);
        ctx.fill();
      }
    }
  };

/* RING · DRAW-ON — Written */
const written = function(ctx,W,H,u){
    var gap = Math.max(20, Math.round(32 * u.DPR));    // ring pitch
    var r0  = Math.max(3, 6.5 * u.DPR);                // ring radius
    var band = 0.34;                                   // fraction of hover each ring takes to draw
    var hv = u.hover;
    var start = -Math.PI / 2;                          // begin the stroke at 12 o'clock
    ctx.lineWidth = Math.max(1, 1.15 * u.DPR);
    ctx.lineCap = "round";
    for (var y = -gap; y <= H + gap; y += gap) {
      for (var x = -gap; x <= W + gap; x += gap) {
        var ph = u.rnd() * u.TAU;                      // per-ring breathe phase
        var delay = (x / W + y / H) * 0.5;             // diagonal cascade from top-left, 0..1
        var p = u.ease(Math.max(0, Math.min(1, (hv * (1 + band) - delay) / band)));
        // faint ghost ring, always present -> intentional resting matrix
        ctx.strokeStyle = u.ink(0.06);
        ctx.beginPath();
        ctx.arc(x, y, r0, 0, u.TAU);
        ctx.stroke();
        if (p > 0.001) {                               // the ink being written on
          var breathe = 0.5 + 0.5 * Math.sin(u.t * 1.5 + ph);
          var rr = r0 * (1 + 0.05 * breathe * p * hv); // completed rings breathe gently
          var alpha = (0.16 + 0.30 * p) * (0.85 + 0.15 * breathe);
          ctx.strokeStyle = u.ink(alpha);
          ctx.beginPath();
          ctx.arc(x, y, rr, start, start + p * u.TAU);
          ctx.stroke();
        }
      }
    }
  };

/* TRUSS · FLOW — Truss */
const truss = function(ctx,W,H,u){
    var DPR=u.DPR, hover=u.hover, t=u.t, TAU=u.TAU;
    // --- grid geometry (bleeds one cell beyond every edge) ---
    var cell = Math.max(30*DPR, W/12);
    var ox = -cell, oy = -cell;
    var cols = Math.ceil((W + 2*cell)/cell);
    var rows = Math.ceil((H + 2*cell)/cell);
    var amp = cell*0.30*hover;            // flow displacement, gated by hover
    // --- displaced node field (smooth flow) ---
    var nodes = new Array(rows+1);
    for(var j=0;j<=rows;j++){
      nodes[j]=new Array(cols+1);
      for(var i=0;i<=cols;i++){
        var bx = ox + i*cell, by = oy + j*cell;
        var dx = amp*Math.sin(j*0.85 + i*0.30 + t*1.30);
        var dy = amp*Math.cos(i*0.85 - j*0.30 + t*1.05);
        nodes[j][i] = { x: bx+dx, y: by+dy };
      }
    }
    // --- orthogonal lattice (uniform faint alpha, one batched path) ---
    ctx.lineWidth = Math.max(1, DPR*0.75);
    ctx.lineCap = "round";
    ctx.strokeStyle = u.ink(0.12 + 0.05*hover);
    ctx.beginPath();
    for(j=0;j<=rows;j++) for(i=0;i<cols;i++){
      var h1=nodes[j][i], h2=nodes[j][i+1];
      ctx.moveTo(h1.x,h1.y); ctx.lineTo(h2.x,h2.y);
    }
    for(i=0;i<=cols;i++) for(j=0;j<rows;j++){
      var v1=nodes[j][i], v2=nodes[j+1][i];
      ctx.moveTo(v1.x,v1.y); ctx.lineTo(v2.x,v2.y);
    }
    ctx.stroke();
    // --- diagonal braces carrying a travelling brightness wave ---
    ctx.lineWidth = Math.max(1, DPR*0.7);
    for(j=0;j<rows;j++) for(i=0;i<cols;i++){
      var alt = ((i+j)&1)===0;
      var dA = alt ? nodes[j][i]   : nodes[j][i+1];
      var dB = alt ? nodes[j+1][i+1] : nodes[j+1][i];
      var wave = 0.5 + 0.5*Math.sin((i+j)*0.55 - t*2.6);
      var da = 0.06 + (0.02 + 0.24*wave)*hover;
      ctx.strokeStyle = u.ink(da);
      ctx.beginPath(); ctx.moveTo(dA.x,dA.y); ctx.lineTo(dB.x,dB.y); ctx.stroke();
    }
    // --- nodes: brighten & swell along the same wave ---
    for(j=0;j<=rows;j++) for(i=0;i<=cols;i++){
      var nd = nodes[j][i];
      var w2 = 0.5 + 0.5*Math.sin((i+j)*0.55 - t*2.6);
      var na = 0.16 + (0.10 + 0.44*w2)*hover;
      var r  = DPR*(1.0 + 1.1*hover*w2);
      ctx.fillStyle = u.ink(na);
      ctx.beginPath(); ctx.arc(nd.x, nd.y, r, 0, TAU); ctx.fill();
    }
  };

/* PULSE · EXPAND — Sonar */
const sonar = function(ctx,W,H,u){
    var DPR=u.DPR, hover=u.hover, t=u.t, TAU=u.TAU;
    var cx=W/2, cy=H/2;
    var maxR = Math.hypot(W,H)/2 * 1.18;   // rings bleed past the corners
    var N = 11;                            // ring slots
    var gap = maxR/N;
    var speed = 0.16;                      // rings/sec travelling outward
    var ph = t*speed;                      // continuous outward phase
    var frac = ph - Math.floor(ph);
    var samples = 76;
    ctx.lineWidth = Math.max(1, DPR*1.0);
    ctx.lineJoin = "round";
    for(var k=0;k<=N;k++){
      var rr = gap*(k + frac);
      if(rr < gap*0.12) continue;          // still buried in the centre
      var nr = rr/maxR;
      // fade in as it leaves the centre, fade out as it nears/exceeds the edge
      var fadeIn  = Math.min(1, rr/(gap*1.15));
      var fo = 1 - Math.min(1, Math.max(0,(nr-0.52)/0.48));
      var fadeOut = fo*fo*(3-2*fo);
      var a = (0.10 + 0.30*hover) * fadeIn * fadeOut;
      if(a <= 0.003) continue;
      // superellipse exponent morphs: squarer at centre, rounder outward
      var expo = u.lerp(4.4, 2.5, Math.min(1,nr));
      var p = 2/expo;
      ctx.strokeStyle = u.ink(a);
      ctx.beginPath();
      for(var s=0;s<=samples;s++){
        var th = s/samples*TAU;
        var c=Math.cos(th), sn=Math.sin(th);
        var x = cx + rr*Math.sign(c)*Math.pow(Math.abs(c),p);
        var y = cy + rr*Math.sign(sn)*Math.pow(Math.abs(sn),p);
        if(s===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      }
      ctx.stroke();
    }
  };

/* HEX · MORPH — Snowflake */
const hexpinch = function(ctx,W,H,u){
    var hover=u.hover;
    ctx.lineJoin="round"; ctx.lineCap="round";
    ctx.lineWidth=Math.max(1,u.DPR*0.9);
    var cols=5;
    var R=W/(cols*Math.sqrt(3));         // hex circumradius (pointy-top)
    var dx=Math.sqrt(3)*R;               // column pitch = W/cols
    var dy=1.5*R;                        // row pitch (offset honeycomb)
    var apo=R*Math.cos(Math.PI/6);       // apothem (edge-midpoint radius)
    var grow=u.lerp(1.0,1.08,hover);
    var depth=u.lerp(1.06,0.40,hover);   // edge-mid radius / apothem : plump convex -> concave star
    var alpha=u.lerp(0.24,0.42,hover);
    var innerA=u.ease(hover)*0.26;       // nested inner hex fades in on hover
    // build one hex/star as 6 quadratic edges; control pulled along each edge-mid ray
    function hexPath(cx,cy,Rr,ap,dp){
      var vx=new Array(6),vy=new Array(6);
      for(var k=0;k<6;k++){var a=-Math.PI/2+k*(Math.PI/3);vx[k]=cx+Rr*Math.cos(a);vy[k]=cy+Rr*Math.sin(a);}
      var cmag=2*ap*dp-ap;               // so curve mid-radius == ap*dp (dp=1 => straight edge)
      ctx.beginPath(); ctx.moveTo(vx[0],vy[0]);
      for(var k2=0;k2<6;k2++){
        var ma=-Math.PI/3+k2*(Math.PI/3);
        var qx=cx+cmag*Math.cos(ma), qy=cy+cmag*Math.sin(ma);
        var n=(k2+1)%6;
        ctx.quadraticCurveTo(qx,qy,vx[n],vy[n]);
      }
      ctx.closePath();
    }
    var rows=Math.ceil(H/dy)+2;
    for(var row=-1;row<=rows;row++){
      for(var col=-1;col<=cols+1;col++){
        var cx=col*dx+((row&1)?dx/2:0);
        var cy=row*dy;
        var ph=u.rnd()*u.TAU;
        var breathe=1+Math.sin(u.t*1.25+ph)*0.03*hover;
        var Rr=R*grow*breathe, ap=apo*grow*breathe;
        hexPath(cx,cy,Rr,ap,depth);
        ctx.strokeStyle=u.ink(alpha); ctx.stroke();
        if(innerA>0.004){
          hexPath(cx,cy,Rr*0.52,ap*0.52,depth);
          ctx.strokeStyle=u.ink(innerA); ctx.stroke();
        }
      }
    }
  };

/* RHOMBUS · MORPH — Diamond */
const diamond = function(ctx,W,H,u){
    var hover=u.hover;
    ctx.lineJoin="round"; ctx.lineCap="round";
    ctx.lineWidth=Math.max(1,u.DPR*0.9);
    var cols=6;
    var rx=W/(2*cols), ry=rx;            // rotated squares, tips touching
    var sx=2*rx, sy=2*ry;
    var p=u.lerp(1.0,2.6,hover);         // superellipse exponent : diamond(1) -> cushion(2.6)
    var e=2/p;
    var grow=u.lerp(1.0,1.14,hover);     // swell to interlock
    var alpha=u.lerp(0.26,0.44,hover);
    var innerA=u.ease(hover)*0.24;
    var steps=120;
    function sgn(v){return v<0?-1:v>0?1:0;}
    function blob(cx,cy,a,b){
      ctx.beginPath();
      for(var s=0;s<=steps;s++){
        var th=(s/steps)*u.TAU, ct=Math.cos(th), st=Math.sin(th);
        var x=a*sgn(ct)*Math.pow(Math.abs(ct),e);
        var y=b*sgn(st)*Math.pow(Math.abs(st),e);
        if(s===0)ctx.moveTo(cx+x,cy+y);else ctx.lineTo(cx+x,cy+y);
      }
      ctx.closePath();
    }
    var rows=Math.ceil(H/sy)+2;
    for(var row=-1;row<=rows;row++){
      for(var col=-1;col<=cols+1;col++){
        var cx=col*sx, cy=row*sy;
        var ph=u.rnd()*u.TAU;
        var breathe=1+Math.sin(u.t*1.3+ph)*0.03*hover;
        var a=rx*grow*breathe, b=ry*grow*breathe;
        blob(cx,cy,a,b);
        ctx.strokeStyle=u.ink(alpha); ctx.stroke();
        if(innerA>0.004){
          blob(cx,cy,a*0.55,b*0.55);
          ctx.strokeStyle=u.ink(innerA); ctx.stroke();
        }
      }
    }
  };

/* TRI · TURN — Star */
const triangle = function(ctx,W,H,u){
    var hover=u.hover; var cols=6,rows=4; var cellW=W/cols,cellH=H/rows;
    ctx.lineWidth=Math.max(1,u.DPR*0.9); ctx.lineJoin="round"; ctx.lineCap="round";
    var TAU=u.TAU; var base=Math.min(cellW,cellH)*0.5;
    var rot=u.lerp(0,TAU/6,hover);            // main triangle turns 60deg (up -> down)
    var round=u.lerp(0,base*0.16,hover);      // corners round slightly as they turn
    var alpha=u.lerp(0.26,0.42,hover);
    var nestAlpha=u.lerp(0.0,0.34,hover);     // nested inverted triangle fades in
    var up=[-Math.PI/2, -Math.PI/2+TAU/3, -Math.PI/2+2*TAU/3];
    function mid(a,b){return {x:(a.x+b.x)/2,y:(a.y+b.y)/2};}
    function tri(cx,cy,R,ang,rr){ var p=[];
      for(var k=0;k<3;k++){ var a=up[k]+ang; p.push({x:cx+R*Math.cos(a), y:cy+R*Math.sin(a)}); }
      var s=mid(p[2],p[0]); ctx.beginPath(); ctx.moveTo(s.x,s.y);
      for(var k2=0;k2<3;k2++){ var cur=p[k2], nx=p[(k2+1)%3], m=mid(cur,nx);
        ctx.arcTo(cur.x,cur.y,m.x,m.y,rr); }
      ctx.closePath(); }
    for(var j=-1;j<=rows;j++)for(var i=-1;i<=cols;i++){
      var cx=(i+0.5)*cellW, cy=(j+0.5)*cellH; var ph=u.rnd()*TAU;
      var breathe=1+Math.sin(u.t*1.2+ph)*0.025*hover; var R=base*breathe;
      ctx.strokeStyle=u.ink(alpha); tri(cx,cy,R,rot,round); ctx.stroke();
      if(nestAlpha>0.005){ ctx.strokeStyle=u.ink(nestAlpha); tri(cx,cy,R,0,round); ctx.stroke(); }
    }
  };

/* ── The library ──────────────────────────────────────────────────────── */

export const ANIMATIONS = [
  {
    key: "crosses", name: "Cross", tag: "SQUARE → CROSS",
    note: "Soft squares bloom into rounded crosses, arms reaching past the cell edge to interlock with their neighbours: the building block growing connectors.",
    draw: crosses,
  },
  {
    key: "blooms", name: "Bloom", tag: "CIRCLE → QUATREFOIL",
    note: "Circles bloom into turning quatrefoils, a nested one fading in.",
    draw: blooms,
  },
  {
    key: "gears", name: "Gear", tag: "HEXAGON → GEAR",
    note: "Each hexagon grows teeth and turns as a gear, neighbours counter-rotating checkerwise, so adjacent gears mesh as one train.",
    draw: gears,
  },
  {
    key: "slides", name: "Fan", tag: "FRAME → DECK",
    note: "A single landscape frame fans into a deck of three, the whole stack growing past the cell edge: versions of one artifact, the deck being dealt.",
    draw: slides,
  },
  {
    key: "panes", name: "Split", tag: "BLOCK → PANES",
    note: "A block of three touching panes splits apart, each pane growing tall past the cell edge and bobbing against its neighbours: sessions side by side, each with a life of its own.",
    draw: panes,
  },
  {
    key: "rings", name: "Mesh", tag: "RING → MESH",
    note: "One circle grows past the half-cell line until neighbouring rings overlap, nested rings and a centre dot fading in: one identity, radiating access.",
    draw: rings,
  },
  {
    key: "portico", name: "Cushion", tag: "GRID · MORPH",
    note: "Cushion grid: a field of squircles whose superellipse exponent collapses on hover, squircle to pinched cushion, a nested one fading in.",
    draw: portico,
  },
  {
    key: "weave", name: "Weave", tag: "WAVE · SHIFT",
    note: "Diagonal weave: a sheet of diagonal lines whose waves deepen and slide as one fabric, the gaps never moving.",
    draw: weave,
  },
  {
    key: "chevron", name: "Blinds", tag: "LINE · BEND",
    note: "Sheared blinds: straight columns bend into travelling chevrons, the cascade running left to right.",
    draw: chevron,
  },
  {
    key: "aurora", name: "Bands", tag: "BAND · CASCADE",
    note: "Rolling bands: horizontal bands that swell and roll downward in a slow cascade.",
    draw: aurora,
  },
  {
    key: "stagger", name: "Stagger", tag: "GRID · REVEAL",
    note: "Cells that bloom outward: a grid revealing itself from the centre, each cell a beat behind its neighbour.",
    draw: stagger,
  },
  {
    key: "checker", name: "Departures", tag: "CELL · SWEEP",
    note: "A diagonal departures flip: cells flip over in a sweep, the board updating itself.",
    draw: checker,
  },
  {
    key: "wavefront", name: "Wavefront", tag: "DOT · WAVEFRONT",
    note: "Bloom in sequence: a matrix of resting dots, each swelling as the diagonal wavefront passes through it.",
    draw: wavefront,
  },
  {
    key: "written", name: "Written", tag: "RING · DRAW-ON",
    note: "Written in circles: a matrix of small rings, each drawing itself on from twelve o'clock in a diagonal cascade.",
    draw: written,
  },
  {
    key: "truss", name: "Truss", tag: "TRUSS · FLOW",
    note: "Living lattice: a triangulated truss whose joints drift and whose members re-tension, the structure staying a structure.",
    draw: truss,
  },
  {
    key: "sonar", name: "Sonar", tag: "PULSE · EXPAND",
    note: "Sonar topography: closed contours pulsing outward from their poles, the map sounding its own depths.",
    draw: sonar,
  },
  {
    key: "hexpinch", name: "Snowflake", tag: "HEX · MORPH",
    note: "Snowflake honeycomb: hexagons pinch into six-pointed flakes and back, the comb crystallising.",
    draw: hexpinch,
  },
  {
    key: "diamond", name: "Diamond", tag: "RHOMBUS · MORPH",
    note: "Diamond bloom: rhombi open into four-point stars, facets catching as they turn.",
    draw: diamond,
  },
  {
    key: "triangle", name: "Star", tag: "TRI · TURN",
    note: "Verdigris star: triangles turn against their neighbours and interlace into six-point stars.",
    draw: triangle,
  },
];

export function animationByKey(key) {
  return ANIMATIONS.find((a) => a.key === key) || ANIMATIONS[0];
}
