/*
 * Swarm build: the page starts blank and a team of cursor "agents" assembles it
 * as you scroll — dragging out boxes, typing text, drawing lines with a pen tool,
 * pulling ruler guides and ⌥-dragging duplicates of repeated elements.
 *
 * Add ?static to the URL (or turn on "reduce motion") to skip the animation.
 */
(() => {
  "use strict";

  const site = document.getElementById("site");
  const params = new URLSearchParams(location.search);
  if (!site || params.has("static") || matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const AGENTS = [
    ["Retriever", "#ea580c"], ["Reranker", "#6b6b6b"], ["Planner", "#f97316"],
    ["Critic", "#525252"], ["Embedder", "#c94c0a"], ["Judge", "#a3a3a3"],
    ["Router", "#fb923c"], ["LoRA", "#737373"], ["Tokenizer", "#ef824a"],
    ["Evaluator", "#8a8a8a"],
  ];
  const DUP_MAX_H = 260;

  const doc = document.documentElement;
  // Real speeds behind the 1×, 2×, 3× labels.
  const SPEEDS = [1.8, 2.5, 3], SPEED_LABELS = ["1×", "2×", "3×"];
  let speed = SPEEDS[0], gen = 0, phase = "idle", touring = false;
  let tasks = [], agents = [], doneCount = 0, startTime = 0, backlog = 0, lastSched = 0;

  /* ---------- helpers ---------- */
  const el = (tag, cls, parent) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.append(e);
    return e;
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ease = {
    inOut: t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
    out: t => 1 - Math.pow(1 - t, 3),
    lin: t => t,
  };
  const rd = node => {
    const r = node.getBoundingClientRect();
    return { x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height };
  };
  const ABORT = Symbol("abort");

  function tween(ms, fn, e = ease.inOut) {
    const g = gen;
    const dur = ms / speed;
    return new Promise((resolve, reject) => {
      const t0 = performance.now();
      const step = now => {
        if (g !== gen) return reject(ABORT);
        const t = dur <= 0 ? 1 : Math.min(1, (now - t0) / dur);
        fn(e(t));
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }
  const wait = ms => tween(ms, () => {}, ease.lin);
  const fade = (node, ms = 400) => {
    node.classList.add("sw-out");
    setTimeout(() => node.remove(), ms);
  };

  // Dark or light text, whichever reads better on a given agent color.
  function textOn(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    return L > 0.18 ? "#0a0a0a" : "#ffffff";
  }

  /* ---------- overlay ---------- */
  const layer = el("div", "sw-layer", document.body);
  layer.setAttribute("aria-hidden", "true");
  const rulerX = el("div", "sw-ruler sw-ruler-x", document.body);
  const rulerY = el("div", "sw-ruler sw-ruler-y", document.body);
  rulerX.setAttribute("aria-hidden", "true");
  rulerY.setAttribute("aria-hidden", "true");
  let guides = [];

  function selBox(color) {
    const s = el("div", "sw-sel sw-fx", layer);
    s.style.setProperty("--c", color);
    s.style.setProperty("--ct", textOn(color));
    s.innerHTML = '<i></i><i></i><i></i><i></i><b class="sw-dim"></b>';
    return s;
  }
  function place(s, x, y, w, h) {
    s.style.transform = `translate(${x}px,${y}px)`;
    s.style.width = Math.max(0, w) + "px";
    s.style.height = Math.max(0, h) + "px";
  }
  function dot(x, y, color) {
    const d = el("div", "sw-dot sw-fx", layer);
    d.style.setProperty("--c", color);
    d.style.transform = `translate(${x}px,${y}px)`;
    return d;
  }

  /* ---------- agents ---------- */
  const CURSORS = {
    arrow: '<svg width="18" height="22" viewBox="0 0 18 22"><path class="c-fill" d="M3 2 L3 18 L7.2 14.2 L10 20.6 L12.9 19.3 L10.2 13 L15.8 13 Z" stroke="#0a0a0a" stroke-width="1.6" stroke-linejoin="round"/></svg>',
    cross: '<svg width="22" height="22" viewBox="-11 -11 22 22"><path d="M0-10V10M-10 0H10" stroke="#0a0a0a" stroke-width="3.4"/><path class="c-stroke" d="M0-10V10M-10 0H10" stroke-width="1.5"/></svg>',
    ibeam: '<svg width="12" height="22" viewBox="-6 -11 12 22"><path d="M-4-10h8M-4 10h8M0-10V10" stroke="#0a0a0a" stroke-width="3.4"/><path class="c-stroke" d="M-4-10h8M-4 10h8M0-10V10" stroke-width="1.5"/></svg>',
    pen: '<svg width="20" height="20" viewBox="0 0 20 20"><path class="c-fill" d="M2 2 L6.5 15 L9.4 12.2 L14.6 17.4 L17.4 14.6 L12.2 9.4 L15 6.5 Z" stroke="#0a0a0a" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  };

  class Agent {
    constructor(name, color, i) {
      Object.assign(this, { name, color, i, busy: false, x: 0, y: 0, wt: null, wtUntil: 0 });
      this.angle = (i / AGENTS.length) * Math.PI * 2;
      const e = (this.el = el("div", "sw-agent", layer));
      e.style.setProperty("--c", color);
      e.style.setProperty("--ct", textOn(color));
      e.innerHTML =
        Object.entries(CURSORS).map(([k, svg]) => `<span class="m m-${k}">${svg}</span>`).join("") +
        `<span class="sw-name">${name}</span>`;
      this.mode("arrow");
    }
    set(x, y) {
      this.x = x; this.y = y;
      this.el.style.transform = `translate3d(${x}px,${y}px,0)`;
    }
    mode(m) { this.el.dataset.mode = m; }
    press() {
      this.el.classList.add("down");
      setTimeout(() => this.el.classList.remove("down"), 130);
    }
    move(x, y, ms) {
      const sx = this.x, sy = this.y;
      const d = Math.hypot(x - sx, y - sy);
      if (d < 1) return Promise.resolve();
      ms = ms ?? clamp(200 + d * 0.5, 220, 900);
      const bend = (this.i % 2 ? 1 : -1) * 0.14;
      const cx = (sx + x) / 2 + (y - sy) * bend, cy = (sy + y) / 2 - (x - sx) * bend;
      return tween(ms, t => {
        const u = 1 - t;
        this.set(u * u * sx + 2 * u * t * cx + t * t * x, u * u * sy + 2 * u * t * cy + t * t * y);
      });
    }
  }

  /* ---------- snapshot: turn the page into build tasks ---------- */
  function hasDeco(cs) {
    const bg = cs.backgroundColor;
    const bgVisible = bg && bg !== "transparent" && !/rgba\(.*,\s*0\)$/.test(bg);
    const border = ["Top", "Right", "Bottom", "Left"].some(
      s => parseFloat(cs[`border${s}Width`]) > 0 && cs[`border${s}Style`] !== "none"
    );
    return bgVisible || cs.backgroundImage !== "none" || border || cs.boxShadow !== "none";
  }
  function classify(node, cs) {
    if (node.dataset && node.dataset.build) return node.dataset.build;
    if (node.tagName === "HR") return "line";
    if (node.tagName === "svg" || node.tagName === "IMG" || node.tagName === "VIDEO") return "media";
    const hasText = [...node.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    const deco = hasDeco(cs);
    if (hasText) return deco ? "boxtext" : "text";
    return deco ? "box" : null;
  }
  const LEAF = new Set(["text", "boxtext", "media", "line"]);

  function collect() {
    const list = [];
    const visit = (parent, parentTask) => {
      for (const node of parent.children) {
        if (node.matches("script, style, [data-nobuild]")) continue;
        const cs = getComputedStyle(node);
        if (cs.display === "none") continue;
        const kind = classify(node, cs);
        let t = null;
        if (kind) {
          t = { el: node, kind, dep: parentTask, cls: node.className && node.className.baseVal === undefined ? node.className : "" };
          list.push(t);
        }
        if (kind && LEAF.has(kind)) continue;
        visit(node, t || parentTask);
      }
    };
    visit(site, null);

    // Repeated siblings (cards, chips, tags) → one master + duplicates.
    const groups = new Map();
    for (const t of list) {
      if ((t.kind !== "box" && t.kind !== "boxtext") || !t.cls) continue;
      const key = t.el.parentElement;
      if (!groups.has(key)) groups.set(key, new Map());
      const byCls = groups.get(key);
      if (!byCls.has(t.cls)) byCls.set(t.cls, []);
      byCls.get(t.cls).push(t);
    }
    for (const byCls of groups.values()) {
      for (const g of byCls.values()) {
        if (g.length < 3 || g[0].el.getBoundingClientRect().height > DUP_MAX_H) continue;
        for (const t of g.slice(1)) { t.base = t.kind; t.kind = "dup"; t.master = g[0]; }
      }
    }
    // Subtrees (for "wait until the master is finished") and duplicate ownership.
    for (const t of list) t.sub = [];
    for (const t of list) {
      for (let a = t.dep; a; a = a.dep) {
        a.sub.push(t);
        if (a.kind === "dup" && !t.owner) t.owner = a;
      }
    }
    return list;
  }

  /* ---------- text wrapping for typing ---------- */
  function wrap(node) {
    if (node._spans) return node._spans;
    node._html = node.innerHTML;
    const spans = [];
    const walk = n => {
      for (const c of [...n.childNodes]) {
        if (c.nodeType === 3) {
          if (!c.textContent.trim()) continue;
          // One wrapper per text run, so flex/grid parents see a single item (as before), not one per letter.
          const frag = document.createElement("span");
          for (const ch of c.textContent) {
            if (/\s/.test(ch)) { frag.append(ch); continue; }
            const s = document.createElement("span");
            s.className = "ch";
            s.textContent = ch;
            frag.append(s);
            spans.push(s);
          }
          c.replaceWith(frag);
        } else if (c.nodeType === 1 && c.tagName !== "svg") {
          walk(c);
        }
      }
    };
    walk(node);
    node._spans = spans;
    return spans;
  }
  function unwrap(node) {
    if (node._html === undefined) return;
    node.innerHTML = node._html;
    delete node._html;
    delete node._spans;
  }
  function reveal(node) {
    node.classList.remove("pending");
    node.classList.add("sw-in");
    setTimeout(() => node.classList.remove("sw-in"), 500);
  }

  /* ---------- task actions ---------- */
  async function drawBox(a, node) {
    const r = rd(node);
    if (r.w < 1 || r.h < 1) return;
    await a.move(r.x, r.y);
    a.mode("cross");
    a.press();
    const s = selBox(a.color);
    const dim = s.querySelector(".sw-dim");
    place(s, r.x, r.y, 0, 0);
    await tween(clamp(260 + (r.w + r.h) * 0.45, 320, 1100), e => {
      const w = r.w * e, h = r.h * e;
      place(s, r.x, r.y, w, h);
      dim.textContent = `${Math.round(w)} × ${Math.round(h)}`;
      a.set(r.x + w, r.y + h);
    }, ease.out);
    a.press();
    fade(s);
  }

  async function typeText(a, node, fast) {
    const spans = wrap(node);
    node.classList.remove("pending");
    if (!spans.length) return;
    const f = spans[0].getBoundingClientRect();
    await a.move(f.left + scrollX - 2, f.top + scrollY + f.height / 2);
    a.mode("ibeam");
    a.press();
    const caret = el("div", "sw-caret sw-fx", layer);
    caret.style.setProperty("--c", a.color);
    const n = spans.length;
    const big = parseFloat(getComputedStyle(node).fontSize) > 30;
    const per = fast ? 8 : big ? 60 : 20;
    const ms = clamp(n * per, fast ? 160 : 380, fast ? 900 : 2600);
    let shown = 0;
    await tween(ms, e => {
      const k = Math.max(1, Math.ceil(e * n));
      for (; shown < k; shown++) spans[shown].classList.add("on");
      const r = spans[k - 1].getBoundingClientRect();
      const x = r.right + scrollX, y = r.top + scrollY;
      caret.style.transform = `translate(${x}px,${y}px)`;
      caret.style.height = r.height + "px";
      a.set(x + 4, y + r.height / 2);
    }, ease.lin);
    await wait(fast ? 60 : 200);
    caret.remove();
    unwrap(node);
  }

  async function sweepIn(node) {
    node.style.clipPath = "inset(0 0 100% 0)";
    reveal(node);
    await tween(800, e => { node.style.clipPath = `inset(0 0 ${(1 - e) * 100}% 0)`; }, ease.out);
    node.style.clipPath = "";
  }

  const ACTIONS = {
    async box(a, t) {
      await drawBox(a, t.el);
      reveal(t.el);
      await wait(80);
    },
    async text(a, t) {
      await typeText(a, t.el, false);
    },
    async boxtext(a, t) {
      wrap(t.el);
      await drawBox(a, t.el);
      reveal(t.el);
      await typeText(a, t.el, false);
    },
    async media(a, t) {
      await drawBox(a, t.el);
      await sweepIn(t.el);
    },
    async line(a, t) {
      const node = t.el, r = rd(node), horiz = r.w >= r.h;
      const sx = horiz ? r.x : r.x + r.w / 2, sy = horiz ? r.y + r.h / 2 : r.y;
      const ex = horiz ? r.x + r.w : sx, ey = horiz ? sy : r.y + r.h;
      await a.move(sx, sy);
      a.mode("pen");
      a.press();
      const d1 = dot(sx, sy, a.color);
      node.style.clipPath = horiz ? "inset(0 100% 0 0)" : "inset(0 0 100% 0)";
      node.classList.remove("pending");
      await tween(clamp(Math.max(r.w, r.h) * 0.7, 300, 1500), e => {
        const p = (1 - e) * 100;
        node.style.clipPath = horiz ? `inset(0 ${p}% 0 0)` : `inset(0 0 ${p}% 0)`;
        a.set(sx + (ex - sx) * e, sy + (ey - sy) * e);
      }, ease.inOut);
      a.press();
      const d2 = dot(ex, ey, a.color);
      node.style.clipPath = "";
      await wait(250);
      fade(d1); fade(d2);
    },
    async guide(a, t) {
      const sec = t.el, r = rd(sec);
      const w = sec.querySelector(".wrap") || sec;
      const x = w.getBoundingClientRect().left + parseFloat(getComputedStyle(w).paddingLeft) + scrollX;
      const vy = clamp(r.y + 70, scrollY + 60, scrollY + innerHeight - 90);
      const x0 = scrollX + 9;
      await a.move(x0, vy);
      a.press();
      const g = el("div", "sw-guide sw-fx", layer);
      g.style.height = r.h + "px";
      const lab = el("b", "sw-gx sw-fx", layer);
      await tween(650, e => {
        const gx = x0 + (x - x0) * e;
        g.style.transform = `translate(${gx}px,${r.y}px)`;
        lab.style.transform = `translate(${gx + 6}px,${vy - 22}px)`;
        lab.textContent = `x ${Math.round(gx - scrollX)}`;
        a.set(gx, vy);
      }, ease.out);
      a.press();
      guides.push(g, lab);
      setTimeout(() => lab.classList.add("sw-out"), 900);
      setTimeout(() => fade(g, 700), 1500 / speed);
    },
    async dup(a, t) {
      const m = t.master.el, node = t.el;
      const mr = rd(m), r = rd(node);
      if (t.base === "boxtext") wrap(node);
      await a.move(mr.x + mr.w * 0.6, mr.y + mr.h * 0.55);
      a.mode("arrow");
      const s = selBox(a.color);
      place(s, mr.x, mr.y, mr.w, mr.h);
      a.press();
      await wait(120);

      const ghost = m.cloneNode(true);
      ghost.removeAttribute("id");
      ghost.querySelectorAll("[id]").forEach(n => n.removeAttribute("id"));
      ghost.classList.remove("pending", "sw-in");
      ghost.classList.add("sw-ghost");
      ghost.setAttribute("aria-hidden", "true");
      Object.assign(ghost.style, {
        position: "fixed", left: "0", top: "0", margin: "0", zIndex: "8999", pointerEvents: "none",
        width: mr.w + "px", height: mr.h + "px", boxSizing: "border-box",
      });
      m.after(ghost);
      const tip = el("b", "sw-tip sw-fx", layer);
      tip.style.setProperty("--c", a.color);
      tip.style.setProperty("--ct", textOn(a.color));
      tip.textContent = "⌥ duplicate";
      const offx = a.x - mr.x, offy = a.y - mr.y;
      const dx = r.x - mr.x, dy = r.y - mr.y;

      try {
        await tween(clamp(320 + Math.hypot(dx, dy) * 0.45, 380, 1100), e => {
          const x = mr.x + dx * e, y = mr.y + dy * e;
          const w = mr.w + (r.w - mr.w) * e, h = mr.h + (r.h - mr.h) * e;
          ghost.style.transform = `translate(${x - scrollX}px,${y - scrollY}px) scale(${w / mr.w},${h / mr.h})`;
          place(s, x, y, w, h);
          a.set(x + offx * (w / mr.w), y + offy * (h / mr.h));
          tip.style.transform = `translate(${a.x + 14}px,${a.y + 20}px)`;
        }, ease.inOut);
      } finally {
        ghost.remove();
      }
      a.press();
      tip.remove();
      fade(s);
      reveal(node);
      if (t.base === "boxtext") await typeText(a, node, true);
      for (const sub of t.sub) {
        if (sub.state === "done") continue;
        sub.state = "run";
        if (sub.kind === "text") await typeText(a, sub.el, true);
        else if (sub.kind === "boxtext") { wrap(sub.el); reveal(sub.el); await typeText(a, sub.el, true); }
        else reveal(sub.el);
        finish(sub);
      }
    },
  };

  /* ---------- scheduler ---------- */
  function finish(t) {
    if (t.state === "done") return;
    t.state = "done";
    if (t.kind !== "guide") {
      unwrap(t.el);
      t.el.classList.remove("pending");
      t.el.style.clipPath = "";
    }
    doneCount++;
    updateHud();
    if (doneCount >= tasks.length) complete();
  }

  async function run(a, t) {
    const g = gen;
    a.busy = true;
    t.state = "run";
    try {
      await ACTIONS[t.kind](a, t);
    } catch (err) {
      if (err === ABORT || g !== gen) return;
      console.warn("swarm task failed", err);
    }
    if (g !== gen) return;
    finish(t);
    a.mode("arrow");
    a.busy = false;
  }

  function ready(t) {
    if (t.state !== "todo" || t.owner) return false;
    if (t.dep && t.dep.state !== "done") return false;
    if (t.master && (t.master.state !== "done" || t.master.sub.some(s => s.state !== "done"))) return false;
    return true;
  }

  function schedule() {
    const vh = innerHeight;
    const free0 = agents.every(a => !a.busy);
    const tried = gather(vh, scrollY + vh >= doc.scrollHeight - 4 ? 1.5 : 0.88);
    // If every agent is idle but nothing on screen can start (e.g. a card that
    // straddles the fold is waiting on a piece just below it), look a bit further down.
    if (free0 && !tried) gather(vh, 1.5);
  }
  function gather(vh, reach) {
    const cands = [];
    let count = 0;
    for (const t of tasks) {
      if (t.state === "done") continue;
      const r = t.el.getBoundingClientRect();
      if (r.top > vh * reach) continue;
      if (t.kind !== "guide" && r.width === 0 && r.height === 0) { finish(t); continue; }
      count++;
      if (ready(t)) cands.push({ t, inView: r.bottom > -60 ? 1 : 0, top: r.top });
    }
    backlog = count;
    const free = agents.filter(a => !a.busy);
    if (!free.length || !cands.length) return false;
    cands.sort((p, q) => q.inView - p.inView);
    for (const { t, top } of cands) {
      if (!free.length) break;
      const r = t.el.getBoundingClientRect();
      const tx = r.left + scrollX, ty = top + scrollY;
      let best = 0, bd = Infinity;
      free.forEach((a, i) => {
        const d = Math.hypot(a.x - tx, a.y - ty);
        if (d < bd) { bd = d; best = i; }
      });
      run(free.splice(best, 1)[0], t);
    }
    return true;
  }

  function tour() {
    const max = doc.scrollHeight - innerHeight;
    if (scrollY >= max - 1) { setTour(false); return; }
    if (backlog < 5) window.scrollTo({ top: scrollY + 1.4 * speed, behavior: "instant" });
  }

  function frame(now) {
    requestAnimationFrame(frame);
    const t = now / 1000;
    const cx = scrollX + innerWidth / 2, cy = scrollY + innerHeight / 2;
    for (const a of agents) {
      if (a.busy) continue;
      let tx, ty, k;
      if (phase === "intro") {
        const ang = a.angle + t * 1.8;
        tx = cx + Math.cos(ang) * 120; ty = cy + Math.sin(ang) * 70; k = 0.12;
      } else if (phase === "done") {
        continue; // build finished: agents stay put and fade out, never follow the visitor's cursor
      } else {
        if (!a.wt || now > a.wtUntil || Math.abs(a.wt.y - cy) > innerHeight) {
          a.wt = {
            x: scrollX + innerWidth * (0.12 + Math.random() * 0.76),
            y: scrollY + innerHeight * (0.2 + Math.random() * 0.6),
          };
          a.wtUntil = now + 1200 + Math.random() * 2200;
        }
        tx = a.wt.x; ty = a.wt.y; k = 0.035;
      }
      a.set(a.x + (tx - a.x) * k, a.y + (ty - a.y) * k);
    }
    if (phase === "build" && now - lastSched > 70) {
      lastSched = now;
      schedule();
      if (touring) tour();
    } else if (phase === "build" && touring) tour();
  }

  /* ---------- HUD ---------- */
  const hud = el("div", "sw-hud", document.body);
  hud.setAttribute("role", "region");
  hud.setAttribute("aria-label", "Page build controls");
  hud.innerHTML = `
    <span class="build-part">
      <span class="sw-avs wide">${AGENTS.slice(0, 5).map(([n, c]) => `<i style="background:${c};color:${textOn(c)}">${n[0]}</i>`).join("")}</span>
      <span class="wide sw-count"><b>${AGENTS.length}</b> <span class="muted-h">agents</span></span>
      <span class="sw-sep wide"></span>
      <span class="sw-count"><b data-k="done">0</b><span class="muted-h sw-slash"> / </span><b class="sw-total" data-k="total">0</b><span class="muted-h"> layers</span></span>
      <span class="sw-bar"><i data-k="bar"></i></span>
      <button type="button" data-a="tour" aria-pressed="false">Tour</button>
      <button type="button" data-a="speed" title="Build speed">1×</button>
      <button type="button" data-a="skip">Skip</button>
    </span>
    <span class="done-part">
      <span class="hide-mini sw-done" aria-label="Built by ${AGENTS.length} agents">
        <span class="sw-check" aria-hidden="true">✓</span>
        <span class="sw-count"><b>${AGENTS.length}</b><span class="muted-h"> agents</span></span>
        <span class="sw-count"><b data-k="time">0s</b><span class="muted-h"> build</span></span>
      </span>
      <button type="button" data-a="replay">Replay ↺</button>
      <button type="button" data-a="hide" class="hide-mini" aria-label="Hide agents">Hide<span class="sw-long"> agents</span></button>
    </span>`;
  const q = k => hud.querySelector(`[data-k="${k}"]`);
  const btn = k => hud.querySelector(`[data-a="${k}"]`);

  function updateHud() {
    q("done").textContent = doneCount;
    q("total").textContent = tasks.length;
    q("bar").style.transform = `scaleX(${tasks.length ? doneCount / tasks.length : 0})`;
  }
  function setTour(on) {
    touring = on;
    btn("tour").setAttribute("aria-pressed", String(on));
  }

  hud.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    const act = b.dataset.a;
    if (act === "tour") setTour(!touring);
    else if (act === "speed") { const i = (SPEEDS.indexOf(speed) + 1) % SPEEDS.length; speed = SPEEDS[i]; b.textContent = SPEED_LABELS[i]; }
    else if (act === "skip") skipAll();
    else if (act === "replay") replay();
    else if (act === "hide") { doc.classList.add("sw-hidden"); hud.classList.add("is-mini"); }
  });
  document.addEventListener("click", e => {
    if (e.target.closest("[data-replay]")) replay();
  });
  addEventListener("wheel", () => touring && setTour(false), { passive: true });
  addEventListener("touchmove", () => touring && setTour(false), { passive: true });
    addEventListener("keydown", e => {
    if (e.key === "Escape" && phase !== "done" && phase !== "idle") skipAll();
  });
  // Keyboard users tabbing into the page get the finished page right away,
  // so focus never lands on a link that isn't drawn yet. Mouse and touch
  // clicks also move focus, so only count focus that came from the keyboard.
  let pointerFocus = false;
  addEventListener("pointerdown", () => { pointerFocus = true; }, { capture: true, passive: true });
  addEventListener("keydown", () => { pointerFocus = false; }, { capture: true });
  document.addEventListener("focusin", e => {
    if (pointerFocus) return;
    if (phase !== "done" && phase !== "idle" && site.contains(e.target)) skipAll();
  });

  /* ---------- lifecycle ---------- */
  function clearFx() {
    layer.querySelectorAll(".sw-fx").forEach(n => n.remove());
    site.querySelectorAll(".sw-ghost").forEach(n => n.remove());
    guides = [];
  }

  function complete() {
    if (phase === "done") return;
    phase = "done";
    setTour(false);
    doc.classList.remove("sw-building");
    guides.forEach(g => fade(g, 700));
    guides = [];
    q("time").textContent = Math.max(1, Math.round((performance.now() - startTime) / 1000)) + "s";
    hud.classList.add("is-done");
    agents.forEach(a => { a.busy = false; a.mode("arrow"); });
    doc.classList.add("sw-hidden"); // fade the agent cursors out once the page is built
  }

  function skipAll() {
    if (phase === "done") return;
    gen++;
    clearFx();
    for (const t of tasks) if (t.state !== "done") finish(t);
    complete();
  }

  function start() {
    gen++;
    clearFx();
    doc.classList.add("sw-on", "sw-building");
    doc.classList.remove("sw-hidden");
    hud.classList.remove("is-done", "is-mini");
    tasks = collect();
    for (const t of tasks) {
      t.state = "todo";
      if (t.kind !== "guide") t.el.classList.add("pending");
    }
    doneCount = 0;
    updateHud();
    agents.forEach(a => { a.busy = false; a.mode("arrow"); });

    phase = "intro";
    const intro = el("div", "sw-intro", document.body);
    intro.textContent = `Spinning up ${AGENTS.length} agents…`;
    const g = gen;
    setTimeout(() => {
      fade(intro, 500);
      if (g !== gen) return;
      phase = "build";
      startTime = performance.now();
    }, 1700);
  }

  function replay() {
    gen++;
    clearFx();
    for (const t of tasks) {
      if (t.kind === "guide") continue;
      unwrap(t.el);
      t.el.style.clipPath = "";
      t.el.classList.remove("pending", "sw-in");
    }
    window.scrollTo({ top: 0, behavior: "instant" });
    const cx = scrollX + innerWidth / 2, cy = scrollY + innerHeight / 2;
    agents.forEach(a => a.set(cx, cy));
    phase = "idle";
    start();
  }

  // Boot
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  if (!location.hash) window.scrollTo(0, 0);
  agents = AGENTS.map(([n, c], i) => new Agent(n, c, i));
  agents.forEach(a => a.set(scrollX + innerWidth / 2, scrollY + innerHeight / 2));
  const boot = () => { start(); requestAnimationFrame(frame); };
  // Wait for fonts so measured boxes match the final layout.
  (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(boot);
})();
