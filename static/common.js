/* Shared helpers: config, saved orders, snow, reveal-on-scroll. */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const money = n => Number(n).toLocaleString("ru-RU").replace(/ /g, " ");

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const savedOrders = () => store.get("wb_orders", []);
const saveOrder = token => { const l = savedOrders().filter(t => t !== token); l.unshift(token); store.set("wb_orders", l.slice(0, 5)); };

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  let body = {};
  try { body = await res.json(); } catch {}
  if (!res.ok) throw new Error(body.error || "Не удалось связаться с сервером. Проверьте интернет.");
  return body;
}

let CONFIG = null;
async function loadConfig() {
  CONFIG = await api("/api/config");
  $$("[data-price]").forEach(el => el.textContent = money(CONFIG.prices[el.dataset.price]));
  $$("[data-ev]").forEach(el => { if (CONFIG.event[el.dataset.ev]) el.textContent = CONFIG.event[el.dataset.ev]; });
  $$("[data-contact]").forEach(el => {
    const c = CONFIG.contact || "";
    if (!c) return;
    el.textContent = c;
    el.href = c.startsWith("@") ? "https://t.me/" + c.slice(1) : c.startsWith("+") ? "tel:" + c.replace(/\s/g, "") : c;
    el.target = "_blank"; el.rel = "noopener";
  });
  return CONFIG;
}

/* gentle snowfall */
(function snow() {
  const c = $("#snow");
  if (!c || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const ctx = c.getContext("2d");
  let w, h, flakes, dpr;
  const resize = () => {
    dpr = Math.min(devicePixelRatio || 1, 2);
    w = c.width = innerWidth * dpr; h = c.height = innerHeight * dpr;
    const n = Math.round(Math.min(90, innerWidth / 14));
    flakes = Array.from({ length: n }, () => ({
      x: Math.random() * w, y: Math.random() * h, r: (Math.random() * 1.8 + .6) * dpr,
      s: (Math.random() * .35 + .15) * dpr, d: Math.random() * Math.PI * 2, o: Math.random() * .5 + .35,
    }));
  };
  resize(); addEventListener("resize", resize);
  (function tick() {
    ctx.clearRect(0, 0, w, h);
    for (const f of flakes) {
      f.y += f.s; f.d += .01; f.x += Math.sin(f.d) * .25 * dpr;
      if (f.y > h + 5) { f.y = -5; f.x = Math.random() * w; }
      ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(160,170,195,${f.o * .55})`; ctx.fill();
    }
    requestAnimationFrame(tick);
  })();
})();

/* reveal on scroll */
(function reveal() {
  const els = $$(".reveal");
  if (!("IntersectionObserver" in window)) return els.forEach(e => e.classList.add("in"));
  const io = new IntersectionObserver(es => es.forEach(e => {
    if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
  }), { rootMargin: "0px 0px -8% 0px" });
  els.forEach((e, i) => { e.style.transitionDelay = (i % 4) * 80 + "ms"; io.observe(e); });
})();

/* sticky nav */
(function nav() {
  const n = $("#nav");
  if (!n) return;
  const on = () => n.classList.toggle("scrolled", scrollY > 30);
  on(); addEventListener("scroll", on, { passive: true });
})();
