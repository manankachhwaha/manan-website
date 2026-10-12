/* =========================================================
   Scroll Playground
   - Native scroll drives a smoothed "virtual" scroll value.
   - Every section is a fixed full-screen sheet. The next sheet
     is pulled up over the current one; its top edge bends like
     cloth depending on how fast you scroll.
   ========================================================= */

const $  = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = t => 1 - Math.pow(1 - t, 3);
const easeInOut = t => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
// Motion is on by default (this site is all about it); the corner toggle turns it off.
let reduceMotion = false;
// Phones/tablets: no scroll smoothing (the finger must stay glued to the page)
// (add ?lite to the URL to preview the phone version on a computer)
const isTouch = matchMedia('(hover: none), (pointer: coarse)').matches || /[?&]lite/.test(location.search);
const PALETTE = ['#ff5b3a', '#ffd23f', '#ff7ad9', '#4fffb0', '#f4efe6'];
// Sheets with a light background (the header/UI turns dark there when blend modes are off)
const LIGHT = new Set(['marquee', 'manifesto', 'tunnel']);
const root = document.documentElement;
if (isTouch) root.classList.add('flat');

/* Quality governor: if the frame rate stays low, quietly drop expensive effects, one tier at a time */
const Q = { tier: 0, acc: 0, n: 0, bad: 0 };

/* Phone tilt: the device orientation nudges parallax layers (Android is automatic, iOS asks once on first tap) */
const tilt = { x: 0, y: 0, tx: 0, ty: 0, on: false };
function enableTilt() {
  const add = () => {
    tilt.on = true;
    addEventListener('deviceorientation', e => {
      if (e.gamma == null) return;
      tilt.tx = clamp(e.gamma / 30, -1, 1);
      tilt.ty = clamp(((e.beta || 45) - 45) / 30, -1, 1);
    }, { passive: true });
  };
  const D = window.DeviceOrientationEvent;
  if (!D) return;
  if (typeof D.requestPermission === 'function') D.requestPermission().then(r => { if (r === 'granted') add(); }).catch(() => {});
  else add();
}
if (isTouch) {
  const D = window.DeviceOrientationEvent;
  if (D && typeof D.requestPermission === 'function') addEventListener('click', enableTilt, { once: true });
  else enableTilt();
}

// Only touch the DOM when a value actually changed
const setStyle = (el, prop, val) => {
  const k = '__' + prop;
  if (el[k] !== val) { el[k] = val; el.style[prop] = val; }
};

if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
window.scrollTo(0, 0);

/* Stable screen height: 100lvh doesn't jump when a phone's address bar hides */
const vhProbe = document.createElement('div');
vhProbe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:100vh;height:100lvh;visibility:hidden;pointer-events:none';
document.body.appendChild(vhProbe);
const measureVh = () => vhProbe.offsetHeight || innerHeight;

/* Split text into word > char > span, so each letter can animate */
function splitText(el) {
  const text = el.textContent.trim();
  el.textContent = '';
  el.setAttribute('aria-label', text.replace(/\*/g, ''));
  const chars = [];
  let i = 0;
  text.split(/\s+/).forEach((word, wi, arr) => {
    const w = document.createElement('span');
    w.className = 'word';
    // *word* = italic serif accent
    if (word.includes('*')) { w.classList.add('em'); word = word.replace(/\*/g, ''); }
    w.setAttribute('aria-hidden', 'true');
    for (const ch of word) {
      const c = document.createElement('span');
      c.className = 'char';
      c.style.setProperty('--i', i++);
      const inner = document.createElement('span');
      inner.textContent = ch;
      c.appendChild(inner);
      w.appendChild(c);
      chars.push(c);
    }
    el.appendChild(w);
    if (wi < arr.length - 1) el.appendChild(document.createTextNode(' '));
  });
  return chars;
}

/* ---------------- state ---------------- */
const layers = $$('.layer');
const spacer = $('#spacer');
const S = { vw: innerWidth, vh: measureVh(), target: 0, current: 0, prev: 0, vel: 0, time: 0, dt: .016, max: 1, split: 0 };
const mouse = { x: innerWidth / 2, y: innerHeight / 2, rx: innerWidth / 2, ry: innerHeight / 2, active: false, isMouse: false };

/* Labels decode from random glyphs into their real text */
const GLYPHS = '!<>-_/[]{}=+*^?#01ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function scramble(el) {
  if (!el.dataset.final) el.dataset.final = el.textContent;
  const final = el.dataset.final;
  const start = performance.now(), dur = 800;
  cancelAnimationFrame(el._raf);
  const tick = now => {
    const p = clamp((now - start) / dur, 0, 1);
    const n = Math.floor(p * final.length);
    let out = final.slice(0, n);
    for (let i = n; i < final.length; i++) out += final[i] === ' ' ? ' ' : GLYPHS[(Math.random() * GLYPHS.length) | 0];
    el.textContent = out;
    if (p < 1) el._raf = requestAnimationFrame(tick);
  };
  el._raf = requestAnimationFrame(tick);
}

/* .mask headings slide up from behind an invisible edge when their sheet arrives */
$$('.mask').forEach(el => { el.innerHTML = `<span class="mask-in">${el.innerHTML}</span>`; });

/* Depth decor on every sheet: a giant outlined section number + drifting shapes at different depths.
   They are plain transform-only elements, so the GPU moves them for free. */
const SHAPE_TYPES = ['hoop', 'dot', 'plus', 'tri', 'sq'];
const SHAPE_COUNT = isTouch ? 3 : 7;
layers.forEach((l, li) => {
  l._labels = $$('.label:not(.mask)', l);
  l._sheet = $('.sheet', l);
  l._content = $('.content', l);
  l._sheet.insertAdjacentHTML('beforeend', '<div class="drape"></div><div class="shade"></div>');
  l._drape = $('.drape', l);
  l._shade = $('.shade', l);

  const ghost = document.createElement('div');
  ghost.className = 'ghost';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.textContent = String(li + 1).padStart(2, '0');
  const box = document.createElement('div');
  box.className = 'shapes';
  box.setAttribute('aria-hidden', 'true');
  l._shapes = [];
  for (let k = 0; k < SHAPE_COUNT; k++) {
    const el = document.createElement('i');
    const type = SHAPE_TYPES[(k + li) % SHAPE_TYPES.length];
    el.className = 'sh ' + type;
    const size = 14 + ((k * 37 + li * 11) % 5) * 9;
    el.style.cssText = `left:${(8 + ((k * 53 + li * 29) % 84))}%;top:${(10 + ((k * 31 + li * 47) % 76))}%;width:${size}px;height:${size}px;--k:${k}`;
    if (!LIGHT.has(l.id) && k % 2 === 0) el.style.color = PALETTE[(k + li) % 4];
    box.appendChild(el);
    l._shapes.push({ el, depth: .25 + ((k * 17 + li * 7) % 10) / 10 * 1.1, spin: ((k % 2) * 2 - 1) * (10 + (k * 13) % 30), ph: k * 1.7 });
  }
  l._sheet.insertBefore(ghost, l._content);
  l._sheet.insertBefore(box, l._content);
  l._ghost = ghost;
});

function decorUpdate(l, s, v) {
  if (isTouch) return; // phones: static numeral, shapes float via CSS
  const vh = S.vh, t = S.time;
  // scrolling drags the numeral and shapes at different speeds → depth
  const base = -s.hold * vh * .25 + (1 - s.enter) * vh * .35;
  setStyle(l._ghost, 'transform', `translate3d(${(v * -.4).toFixed(1)}px,${(base * .6).toFixed(1)}px,0)`);
  if (Q.tier >= 2) return;
  for (const sh of l._shapes) {
    const y = base * sh.depth + Math.sin(t * .6 + sh.ph) * 14 * sh.depth;
    const x = Math.cos(t * .45 + sh.ph) * 18 * sh.depth - (tilt.x * 26 + (mouse.isMouse ? (mouse.x / S.vw - .5) * 30 : 0)) * sh.depth;
    setStyle(sh.el, 'transform',
      `translate3d(${x.toFixed(1)}px,${y.toFixed(1)}px,0) rotate(${(t * sh.spin + s.hold * 120 * sh.depth).toFixed(1)}deg) scaleY(${(1 + Math.min(.8, Math.abs(v) * .003 * sh.depth)).toFixed(3)})`);
  }
}

/* ---------------- section modules ---------------- */
const modules = {};

modules.hero = {
  init(l) {
    this.chars = splitText($('.split', l)).map(el => ({
      el,
      r: .35 + Math.random() * .9,
      rot: (Math.random() - .5) * 70,
      x: (Math.random() - .5) * .4,
      kick: 0, px: 0, py: 0, ps: 0,
    }));
    this.chars.forEach(c => c.el.addEventListener('mouseenter', () => { c.kick = 1; }));
    // tap/click anywhere in the hero: nearby letters pop up (this is the "hover" for phones)
    l.addEventListener('pointerdown', e => {
      if (e.target.closest('button, a')) return;
      this.chars.forEach(c => { c.kick = Math.max(c.kick, clamp(1 - Math.hypot(c.cx - e.clientX, c.cy - e.clientY) / 300, 0, 1)); });
    });
    this.h1 = $('.split', l);
    this.blobs = $('.blobs', l);

    const words = ['move', 'feel alive', 'wiggle', 'glow', 'dance', 'breathe'];
    const rw = $('.rot-word', l);
    let wi = 0;
    setInterval(() => {
      rw.classList.add('out');
      setTimeout(() => {
        wi = (wi + 1) % words.length;
        rw.textContent = words[wi];
        rw.classList.remove('out');
        rw.classList.add('in-start');
        void rw.offsetWidth;
        rw.classList.remove('in-start');
      }, 380);
    }, 2400);
  },
  layout() {
    // resting centre of each letter, used for the magnetic push
    this.chars.forEach(c => {
      c.cx = c.el.offsetLeft + c.el.offsetWidth / 2;
      c.cy = c.el.offsetTop + c.el.offsetHeight / 2;
    });
  },
  update(l, s, v) {
    const h = easeInOut(s.hold);
    this.chars.forEach((c, i) => {
      c.kick = c.kick > .01 ? c.kick * .9 : 0;
      // letters shy away from the cursor
      let push = 0, ux = 0, uy = 0;
      if (mouse.isMouse) {
        const dx = c.cx - mouse.x, dy = c.cy - mouse.y, d = Math.hypot(dx, dy) || 1;
        push = d < 180 ? 1 - d / 180 : 0;
        ux = dx / d; uy = dy / d;
      }
      c.px = lerp(c.px, ux * push * 60, .15);
      c.py = lerp(c.py, uy * push * 60, .15);
      c.ps = lerp(c.ps, push, .15);
      const wob = Math.sin(S.time * 3 + i * .7) * Math.abs(v) * .12;
      const ty = -h * S.vh * .55 * c.r + wob - c.kick * 40 + c.py;
      const tx = h * S.vw * c.x + c.px;
      setStyle(c.el, 'transform',
        `translate3d(${tx.toFixed(1)}px,${ty.toFixed(1)}px,0) rotate(${(h * c.rot - c.kick * 12 + c.px * .2).toFixed(2)}deg) scale(${(1 + c.ps * .2).toFixed(3)})`);
    });
    const mx = mouse.isMouse ? mouse.x / S.vw - .5 : tilt.x * .5, my = mouse.isMouse ? mouse.y / S.vh - .5 : tilt.y * .5;
    if (mouse.isMouse) {
      setStyle(this.h1, 'transform', `perspective(900px) rotateX(${(-my * 14).toFixed(2)}deg) rotateY(${(mx * 18).toFixed(2)}deg)`);
    }
    const par = mouse.isMouse || tilt.on ? 60 : 0;
    setStyle(this.blobs, 'transform', `translate3d(${(-mx * par).toFixed(1)}px,${(-my * par - s.hold * 120).toFixed(1)}px,0)`);
  },
};

modules.marquee = {
  init(l) {
    this.sign = 1;
    this.rows = $$('.row', l).map(row => {
      const track = $('.track', row);
      return { track, html: track.innerHTML, dir: +row.dataset.dir || 1, off: 0, unit: 1 };
    });
    this.sticker = $('.sticker', l);
  },
  layout() {
    this.rows.forEach(r => {
      r.track.textContent = '';
      const u = document.createElement('span');
      u.className = 'unit';
      u.innerHTML = r.html;
      r.track.appendChild(u);
      r.unit = u.offsetWidth || 1;
      const n = Math.ceil((S.vw * 1.5) / r.unit) + 1;
      for (let i = 0; i < n; i++) r.track.appendChild(u.cloneNode(true));
    });
  },
  update(l, s, v) {
    if (Math.abs(v) > 2) this.sign = v > 0 ? 1 : -1;
    this.rows.forEach(r => {
      r.off += r.dir * this.sign * (70 + Math.abs(v) * 5) * S.dt;
      const x = -(((r.off % r.unit) + r.unit) % r.unit);
      r.track.style.transform = `translate3d(${x.toFixed(1)}px,0,0) skewX(${clamp(-v * .06, -12, 12).toFixed(2)}deg)`;
    });
    // starburst sticker: spins with the scroll, pops in as the sheet lands, wobbles when you scroll fast
    const pop = easeOut(clamp(s.enter * 1.3 - .3, 0, 1));
    setStyle(this.sticker, 'transform',
      `translate3d(0,${((1 - pop) * 60).toFixed(1)}px,0) rotate(${(s.hold * 420 + S.time * 28 + v * .5).toFixed(1)}deg) scale(${(pop * (1 + Math.min(.15, Math.abs(v) * .001))).toFixed(3)})`);
  },
};

modules.manifesto = {
  init(l) {
    const p = $('.words', l);
    const raw = p.textContent.trim().split(/\s+/);
    p.textContent = '';
    this.words = raw.map((w, i) => {
      const el = document.createElement('span');
      const hl = w.includes('*');
      el.className = 'w' + (hl ? ' hl' : '');
      el.textContent = w.replace(/\*/g, '');
      p.appendChild(el);
      if (i < raw.length - 1) p.appendChild(document.createTextNode(' '));
      return { el, o: -1, hl };
    });
    this.badge = $('.badge', l);
  },
  update(l, s, v) {
    const N = this.words.length;
    const p = clamp(s.hold * 1.2, 0, 1);
    this.words.forEach((w, i) => {
      const o = clamp(p * (N + 1) - i, 0, 1);
      if (Math.abs(o - w.o) > .005) {
        w.o = o;
        w.el.style.opacity = (.12 + .88 * o).toFixed(3);
        w.el.style.transform = `translateY(${((1 - o) * .25).toFixed(3)}em)`;
        if (w.hl) w.el.style.setProperty('--u', o.toFixed(2)); // the accent words draw their own underline
      }
    });
    this.badge.style.transform = `rotate(${(s.hold * 360 + S.time * 25 + v * .3).toFixed(2)}deg)`;
  },
};

modules.gallery = {
  init(l) {
    this.track = $('.g-track', l);
    this.head = $('.g-head', l);
    this.cards = $$('.card', l).map(el => ({ el, art: $('.art', el), hx: 0, hy: 0, tx: 0, ty: 0, hs: 0, over: false }));
    this.cards.forEach(c => {
      c.el.addEventListener('pointermove', e => {
        if (e.pointerType !== 'mouse') return;
        const r = c.el.getBoundingClientRect();
        c.tx = (e.clientX - r.left) / r.width - .5;
        c.ty = (e.clientY - r.top) / r.height - .5;
        if (!c.over) scramble($('h3', c.el));
        c.over = true;
        c.el.style.setProperty('--gx', ((c.tx + .5) * 100).toFixed(1) + '%');
        c.el.style.setProperty('--gy', ((c.ty + .5) * 100).toFixed(1) + '%');
      });
      c.el.addEventListener('pointerleave', () => { c.over = false; c.tx = 0; c.ty = 0; });
    });
    this.rot = 0;
    this.bar = $('.g-bar i', l);
    this.count = $('.g-count', l);
    this.idx = -1;
  },
  layout() {
    this.dist = Math.max(0, this.track.offsetWidth - S.vw);
    this.cards.forEach(c => { c.left = c.el.offsetLeft; c.w = c.el.offsetWidth; });
  },
  update(l, s, v) {
    const x = -s.hold * this.dist;
    setStyle(this.track, 'transform', `translate3d(${x.toFixed(1)}px,0,0)`);
    this.rot = lerp(this.rot, clamp(-v * .12, -28, 28), .15);
    let nearest = 0, best = 9;
    this.cards.forEach((c, i) => {
      const d = (c.left + x + c.w / 2 - S.vw / 2) / S.vw;
      if (Math.abs(d) < best) { best = Math.abs(d); nearest = i; }
      c.hx = lerp(c.hx, tilt.on && !mouse.isMouse ? tilt.x * .6 : c.tx, .12);
      c.hy = lerp(c.hy, tilt.on && !mouse.isMouse ? tilt.y * .6 : c.ty, .12);
      c.hs = lerp(c.hs, c.over ? 1 : 0, .12);
      // cards drop in one after another while the sheet lifts, and fan out slightly at the edges
      const drop = (1 - easeOut(clamp(s.enter * 1.5 - i * .09, 0, 1))) * S.vh * .35;
      if (isTouch) setStyle(c.el, 'transform', `translate3d(0,${(Math.abs(d) * 24 + drop).toFixed(1)}px,0)`);
      else setStyle(c.el, 'transform',
        `translateY(${(Math.abs(d) * 24 - c.hs * 14 + drop).toFixed(1)}px) scale(${(1 + c.hs * .04).toFixed(3)}) ` +
        `rotate(${(d * 5 + (1 - clamp(s.enter * 1.5 - i * .09, 0, 1)) * 8).toFixed(2)}deg) ` +
        `rotateY(${(this.rot - d * 10 + c.hx * 18).toFixed(2)}deg) rotateX(${(-c.hy * 18).toFixed(2)}deg)`);
      setStyle(c.art, 'transform', `translate3d(${(d * -40).toFixed(1)}px,0,0)`);
    });
    setStyle(this.bar, 'transform', `scaleX(${s.hold.toFixed(3)})`);
    if (nearest !== this.idx) {
      this.idx = nearest;
      this.count.textContent = `${String(nearest + 1).padStart(2, '0')} / ${String(this.cards.length).padStart(2, '0')}`;
    }
    setStyle(this.head, 'transform', `translate3d(${(-s.hold * S.vw * .15).toFixed(1)}px,0,0)`);
  },
};

modules.orbit = {
  init(l) {
    this.ring = $('.ring', l);
    this.title = $('.orbit-title', l);
    const words = this.ring.dataset.items.split(',');
    this.items = words.map((w, i) => {
      const el = document.createElement('span');
      el.className = 'item';
      el.textContent = w.trim();
      this.ring.appendChild(el);
      return { el, a: (i / words.length) * 360 };
    });
    this.tilt = -10;
  },
  layout() {
    // portrait phones: spin the ring vertically so it uses the tall screen
    this.vertical = S.vw < S.vh;
    this.R = this.vertical ? Math.min(S.vh * .34, 320) : Math.min(S.vw * .42, S.vh * .6, 560);
  },
  update(l, s, v) {
    const spin = s.hold * 300 + S.time * 14 + (s.enter - 1) * 60;
    this.tilt = lerp(this.tilt, -10 + clamp(v * .08, -20, 20), .1);
    const [tiltAxis, axis] = this.vertical ? ['rotateY', 'rotateX'] : ['rotateX', 'rotateY'];
    this.ring.style.transform = `${tiltAxis}(${this.tilt.toFixed(2)}deg)`;
    this.items.forEach(it => {
      const a = it.a + spin;
      const depth = (Math.cos((a * Math.PI) / 180) + 1) / 2;
      it.el.style.transform = `translate(-50%,-50%) ${axis}(${a.toFixed(2)}deg) translateZ(${this.R.toFixed(0)}px) ${axis}(${(-a).toFixed(2)}deg) scale(${(.72 + .28 * depth).toFixed(3)})`;
      it.el.style.opacity = (.3 + .7 * depth).toFixed(2);
    });
    setStyle(this.title, 'transform', `translate(-50%,-50%) scale(${(.8 + .2 * easeOut(s.enter) + s.hold * .15).toFixed(3)})`);
  },
};

modules.particles = {
  init(l) {
    this.cv = $('canvas', l);
    this.ctx = this.cv.getContext('2d');
    this.text = this.cv.dataset.text || 'HELLO';
  },
  layout() {
    const w = S.vw, h = S.vh;
    const dpr = (this.dpr = Math.min(isTouch ? 1 : 2, devicePixelRatio || 1));
    this.cv.width = w * dpr;
    this.cv.height = h * dpr;

    // draw the word off-screen and sample its pixels as particle targets
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const o = off.getContext('2d', { willReadFrequently: true });
    o.font = '800 100px Syne, sans-serif';
    const fs = Math.min((w * .82 * 100) / o.measureText(this.text).width, h * .42);
    o.font = `800 ${fs}px Syne, sans-serif`;
    o.textAlign = 'center';
    o.textBaseline = 'middle';
    o.fillStyle = '#fff';
    o.fillText(this.text, w / 2, h * .46);
    const data = o.getImageData(0, 0, w, h).data;
    const gap = Math.max(3, Math.round(fs / 55));
    let pts = [];
    for (let y = 0; y < h; y += gap)
      for (let x = 0; x < w; x += gap)
        if (data[(y * w + x) * 4 + 3] > 128) pts.push([x, y]);
    const MAX = isTouch ? 700 : 3200;
    if (pts.length > MAX) {
      const stride = pts.length / MAX;
      pts = Array.from({ length: MAX }, (_, i) => pts[Math.floor(i * stride)]);
    }

    this.groups = PALETTE.map(c => ({ c, ps: [] }));
    const R = Math.max(w, h);
    const small = w < 700 ? .7 : 1;
    pts.forEach(([x, y]) => {
      const ang = Math.random() * Math.PI * 2;
      const rad = R * (.1 + Math.random() * .6);
      this.groups[Math.floor(Math.random() * this.groups.length)].ps.push({
        tx: x, ty: y,
        sx: w / 2 + Math.cos(ang) * rad,
        sy: h / 2 + Math.sin(ang) * rad,
        ph: Math.random() * 6.28,
        sz: (2 + Math.random() * 2.2) * small,
        jx: Math.random() - .5, jy: Math.random() - .5,
        d: Math.random() * .35,
        ox: 0, oy: 0, vx: 0, vy: 0, cx: x, cy: y,
      });
    });
  },
  // tap/click → a shockwave blows the dust outward, then it drifts back into the word
  shock(px, py) {
    if (!this.groups) return;
    const R = 300;
    py -= this.oy || 0;
    for (const g of this.groups) for (const p of g.ps) {
      const ex = p.cx - px, ey = p.cy - py, d = Math.hypot(ex, ey);
      if (d < R) {
        const f = (1 - d / R) * 20 + 2;
        p.vx += (ex / (d || 1)) * f;
        p.vy += (ey / (d || 1)) * f;
      }
    }
  },
  update(l, s, v) {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, S.vw, S.vh);
    const pp = clamp(s.hold * 1.4, 0, 1);
    const repel = mouse.active;
    const mx = mouse.x, my = mouse.y - s.offsetY;
    const t = S.time;
    this.oy = s.offsetY;
    const step = Q.tier >= 2 ? 2 : 1; // struggling device: draw half the dust
    for (const g of this.groups) {
      ctx.fillStyle = g.c;
      for (let k = 0; k < g.ps.length; k += step) {
        const p = g.ps[k];
        const q = easeInOut(clamp((pp - p.d) / .65, 0, 1));
        const dx = p.sx + Math.sin(t * .5 + p.ph) * 40;
        const dy = p.sy + Math.cos(t * .4 + p.ph) * 40;
        const jit = v * .6 * (1 - q * .7); // scroll shakes the dust, less once it's formed
        const x = lerp(dx, p.tx, q) + p.jx * jit;
        const y = lerp(dy, p.ty, q) + p.jy * jit;
        if (repel) {
          const ex = x - mx, ey = y - my, d2 = ex * ex + ey * ey;
          if (d2 < 9000) {
            const f = (1 - d2 / 9000) * 5.6;
            const dd = Math.sqrt(d2) || 1;
            p.ox += (ex / dd) * f;
            p.oy += (ey / dd) * f;
          }
        }
        p.ox = (p.ox + p.vx) * .9; p.oy = (p.oy + p.vy) * .9;
        p.vx *= .88; p.vy *= .88;
        p.cx = x; p.cy = y;
        ctx.fillRect(x + p.ox, y + p.oy, p.sz, p.sz);
      }
    }
  },
};

/* Tunnel is drawn on a canvas: crisp at any zoom and far cheaper than scaling DOM boxes */
modules.tunnel = {
  init(l) {
    this.cv = $('.rings', l);
    this.ctx = this.cv.getContext('2d');
    this.N = isTouch ? 12 : 18;
    this.colors = ['#ff5b3a', '#2b1bff', '#0d0b1e'];
    // fixed angles for the speed streaks that fly out of the centre when you scroll fast
    this.rays = Array.from({ length: 26 }, (_, i) => ({ a: (i / 26) * Math.PI * 2 + Math.random() * .2, r: .3 + Math.random() * .7 }));
    this.text = $('.tunnel-text', l);
    $('span', this.text).textContent = 'going *deeper*';
    this.chars = splitText($('span', this.text));
    this.spin = 0;
  },
  layout() {
    this.dpr = Math.min(isTouch ? 1 : 2, devicePixelRatio || 1);
    this.cv.width = S.vw * this.dpr;
    this.cv.height = S.vh * this.dpr;
    this.size = Math.max(S.vw, S.vh) * .7;
    this.lw = clamp(S.vw * .004, 2, 5);
  },
  update(l, s, v) {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, S.vw, S.vh);
    this.spin += v * .02;
    const base = s.hold * 1.5 + S.time * .05;
    const cx = S.vw / 2, cy = S.vh / 2;
    const av = Math.abs(v);
    if (av > 6) {
      const reach = Math.hypot(cx, cy);
      ctx.strokeStyle = 'rgba(13,11,30,.4)';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const r of this.rays) {
        const r0 = reach * (.12 + ((r.r + S.time * .9) % 1) * .8);
        const r1 = r0 + Math.min(av * 1.6, reach * .5) * r.r;
        ctx.moveTo(cx + Math.cos(r.a) * r0, cy + Math.sin(r.a) * r0);
        ctx.lineTo(cx + Math.cos(r.a) * r1, cy + Math.sin(r.a) * r1);
      }
      ctx.stroke();
    }
    for (let i = 0; i < this.N; i++) {
      const f = (((i / this.N + base) % 1) + 1) % 1;
      const sc = Math.pow(f, 2.6) * 2.4;
      const side = this.size * sc;
      if (side < 2) continue;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(((f * 140 + s.hold * 90 + this.spin) * Math.PI) / 180);
      ctx.globalAlpha = clamp(f * 6, 0, 1);
      ctx.strokeStyle = this.colors[i % 3];
      ctx.lineWidth = this.lw * sc;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(-side / 2, -side / 2, side, side, side * .18);
      else ctx.rect(-side / 2, -side / 2, side, side);
      ctx.stroke();
      ctx.restore();
    }
    const tp = easeOut(clamp(s.hold * 1.6 - .2, 0, 1));
    setStyle(this.text, 'transform', `scale(${(.7 + tp * .3).toFixed(3)})`);
    setStyle(this.text, 'opacity', '1');
    this.chars.forEach((c, i) => {
      const q = easeOut(clamp(tp * 1.7 - i * .07, 0, 1));
      setStyle(c, 'transform', `translate3d(0,${((1 - q) * 80).toFixed(1)}%,0) rotate(${((1 - q) * (i % 2 ? 16 : -16)).toFixed(1)}deg) scale(${(.6 + q * .4).toFixed(3)})`);
      setStyle(c, 'opacity', q.toFixed(2));
    });
  },
};

modules.contact = {
  init(l) {
    splitText($('.wave', l));
    this.btn = $('.magnet', l);
    this.lab = $('.lab', this.btn);
    this.bx = 0; this.by = 0;
  },
  layout() {
    // resting centre of the button (no per-frame layout reads)
    this.bcx = this.btn.offsetLeft + this.btn.offsetWidth / 2;
    this.bcy = this.btn.offsetTop + this.btn.offsetHeight / 2;
    this.bw = this.btn.offsetWidth;
  },
  update(l, s) {
    let near = false, dx = 0, dy = 0;
    if (mouse.isMouse) {
      dx = mouse.x - this.bcx;
      dy = mouse.y - (this.bcy + s.offsetY);
      near = Math.hypot(dx, dy) < this.bw * 1.2;
    }
    this.bx = lerp(this.bx, near ? dx * .35 : 0, .15);
    this.by = lerp(this.by, near ? dy * .35 : 0, .15);
    setStyle(this.btn, 'transform', `translate3d(${this.bx.toFixed(1)}px,${this.by.toFixed(1)}px,0)`);
    setStyle(this.lab, 'transform', `translate3d(${(this.bx * .5).toFixed(1)}px,${(this.by * .5).toFixed(1)}px,0)`);
  },
};

layers.forEach(l => modules[l.id]?.init?.(l));

/* Phones: the cloth edge is a curved "cap" in the next sheet's colour that the GPU just
   moves and stretches, instead of re-clipping (= repainting) a whole screen every frame */
if (isTouch) {
  layers.forEach((l, i) => {
    if (!i) return;
    const c = document.createElement('div');
    c.className = 'cap';
    c.style.background = l.dataset.edge || '#000';
    $('#stage').appendChild(c);
    l._cap = c;
  });
}

/* ---------------- fluid ink (lives behind the hero and the contact section) ---------------- */
const fluidCv = $('.fluid');
let fluidOn = isTouch ? false : Fluid.init(fluidCv);
if (!fluidOn) fluidCv.remove();
const FLUID_COLORS = [[1, .36, .23], [1, .48, .85], [.25, .18, 1], [.31, 1, .69], [1, .82, .25]].map(c => c.map(x => x * .2));
const fl = { lx: null, ly: null, auto: .3, ct: 0, color: FLUID_COLORS[0], home: null, activeNow: false };

function fluidUpdate(l, s, v, dt) {
  if (!fluidOn || reduceMotion) return;
  fl.activeNow = true;
  if (fl.home !== l) { l._sheet.insertBefore(fluidCv, l._content); fl.home = l; Fluid.resize(); }
  // phones: simulate every other frame (soft ink looks the same at 30fps, costs half)
  fl.acc = (fl.acc || 0) + dt;
  if ((isTouch || Q.tier >= 1) && (fl.flip = !fl.flip)) return;
  dt = fl.acc; fl.acc = 0;
  fl.ct -= dt;
  if (fl.ct <= 0) { fl.ct = .6; fl.color = FLUID_COLORS[(Math.random() * FLUID_COLORS.length) | 0]; }

  // your cursor / finger stirs the ink
  if (mouse.active && fl.lx !== null) {
    const dx = mouse.x - fl.lx, dy = mouse.y - fl.ly;
    if (dx * dx + dy * dy > 1) {
      Fluid.splat(mouse.x / S.vw, 1 - (mouse.y - s.offsetY) / S.vh, dx * 8, -dy * 8, fl.color);
    }
  }
  fl.lx = mouse.x; fl.ly = mouse.y;

  // scrolling pulls ink in from the edge, like the cloth dragging it along
  if (Math.abs(v) > 3 && Math.random() < .5) {
    Fluid.splat(Math.random(), v > 0 ? .02 : .98, (Math.random() - .5) * 300, clamp(v * 2.5, -600, 600), fl.color);
  }

  // idle: a slow drip every second or two so it's never still
  fl.auto -= dt;
  if (fl.auto <= 0) {
    fl.auto = 1.6 + Math.random() * 1.6;
    const a = Math.random() * Math.PI * 2;
    Fluid.splat(.2 + Math.random() * .6, .2 + Math.random() * .6, Math.cos(a) * 450, Math.sin(a) * 450, fl.color.map(c => c * 1.4));
  }
  Fluid.step(Math.min(dt, 1 / 20));
  Fluid.render();
}

/* ---------------- layout ---------------- */
function layout() {
  S.vw = innerWidth;
  S.vh = measureVh();
  let s = 0;
  layers.forEach((l, i) => {
    l._start = s;
    l._enter = i === 0 ? 0 : S.vh;
    l._hold = parseFloat(l.dataset.hold || .5) * S.vh;
    s += l._enter + l._hold;
    l.style.zIndex = i + 1;
    if (l._cap) {
      l._capH = S.vh * .3;
      l._cap.style.height = l._capH + 'px';
      l._cap.style.zIndex = i + 1;
    }
  });
  S.max = s;
  spacer.style.height = s + S.vh + 'px';
  layers.forEach(l => modules[l.id]?.layout?.(l));
}
layout();
document.fonts?.ready.then(layout);

/* ---------------- UI: dots, progress, cursor ---------------- */
const nav = $('.dots');
const dots = layers.map((l, i) => {
  const b = document.createElement('button');
  b.dataset.name = l.dataset.name;
  b.setAttribute('aria-label', 'Go to ' + l.dataset.name);
  b.addEventListener('click', () => scrollTo({ top: i === 0 ? 0 : l._start + l._enter + 2, behavior: 'smooth' }));
  nav.appendChild(b);
  return b;
});
const progress = $('.progress span');
const cursor = $('.cursor');
const cursorDot = $('.cursor-dot');

addEventListener('pointermove', e => {
  mouse.x = e.clientX; mouse.y = e.clientY;
  mouse.active = true;
  mouse.isMouse = e.pointerType === 'mouse';
}, { passive: true });

/* ---------------- FX layer: cursor ribbon + click bursts ---------------- */
const fx = { cv: $('.fx'), trail: [], sparks: [], rings: [], lx: 0, ly: 0, clean: true };
fx.ctx = fx.cv.getContext('2d');
function fxResize() {
  fx.dpr = Math.min(isTouch || Q.tier >= 1 ? 1 : 2, devicePixelRatio || 1);
  fx.cv.width = S.vw * fx.dpr;
  fx.cv.height = S.vh * fx.dpr;
  fx.clean = false;
}
fxResize();

// click = a quiet double ripple (and an ink burst when you're over the fluid)
// ("click", not pointerdown, so a finger starting a scroll doesn't trigger it)
addEventListener('click', e => {
  if (reduceMotion || e.detail === 0 || e.target.closest?.('.motion-toggle')) return;
  fx.rings.push({ x: e.clientX, y: e.clientY, t: 0 }, { x: e.clientX, y: e.clientY, t: -.12 });
  if ($('#particles')._vis) modules.particles.shock(e.clientX, e.clientY);
  if (e.target.closest?.('.magnet')) confettiBurst(e.clientX, e.clientY, 70);
  if (fluidOn && fl.home && fl.home._vis) {
    const x = e.clientX / S.vw, y = 1 - e.clientY / S.vh;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      Fluid.splat(x, y, Math.cos(a) * 900, Math.sin(a) * 900, FLUID_COLORS[i % FLUID_COLORS.length].map(c => c * 2));
    }
  }
});

function drawFx(dt) {
  if (reduceMotion) fx.trail.length = fx.sparks.length = fx.rings.length = 0;

  // a fine ink line behind the cursor (drawn white; the canvas inverts it against whatever is below)
  // (skipped over the fluid sections, where the ink itself is the trail)
  if (!reduceMotion && !fl.activeNow && mouse.isMouse && (mouse.x !== fx.lx || mouse.y !== fx.ly)) {
    fx.trail.push({ x: mouse.x, y: mouse.y, life: 1 });
    fx.lx = mouse.x; fx.ly = mouse.y;
  }
  const empty = !fx.trail.length && !fx.sparks.length && !fx.rings.length;
  setStyle(fx.cv, 'visibility', empty ? 'hidden' : 'visible');
  if (empty && fx.clean) return; // nothing to draw: skip the full-screen clear
  const ctx = fx.ctx;
  ctx.setTransform(fx.dpr, 0, 0, fx.dpr, 0, 0);
  ctx.clearRect(0, 0, S.vw, S.vh);
  fx.clean = empty;
  if (empty) return;

  for (const p of fx.trail) p.life -= dt * 2.2;
  fx.trail = fx.trail.filter(p => p.life > 0).slice(-40);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let i = 1; i < fx.trail.length; i++) {
    const a = fx.trail[i - 1], b = fx.trail[i];
    ctx.strokeStyle = `rgba(255,255,255,${(b.life * .85).toFixed(2)})`;
    ctx.lineWidth = .5 + b.life * 2;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }

  // ripple rings (dark on light sheets when blend modes are off)
  const ringRGB = root.classList.contains('flat') && root.classList.contains('ui-ink') ? '13,11,30' : '255,255,255';
  for (const r of fx.rings) r.t += dt;
  fx.rings = fx.rings.filter(r => r.t < .9);
  for (const r of fx.rings) {
    if (r.t < 0) continue;
    const k = r.t / .9;
    ctx.strokeStyle = `rgba(${ringRGB},${(1 - k).toFixed(2)})`;
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(r.x, r.y, 6 + easeOut(k) * 70, 0, Math.PI * 2); ctx.stroke();
  }
}


/* ---------------- confetti: pops from the button and when you reach the end ---------------- */
const cf = { cv: $('.confetti'), ps: [], clean: true };
cf.ctx = cf.cv.getContext('2d');
function cfResize() {
  cf.cv.width = S.vw;
  cf.cv.height = S.vh;
  cf.clean = false;
}
cfResize();
function confettiBurst(x, y, n) {
  if (reduceMotion) return;
  n = Math.min(n, isTouch ? 45 : 90);
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (Math.random() - .5) * Math.PI * 1.1;
    const sp = 6 + Math.random() * 12;
    cf.ps.push({
      x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
      w: 5 + Math.random() * 7, h: 3 + Math.random() * 5,
      r: Math.random() * 6.28, vr: (Math.random() - .5) * .5,
      c: PALETTE[(Math.random() * PALETTE.length) | 0], life: 1 + Math.random() * .6,
    });
  }
  cf.ps = cf.ps.slice(-120);
}
function drawConfetti(dt) {
  setStyle(cf.cv, 'visibility', cf.ps.length ? 'visible' : 'hidden');
  if (!cf.ps.length) {
    if (!cf.clean) { cf.ctx.clearRect(0, 0, S.vw, S.vh); cf.clean = true; }
    return;
  }
  cf.clean = false;
  const ctx = cf.ctx, k = dt * 60;
  ctx.clearRect(0, 0, S.vw, S.vh);
  for (const p of cf.ps) {
    p.vy += .42 * k; p.vx *= Math.pow(.985, k); p.vy *= Math.pow(.985, k);
    p.x += p.vx * k; p.y += p.vy * k; p.r += p.vr * k; p.life -= dt * .5;
    ctx.globalAlpha = clamp(p.life * 2, 0, 1);
    ctx.fillStyle = p.c;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.r);
    ctx.scale(1, Math.cos(p.r * 2.3)); // flips like paper
    ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
  cf.ps = cf.ps.filter(p => p.life > 0 && p.y < S.vh + 40);
}

/* cursor: grows over links, becomes a "View" bubble over project cards */
if (!isTouch) {
  const cursorLabel = document.createElement('span');
  cursorLabel.className = 'cl';
  cursor.appendChild(cursorLabel);
  document.addEventListener('mouseover', e => {
    const card = e.target.closest('.card');
    cursorLabel.textContent = card ? 'View' : '';
    cursor.classList.toggle('is-view', !!card);
    cursor.classList.toggle('big', !card && !!e.target.closest('a, button, .char'));
  });
}

/* header: live section counter + local time in India */
const secNum = $('.sec-num'), secName = $('.sec-name'), timeEl = $('.clock .time');
$('.sec-of').textContent = '/ ' + String(layers.length).padStart(2, '0');
function setSection(i) {
  const s = document.createElement('span');
  s.textContent = String(i + 1).padStart(2, '0');
  secNum.replaceChildren(s);
  secName.textContent = layers[i].dataset.name;
}
const clockFmt = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });
const tick = () => { timeEl.textContent = clockFmt.format(new Date()).toUpperCase(); };
tick();
setInterval(tick, 15000);
$('.brand').addEventListener('click', e => { e.preventDefault(); scrollTo({ top: 0, behavior: 'smooth' }); });
const motionBtn = $('.motion-toggle');
motionBtn.addEventListener('click', () => {
  reduceMotion = !reduceMotion;
  document.documentElement.classList.toggle('calm', reduceMotion);
  motionBtn.textContent = reduceMotion ? 'Motion: off' : 'Motion: on';
  motionBtn.setAttribute('aria-pressed', String(reduceMotion));
  layers.forEach(l => { setStyle(l, 'clipPath', ''); l._clipped = false; });
});

/* Resize: ignore the phone address bar showing/hiding (height-only change) */
let lastW = innerWidth, resizeTimer;
addEventListener('resize', () => {
  if (isTouch && innerWidth === lastW) return;
  lastW = innerWidth;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const ratio = S.max ? scrollY / S.max : 0;
    layout();
    fxResize();
    cfResize();
    if (fluidOn) Fluid.resize();
    scrollTo(0, ratio * S.max);
    S.current = S.target = S.prev = scrollY;
  }, 150);
});

/* preloader: count 0 → 100, then the curtain lifts (CSS) */
const intro = $('.intro');
const introCount = $('.intro-count');
const introStart = performance.now();
(function count(now) {
  const p = clamp((now - introStart) / 1100, 0, 1);
  introCount.textContent = Math.round(easeInOut(p) * 100);
  if (p < 1) requestAnimationFrame(count);
})(introStart);
intro.addEventListener('animationend', e => { if (e.animationName === 'lift') intro.remove(); });

/* every time a sheet lands: a coloured light sweeps across the screen and the big type glitches for a beat */
const sweepEl = $('.sweep');
arrive.n = 0;
function arrive(l, i) {
  if (!i || reduceMotion) return;
  sweepEl.style.setProperty('--sc', PALETTE[i % 4]);
  arrive.n ^= 1;
  sweepEl.classList.remove('goA', 'goB');
  sweepEl.classList.add(arrive.n ? 'goA' : 'goB');
  l.classList.remove('glitchA', 'glitchB');
  l.classList.add(arrive.n ? 'glitchA' : 'glitchB');
  clearTimeout(l._gt);
  l._gt = setTimeout(() => l.classList.remove('glitchA', 'glitchB'), 600);
}

/* magnetic links (desktop): the element leans towards the pointer when it gets close */
const mags = isTouch ? [] : $$('.socials a, .brand, .motion-toggle').map(el => ({ el, x: 0, y: 0, tx: 0, ty: 0 }));
if (mags.length) addEventListener('pointermove', e => {
  for (const m of mags) {
    const r = m.el.getBoundingClientRect();
    const cx = r.left + r.width / 2 - m.x, cy = r.top + r.height / 2 - m.y;
    const near = Math.hypot(e.clientX - cx, e.clientY - cy) < 90 + r.width * .3;
    m.tx = near ? (e.clientX - cx) * .35 : 0;
    m.ty = near ? (e.clientY - cy) * .35 : 0;
  }
}, { passive: true });
const spot = $('.spot');

/* ---------------- quality governor ---------------- */
function setTier(t) {
  Q.tier = t;
  root.classList.toggle('q1', t >= 1);
  root.classList.toggle('q2', t >= 2);
  root.classList.toggle('flat', isTouch || t >= 2);
  if (t >= 1) { modules.tunnel.N = Math.min(modules.tunnel.N, 10); fxResize(); }
  if (t >= 2 && fluidOn) { fluidOn = false; fluidCv.style.display = 'none'; }
}
function govern(rawDt, now) {
  if (now < 4500 || document.hidden || reduceMotion || rawDt > .25) return; // skip intro + tab switches
  Q.acc += rawDt;
  if (++Q.n < (isTouch ? 60 : 90)) return;
  const avg = Q.acc / Q.n;
  Q.acc = Q.n = 0;
  if (avg > 1 / 40) { if (++Q.bad >= 2 && Q.tier < 2) { Q.bad = 0; setTier(Q.tier + 1); } }
  else Q.bad = 0;
}
// tab title nudges you back
const baseTitle = document.title;
document.addEventListener('visibilitychange', () => { document.title = document.hidden ? 'Come back ✦ ' + baseTitle : baseTitle; });

/* ---------------- main loop ---------------- */
let last = performance.now();
let activeIdx = -1;

function frame(now) {
  const rawDt = (now - last) / 1000;
  const dt = Math.min(.05, rawDt) || .016;
  last = now;
  govern(rawDt, now);
  S.dt = dt;
  S.time += dt;

  // scroll position + velocity
  S.target = scrollY;
  if (reduceMotion) {
    S.current = S.target;
    S.vel = 0;
  } else if (isTouch) {
    // follow the finger exactly; derive velocity from how far it moved this frame
    const delta = (S.target - S.prev) / (dt * 60);
    S.current = S.target;
    S.vel = lerp(S.vel, delta * 7, .2);
  } else {
    // wheel: glide towards the target (frame-rate independent)
    S.current = lerp(S.current, S.target, 1 - Math.pow(.0006, dt));
    if (Math.abs(S.target - S.current) < .1) S.current = S.target;
    S.vel = lerp(S.vel, S.target - S.current, .25);
  }
  S.prev = S.target;
  if (Math.abs(S.vel) < .02) S.vel = 0;
  fl.activeNow = false;
  if (tilt.on) { tilt.x = lerp(tilt.x, tilt.tx, .08); tilt.y = lerp(tilt.y, tilt.ty, .08); }

  const y = S.current, vw = S.vw, vh = S.vh;
  const v = clamp(S.vel, -300, 300);

  // pink/cyan colour split on big headings while scrolling fast
  // (desktop only: on phones this restyles the whole page every frame)
  const split = isTouch ? 0 : clamp(v * .025, -6, 6);
  if (Math.abs(split - S.split) > .15 || (split === 0 && S.split !== 0)) {
    S.split = split;
    document.documentElement.style.setProperty('--split', split.toFixed(2) + 'px');
  }

  const st = layers.map((l, i) => ({
    enter: i === 0 ? 1 : clamp((y - l._start) / vh, 0, 1),
    hold: l._hold ? clamp((y - l._start - l._enter) / l._hold, 0, 1) : 1,
  }));

  let active = 0;
  layers.forEach((l, i) => {
    const s = st[i];
    const cover = st[i + 1] ? st[i + 1].enter : 0;
    if (s.enter >= .5) active = i;

    // decode the labels each time a sheet arrives
    if (s.enter > .35 && !l._scr) { l._scr = true; l._labels.forEach(scramble); }
    else if (s.enter < .05 && i > 0) l._scr = false;

    // .in = headings in this sheet slide up into view (with a little hysteresis)
    if (s.enter > .6 && !l._in) { l._in = true; l.classList.add('in'); arrive(l, i); }
    else if (s.enter < .3 && l._in) { l._in = false; l.classList.remove('in'); }

    const visible = s.enter > 0 && cover < 1;
    if (visible !== l._vis) { l.style.visibility = visible ? 'visible' : 'hidden'; l.classList.toggle('off', !visible); l._vis = visible; }
    if (!visible) {
      if (l._cap) setStyle(l._cap, 'visibility', 'hidden');
      return;
    }

    // slide the sheet up
    s.offsetY = (1 - s.enter) * vh;
    setStyle(l, 'transform', `translate3d(0,${s.offsetY.toFixed(1)}px,0)`);

    // ---- the cloth: bend the top edge of the incoming sheet ----
    let bulge = 0;
    if (i > 0 && s.enter < 1 && !reduceMotion) {
      const landing = Math.min(1, (1 - s.enter) * 5); // flatten as it settles
      let b = Math.sin(s.enter * Math.PI) * vh * .09 + v * .55 * landing;
      b = clamp(b, -vh * .2, vh * .26);
      bulge = Math.abs(b) / (vh * .12);
      if (isTouch) {
        const k = clamp(b / l._capH, 0, 1);
        setStyle(l._cap, 'visibility', k > .005 ? 'visible' : 'hidden');
        setStyle(l._cap, 'transform', `translate3d(0,${(s.offsetY - l._capH + 1).toFixed(1)}px,0) scaleY(${k.toFixed(3)})`);
      } else {
      // ripples running along the edge, stronger the faster you scroll
      const amp = Math.min(vh * .045, Math.abs(v) * .12 + Math.sin(s.enter * Math.PI) * vh * .012) * landing;
      const SEG = vw < 700 ? 20 : 36;
      let d = '';
      for (let k = 0; k <= SEG; k++) {
        const u = k / SEG, c = 2 * u - 1;
        const base = b >= 0 ? b * c * c : -b * (1 - c * c);
        const wave = amp * (Math.sin(u * 9 + S.time * 4.2) * .6 + Math.sin(u * 17 - S.time * 2.7) * .4);
        d += (k ? ' L' : 'M') + (u * vw).toFixed(1) + ',' + (base + wave).toFixed(1);
      }
      l.style.clipPath = `path('${d} L${vw},${vh} L0,${vh} Z')`;
      l._clipped = true;
      }
    } else {
      if (l._clipped) { l.style.clipPath = ''; l._clipped = false; }
      if (l._cap) setStyle(l._cap, 'visibility', 'hidden');
    }

    // the sheet underneath gets pushed back and darkened
    setStyle(l._sheet, 'transform', cover > 0
      ? `translate3d(0,${(-cover * vh * .15).toFixed(1)}px,0) scale(${(1 - cover * .1).toFixed(3)})`
      : 'none');
    setStyle(l._shade, 'opacity', (cover * .75).toFixed(2));

    // fabric stretch + folds on every scroll (desktop; phones keep only the fold shading)
    if (!isTouch) {
      const k = s.enter < 1 ? .6 : 1;
      setStyle(l._content, 'transformOrigin', v >= 0 ? '50% 0%' : '50% 100%');
      setStyle(l._content, 'transform',
        `perspective(1400px) rotateX(${(-v * .03 * k).toFixed(2)}deg) skewY(${(v * .01 * k).toFixed(2)}deg) scaleY(${(1 + Math.abs(v) * .0006 * k).toFixed(3)})`);
    }
    const dop = isTouch ? 0 : clamp(Math.max(bulge, Math.abs(v) / 140), 0, 1) * .9;
    setStyle(l._drape, 'opacity', dop.toFixed(2));
    if (dop > .01 && !isTouch) l._drape.style.backgroundPosition = `0 0, ${(S.time * 30 + y * .2).toFixed(0)}px 0`;

    modules[l.id]?.update?.(l, s, v);
    decorUpdate(l, s, v);
    if (l.id === 'contact') {
      if (s.enter > .92 && !l._pop) { l._pop = true; confettiBurst(S.vw / 2, S.vh * .85, 60); }
      else if (s.enter < .4) l._pop = false;
    }
    if (l.id === 'hero' || l.id === 'contact') fluidUpdate(l, s, v, dt);
  });

  if (active !== activeIdx) {
    dots.forEach((d, i) => d.classList.toggle('on', i === active));
    setSection(active);
    root.classList.toggle('ui-ink', LIGHT.has(layers[active].id));
    if (isTouch && activeIdx >= 0 && navigator.vibrate) navigator.vibrate(6);
    activeIdx = active;
  }
  setStyle(progress, 'transform', `scaleX(${(S.max ? y / S.max : 0).toFixed(4)})`);

  if (!isTouch) {
    mouse.rx = lerp(mouse.rx, mouse.x, .18);
    mouse.ry = lerp(mouse.ry, mouse.y, .18);
    setStyle(cursor, 'transform', `translate3d(${mouse.rx.toFixed(1)}px,${mouse.ry.toFixed(1)}px,0)`);
    setStyle(cursorDot, 'transform', `translate3d(${mouse.x}px,${mouse.y}px,0)`);
    setStyle(spot, 'transform', `translate3d(${(mouse.rx - 300).toFixed(1)}px,${(mouse.ry - 300).toFixed(1)}px,0)`);
    for (const m of mags) {
      m.x = lerp(m.x, m.tx, .15); m.y = lerp(m.y, m.ty, .15);
      setStyle(m.el, 'translate', `${m.x.toFixed(1)}px ${m.y.toFixed(1)}px`);
    }
  }

  drawFx(dt);
  drawConfetti(dt);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
