/* Site behavior: mobile menu, current-section nav state, tagline word reveal. */
(() => {
  "use strict";
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- Mobile menu ---------- */
  const toggle = document.querySelector(".menu-toggle");
  const menu = document.getElementById("menu");
  function setMenu(open) {
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    document.body.style.overflow = open ? "hidden" : "";
    if (open) {
      menu.hidden = false;
      requestAnimationFrame(() => requestAnimationFrame(() => menu.classList.add("open")));
    } else {
      menu.classList.remove("open");
      setTimeout(() => { if (!menu.classList.contains("open")) menu.hidden = true; }, 300);
    }
  }
  if (toggle && menu) {
    toggle.addEventListener("click", () => setMenu(toggle.getAttribute("aria-expanded") !== "true"));
    menu.addEventListener("click", e => { if (e.target.closest("a")) setMenu(false); });
    addEventListener("keydown", e => { if (e.key === "Escape" && !menu.hidden) setMenu(false); });
  }

  /* ---------- Light / dark theme ---------- */
  const root = document.documentElement;
  const themeBtn = document.querySelector(".theme-toggle");
  const sysDark = matchMedia("(prefers-color-scheme: dark)");
  const current = () => root.dataset.theme || (sysDark.matches ? "dark" : "light");
  function syncTheme() {
    const t = current();
    root.dataset.theme = t;
    if (themeBtn) themeBtn.setAttribute("aria-label", t === "dark" ? "Switch to light theme" : "Switch to dark theme");
  }
  if (themeBtn) {
    themeBtn.addEventListener("click", () => {
      root.dataset.theme = current() === "dark" ? "light" : "dark";
      try { localStorage.setItem("theme", root.dataset.theme); } catch (e) {}
      syncTheme();
    });
  }
  sysDark.addEventListener("change", () => {
    let saved = null;
    try { saved = localStorage.getItem("theme"); } catch (e) {}
   if (!saved) { root.dataset.theme = "light"; syncTheme(); } // default stays light
  });
  syncTheme();

  /* ---------- Current section in nav ---------- */
  const navLinks = [...document.querySelectorAll('.links a[href^="#"]')];
  const sections = navLinks.map(a => document.querySelector(a.getAttribute("href"))).filter(Boolean);
  const spy = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const id = "#" + e.target.id;
      navLinks.forEach(a => (a.getAttribute("href") === id ? a.setAttribute("aria-current", "true") : a.removeAttribute("aria-current")));
    }
  }, { rootMargin: "-45% 0px -50% 0px" });
  sections.forEach(s => spy.observe(s));

  /* ---------- Copy email ---------- */
  document.querySelectorAll("[data-copy]").forEach(btn => {
    const label = btn.querySelector("[data-copy-label]");
    const status = document.querySelector(".copy-status");
    btn.addEventListener("click", async () => {
      const text = btn.dataset.copy;
      let ok = false;
      try { await navigator.clipboard.writeText(text); ok = true; }
      catch (e) {
        const ta = Object.assign(document.createElement("textarea"), { value: text });
        ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        try { ok = document.execCommand("copy"); } catch (e2) {}
        ta.remove();
      }
      if (!ok) return;
      btn.classList.add("is-done"); if (label) label.textContent = "Copied";
      if (status) status.textContent = "Email address copied to your clipboard.";
      clearTimeout(btn._t);
      btn._t = setTimeout(() => { btn.classList.remove("is-done"); if (label) label.textContent = "Copy email"; if (status) status.textContent = ""; }, 2200);
    });
  });

  /* ---------- Chart bars grow when the chart is on screen ---------- */
  const chart = document.querySelector(".chart");
  if (chart) {
    // Wait until the swarm has actually revealed the bars, then let them grow.
    const shown = el => { for (; el && el !== document.body; el = el.parentElement) if (+getComputedStyle(el).opacity < 0.5) return false; return true; };
    const bar = chart.querySelector(".mt-bar");
    let watching = false;
    const check = () => {
      if (shown(bar)) { chart.classList.add("in"); io.disconnect(); return; }
      if (watching) setTimeout(check, 150);
    };
    const io = new IntersectionObserver(es => es.forEach(e => {
      watching = e.isIntersecting;
      if (watching) check();
    }), { threshold: 0.3 });
    io.observe(chart);
  }

  /* ---------- Tagline reveal (word by word on scroll) ---------- */
  const tag = document.querySelector(".tagline-words");
  const KEY = { "facts": "k-blue", "retrieval,": "k-violet", "evals": "k-violet", "monitoring": "k-violet", "honest.": "k-green" };
  if (tag) {
    const parts = tag.innerHTML.split(/(<br>|\s+)/);
    tag.innerHTML = parts.map(p => (p === "<br>" || /^\s*$/.test(p) ? p : `<span class="w${KEY[p] ? " " + KEY[p] : ""}">${p}</span>`)).join("");
    const words = [...tag.querySelectorAll(".w")];
    if (reduce) {
      words.forEach(w => w.classList.add("on"));
    } else {
      let ticking = false;
      const update = () => {
        ticking = false;
        const line = innerHeight * 0.62;
        for (const w of words) if (!w.classList.contains("on") && w.getBoundingClientRect().top < line) w.classList.add("on");
      };
      const onScroll = () => { if (!ticking) { ticking = true; requestAnimationFrame(update); } };
      addEventListener("scroll", onScroll, { passive: true });
      addEventListener("resize", onScroll, { passive: true });
      update();
    }
  }
})();
