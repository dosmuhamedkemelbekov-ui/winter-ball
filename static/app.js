/* Landing page: countdown, ticket picker, order form. */
(async function main() {
  try { await loadConfig(); } catch (e) { console.warn(e); }

  // savings line
  if (CONFIG) {
    const save = CONFIG.prices.single * 2 - CONFIG.prices.pair;
    $("#saving").textContent = save > 0 ? `экономия ${money(save)} тг` : "";
    if (CONFIG.seats_left !== null && CONFIG.seats_left !== undefined) {
      const s = $("#seats");
      s.hidden = false;
      s.textContent = CONFIG.seats_left > 0 ? `Осталось мест: ${CONFIG.seats_left}` : "Все билеты проданы";
    }
    if (!CONFIG.sales_open) {
      $$("[data-buy]").forEach(b => { b.disabled = true; b.textContent = "Продажа закрыта"; });
    }
  }

  // "my ticket"
  const mine = savedOrders();
  if (mine.length) { const a = $("#myTicket"); a.hidden = false; a.href = "/t/" + mine[0]; }

  // countdown
  const target = new Date(CONFIG?.event?.date_iso || "2026-12-04T16:00:00+05:00").getTime();
  const pad = n => String(n).padStart(2, "0");
  const tick = () => {
    let s = Math.max(0, Math.floor((target - Date.now()) / 1000));
    if (s === 0) { $("#countdown").innerHTML = "<div style='padding:14px 22px'><b>Бал уже начался ✨</b></div>"; return; }
    $("#cd-d").textContent = Math.floor(s / 86400); s %= 86400;
    $("#cd-h").textContent = pad(Math.floor(s / 3600)); s %= 3600;
    $("#cd-m").textContent = pad(Math.floor(s / 60));
    $("#cd-s").textContent = pad(s % 60);
    setTimeout(tick, 1000);
  };
  tick();

  // modal
  const modal = $("#buy"), form = $("#buyForm"), err = $("#buyErr");
  let kind = "single", lastFocus = null;
  const setKind = k => {
    kind = k;
    $$(".chip", form).forEach(c => c.setAttribute("aria-pressed", c.dataset.kind === k));
    $("#g2").hidden = k !== "pair";
    $("#buySum").textContent = money(CONFIG ? CONFIG.prices[k] : (k === "pair" ? 2000 : 1500));
  };
  const open = k => {
    setKind(k); err.textContent = ""; lastFocus = document.activeElement;
    modal.classList.add("open"); document.body.style.overflow = "hidden";
    setTimeout(() => form.name.focus(), 250);
  };
  const close = () => { modal.classList.remove("open"); document.body.style.overflow = ""; lastFocus?.focus(); };
  $$("[data-buy]").forEach(b => b.addEventListener("click", () => open(b.dataset.buy)));
  $$("[data-close]", modal).forEach(b => b.addEventListener("click", close));
  addEventListener("keydown", e => { if (e.key === "Escape" && modal.classList.contains("open")) close(); });
  $$(".chip", form).forEach(c => c.addEventListener("click", () => setKind(c.dataset.kind)));

  // phone mask: +7 7xx xxx xx xx
  form.phone.addEventListener("input", e => {
    let d = e.target.value.replace(/\D/g, "");
    if (d.startsWith("8")) d = "7" + d.slice(1);
    if (d && !d.startsWith("7")) d = "7" + d;
    d = d.slice(0, 11);
    const p = [d.slice(1, 4), d.slice(4, 7), d.slice(7, 9), d.slice(9, 11)].filter(Boolean);
    e.target.value = d ? "+7 " + p.join(" ") : "";
  });

  form.addEventListener("submit", async e => {
    e.preventDefault();
    err.textContent = "";
    $$("input", form).forEach(i => i.removeAttribute("aria-invalid"));
    const data = { kind, name: form.name.value.trim(), phone: form.phone.value, guest2: form.guest2.value.trim(), telegram: form.telegram.value.trim() };
    const fail = (input, msg) => { input.setAttribute("aria-invalid", "true"); input.focus(); err.textContent = msg; };
    if (data.name.length < 2) return fail(form.name, "Укажите имя и фамилию");
    if (kind === "pair" && data.guest2.length < 2) return fail(form.guest2, "Укажите имя второго гостя");
    if (data.phone.replace(/\D/g, "").length !== 11) return fail(form.phone, "Проверьте номер телефона");
    const btn = $("#buyBtn"), label = btn.innerHTML;
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Создаём заявку…';
    try {
      const order = await api("/api/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      saveOrder(order.token);
      location.href = "/t/" + order.token;
    } catch (ex) {
      err.textContent = ex.message;
      btn.disabled = false; btn.innerHTML = label;
    }
  });
})();
