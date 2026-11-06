/* Order / ticket page: payment → receipt → waiting → ticket with QR. Door check for admins. */
const token = location.pathname.split("/").pop();
const root = $("#root");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const adminKey = store.get("wb_admin_key", "");
let order = null, pollTimer = null, justChecked = false;

const STEPS = ["Данные", "Оплата", "Чек", "Билет"];
const stepper = n => `<ol class="stepper">${STEPS.map((s, i) => `<li class="${i < n ? "done" : i === n ? "now" : ""}">${s}</li>`).join("")}</ol>`;
const icon = {
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M12 15V4m0 0-4 4m4-4 4 4M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 0c.6 6.5 5.5 11.4 12 12-6.5.6-11.4 5.5-12 12-.6-6.5-5.5-11.4-12-12C6.5 11.4 11.4 6.5 12 0z"/></svg>',
  tg: '<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="24" fill="#2AABEE"/><path fill="#fff" d="M10.9 23.7c7-3 11.6-5 13.9-6 6.6-2.7 8-3.2 8.9-3.2.2 0 .6 0 .9.3.2.2.3.5.3.7v.8c-.4 3.9-1.9 13.4-2.7 17.8-.3 1.9-1 2.5-1.6 2.5-1.4.1-2.4-.9-3.8-1.8l-5.3-3.6c-2.3-1.5-.8-2.4.5-3.8.3-.4 6.4-5.9 6.5-6.4 0-.1 0-.3-.1-.4-.2-.1-.4 0-.5 0-.2.1-3.6 2.3-10.1 6.7-1 .7-1.8 1-2.6 1-.9 0-2.5-.5-3.8-.9-1.5-.5-2.7-.8-2.6-1.6.1-.4.7-.9 1.8-1.4z"/></svg>',
};

function tgBlock() {
  if (!CONFIG?.bot_username || order.tg_linked) return order.tg_linked
    ? `<p class="muted center" style="margin-top:16px">✓ Telegram подключён — билет придёт туда автоматически.</p>` : "";
  return `<a class="tg" href="https://t.me/${esc(CONFIG.bot_username)}?start=${esc(order.token)}" target="_blank" rel="noopener">
    ${icon.tg}<div><b>Получить билет в Telegram</b>Нажмите «Старт» в боте — он пришлёт QR-код, как только оплата подтвердится.</div></a>`;
}

function copyBtn(value, label = "Копировать") {
  return `<button class="copy" type="button" data-copy="${esc(value)}">${label}</button>`;
}

function renderPay() {
  const rejected = order.status === "rejected";
  root.innerHTML = `${stepper(1)}
    <h1 class="pg">Оплата через Kaspi</h1>
    <p class="lead">Заявка №${esc(order.number)} · ${esc(order.kind_label)}${order.guest2 ? ` · ${esc(order.name)} и ${esc(order.guest2)}` : ` · ${esc(order.name)}`}</p>
    ${rejected ? `<div class="banner err">Организаторы не смогли подтвердить оплату по прошлому чеку. Проверьте перевод и загрузите чек ещё раз — или напишите <a data-contact href="#">организаторам</a>.</div>` : ""}
    <div class="card pay">
      <div class="amount"><small>К оплате</small><b>${money(order.amount)} тг</b><span>Ровно эту сумму, одним переводом</span></div>
      <div class="rows">
        <div class="row"><div><small>Номер Kaspi</small><b>${esc(CONFIG.kaspi_phone)}</b></div>${copyBtn(CONFIG.kaspi_phone.replace(/\s/g, ""))}</div>
        <div class="row"><div><small>Получатель</small><b>${esc(CONFIG.kaspi_name)}</b></div></div>
        <div class="row"><div><small>Комментарий к переводу</small><b>${esc(order.code)}</b></div>${copyBtn(order.code)}</div>
      </div>
    </div>
    <ol class="how">
      <li>Откройте <b>Kaspi.kz → Переводы → По номеру телефона</b>.</li>
      <li>Вставьте номер, сумму <b>${money(order.amount)} тг</b> и код <b>${esc(order.code)}</b> в сообщение.</li>
      <li>После перевода сохраните чек (кнопка «Поделиться» → скриншот или PDF) и загрузите его ниже.</li>
    </ol>
    <label class="drop" id="drop">
      ${icon.upload}<b>Загрузить чек</b><span>Фото, скриншот или PDF · до 10 МБ</span>
      <input type="file" id="file" accept="image/*,application/pdf" class="sr">
    </label>
    <div class="preview" id="preview"><img alt=""><div><b id="pname"></b><small id="psize"></small></div></div>
    <p class="err" id="upErr" role="alert"></p>
    <button class="btn block" id="send" disabled>Отправить чек на проверку</button>
    <p class="fine">Ссылка на эту страницу сохранена в браузере — можно вернуться позже через «Мой билет».</p>`;

  const input = $("#file"), drop = $("#drop"), send = $("#send");
  let file = null;
  const pick = f => {
    if (!f) return;
    $("#upErr").textContent = "";
    if (f.size > 10 * 1024 * 1024) { $("#upErr").textContent = "Файл больше 10 МБ"; return; }
    file = f;
    const pv = $("#preview"); pv.classList.add("on");
    $("#pname").textContent = f.name; $("#psize").textContent = (f.size / 1024 / 1024).toFixed(2) + " МБ";
    const img = $("img", pv);
    if (f.type.startsWith("image/")) img.src = URL.createObjectURL(f); else img.removeAttribute("src");
    send.disabled = false;
  };
  input.addEventListener("change", () => pick(input.files[0]));
  ["dragenter", "dragover"].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", e => pick(e.dataTransfer.files[0]));
  send.addEventListener("click", async () => {
    if (!file) return;
    send.disabled = true; send.innerHTML = '<span class="spin"></span> Отправляем…';
    const fd = new FormData(); fd.append("file", file);
    try {
      order = await api(`/api/orders/${token}/receipt`, { method: "POST", body: fd });
      render();
    } catch (e) {
      $("#upErr").textContent = e.message;
      send.disabled = false; send.textContent = "Отправить чек на проверку";
    }
  });
}

function renderWait() {
  root.innerHTML = `${stepper(2)}
    <div class="card wait">
      <div class="orb">${icon.star}</div>
      <h2>Проверяем оплату</h2>
      <p>Чек у организаторов. Как только они подтвердят перевод, здесь появится ваш билет с QR-кодом — страница обновится сама.</p>
    </div>
    ${tgBlock()}
    <p class="fine">Заявка №${esc(order.number)} · код ${esc(order.code)}</p>`;
}

function qrSvg(text) {
  const q = qrcode(0, "M"); q.addData(text); q.make();
  const n = q.getModuleCount(); let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c},${r}h1v1h-1z`;
  return { svg: `<svg viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><path fill="#1a2849" d="${d}"/></svg>`, q, n };
}

function renderTicket() {
  const url = location.origin + "/t/" + order.token;
  const ev = CONFIG.event;
  const guests = order.guest2 ? `${esc(order.name)}<br>${esc(order.guest2)}` : esc(order.name);
  root.innerHTML = `${stepper(4)}
    <h1 class="pg">Ваш билет готов</h1>
    <p class="lead">Покажите QR-код на входе. Скриншот тоже подойдёт.</p>
    <article class="tk" id="tk">
      ${order.checked_in ? '<span class="tk-used">ВХОД ОТМЕЧЕН</span>' : ""}
      <div class="tk-top"><small>ЕАГИ × DOSTEAM</small><span class="t1">Зимний</span><span class="t2">бал</span></div>
      <div class="tk-grid">
        <div class="wide"><small>${order.guest2 ? "Гости" : "Гость"}</small><b>${guests}</b></div>
        <div><small>Дата</small><b>${esc(ev.date)}</b></div>
        <div><small>Время</small><b>${esc(ev.time)}</b></div>
        <div class="wide"><small>Место</small><b>${esc(ev.place)}</b></div>
        <div><small>Билет</small><b>${esc(order.kind_label)}</b></div>
        <div><small>Номер</small><b>№ ${esc(order.number)}</b></div>
      </div>
      <div class="tk-cut"><span></span></div>
      <div class="tk-qr"><div class="qr">${qrSvg(url).svg}</div><p>${esc(order.code)}</p></div>
    </article>
    <div class="actions">
      <button class="btn" id="dl">Сохранить картинкой</button>
      <button class="btn ghost" onclick="print()">Распечатать</button>
    </div>
    ${tgBlock()}
    <p class="fine">Дресс-код: ${esc(ev.dress_girls)}, ${esc(ev.dress_boys).toLowerCase()}.</p>`;
  $("#dl").addEventListener("click", () => downloadPng(url));
}

async function downloadPng(url) {
  await document.fonts.ready;
  const W = 1080, H = 1720, c = document.createElement("canvas"), x = c.getContext("2d");
  c.width = W; c.height = H;
  const g = x.createLinearGradient(0, 0, W * .4, H); g.addColorStop(0, "#253a66"); g.addColorStop(.55, "#1a2849"); g.addColorStop(1, "#121d38");
  x.fillStyle = g; x.beginPath(); x.roundRect(0, 0, W, H, 60); x.fill();
  x.textAlign = "center"; x.fillStyle = "#d7bd8a"; x.font = "600 26px Manrope";
  x.fillText("ЕАГИ  ×  DOSTEAM", W / 2, 110);
  x.fillStyle = "#fbf8f2"; x.font = "400 120px 'Cormorant Garamond'"; x.fillText("ЗИМНИЙ", W / 2, 250);
  x.fillStyle = "#d7bd8a"; x.font = "150px 'Great Vibes','Marck Script'"; x.fillText("бал", W / 2, 370);
  const ev = CONFIG.event;
  const rows = [["ГОСТИ", order.guest2 ? `${order.name}, ${order.guest2}` : order.name], ["ДАТА И ВРЕМЯ", `${ev.date} · ${ev.time}`], ["МЕСТО", ev.place], ["БИЛЕТ", `${order.kind_label} · № ${order.number}`]];
  let y = 470;
  for (const [k, v] of rows) {
    x.fillStyle = "rgba(251,248,242,.55)"; x.font = "600 22px Manrope"; x.fillText(k, W / 2, y);
    x.fillStyle = "#fbf8f2"; x.font = "500 44px 'Cormorant Garamond'"; x.fillText(v, W / 2, y + 54, W - 120); y += 120;
  }
  x.strokeStyle = "rgba(251,248,242,.25)"; x.setLineDash([14, 12]); x.lineWidth = 3;
  x.beginPath(); x.moveTo(70, y); x.lineTo(W - 70, y); x.stroke(); x.setLineDash([]);
  const { q, n } = qrSvg(url), size = 560, qx = (W - size) / 2, qy = y + 60, m = size / (n + 4);
  x.fillStyle = "#fff"; x.beginPath(); x.roundRect(qx, qy, size, size, 30); x.fill();
  x.fillStyle = "#1a2849";
  for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) if (q.isDark(r, col)) x.fillRect(qx + (col + 2) * m, qy + (r + 2) * m, Math.ceil(m), Math.ceil(m));
  x.fillStyle = "rgba(251,248,242,.6)"; x.font = "600 28px Manrope"; x.fillText(order.code, W / 2, qy + size + 70);
  const a = document.createElement("a");
  a.download = `zimniy-bal-bilet-${order.number}.png`; a.href = c.toDataURL("image/png"); a.click();
}

/* door check for organisers (admin key saved via /admin) */
function renderDoor() {
  if (!adminKey) return;
  const box = document.createElement("div");
  let cls = "bad", title = "НЕ ОПЛАЧЕН", text = "Билет ещё не подтверждён. Не пропускать.", btn = "";
  if (order.status === "paid" && !order.checked_in) { cls = "ok"; title = "БИЛЕТ ДЕЙСТВИТЕЛЕН"; text = `${order.kind_label} · ${order.guest2 ? "2 гостя" : "1 гость"}`; btn = '<button class="btn" id="checkin">Отметить вход</button>'; }
  else if (order.status === "paid" && justChecked) { cls = "ok"; title = "ВХОД ОТМЕЧЕН ✓"; text = `Проходите! ${order.guest2 ? "2 гостя" : "1 гость"}`; justChecked = false; }
  else if (order.status === "paid") { cls = "used"; title = "УЖЕ ПРОШЁЛ"; text = "По этому билету вход уже отмечен."; }
  box.className = "door " + cls;
  box.innerHTML = `<b>${title}</b><p>${esc(text)}</p>${btn}`;
  root.prepend(box);
  $("#checkin")?.addEventListener("click", async e => {
    e.target.disabled = true;
    try {
      const res = await api(`/api/admin/orders/${token}/checkin`, { method: "POST", headers: { "X-Admin-Key": adminKey } });
      justChecked = !res.already; order = res;
      render();
    } catch (err) { alert(err.message); e.target.disabled = false; }
  });
}

function render() {
  clearTimeout(pollTimer);
  if (order.status === "paid") renderTicket();
  else if (order.status === "review") { renderWait(); pollTimer = setTimeout(refresh, 5000); }
  else renderPay();
  renderDoor();
  $$("[data-copy]").forEach(b => b.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); } catch {
      const t = document.createElement("textarea"); t.value = b.dataset.copy; document.body.append(t); t.select(); document.execCommand("copy"); t.remove();
    }
    const old = b.textContent; b.textContent = "Скопировано ✓"; b.classList.add("ok");
    setTimeout(() => { b.textContent = old; b.classList.remove("ok"); }, 1600);
  }));
  loadContacts();
}

function loadContacts() {
  $$("[data-contact]").forEach(el => {
    const c = CONFIG?.contact; if (!c) return;
    el.href = c.startsWith("@") ? "https://t.me/" + c.slice(1) : c; el.target = "_blank";
  });
}

async function refresh() {
  try {
    const next = await api("/api/orders/" + token);
    const changed = !order || next.status !== order.status || next.tg_linked !== order.tg_linked || next.checked_in !== order.checked_in;
    order = next;
    if (changed) render(); else if (order.status === "review") pollTimer = setTimeout(refresh, 5000);
  } catch (e) {
    if (!order) root.innerHTML = `<div class="card wait"><h2>Заявка не найдена</h2><p>${esc(e.message)}</p><a class="btn" href="/" style="margin-top:20px">На главную</a></div>`;
    else pollTimer = setTimeout(refresh, 8000);
  }
}

document.addEventListener("visibilitychange", () => { if (!document.hidden && order?.status === "review") refresh(); });

(async () => {
  try { await loadConfig(); } catch {}
  await refresh();
  if (order && !adminKey) saveOrder(token);
})();
