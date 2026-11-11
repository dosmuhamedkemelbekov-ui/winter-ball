"""Зимний бал — сайт продажи билетов.

Оплата: Kaspi-перевод + чек. Чек уходит админам в Telegram с кнопками
«Подтвердить / Отклонить». После подтверждения гость автоматически видит
билет с QR-кодом на сайте и получает его в Telegram (если привязал бота).
"""
import asyncio
import html
import json
import logging
import re
import secrets
import sqlite3
import time
from pathlib import Path

from aiohttp import ClientSession, ClientTimeout, FormData, web

BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"
DATA = BASE / "data"
RECEIPTS = DATA / "receipts"
RECEIPTS.mkdir(parents=True, exist_ok=True)

CFG = json.loads((BASE / "config.json").read_text("utf-8"))
PRICES = CFG.get("prices", {"single": 1500, "pair": 2000})
SEATS = {"single": 1, "pair": 2}
KIND_LABEL = {"single": "1 человек", "pair": "1+1 (на двоих)"}
ADMIN_IDS = {int(x) for x in CFG.get("admin_ids", []) if str(x).strip()}
MAX_UPLOAD = 10 * 1024 * 1024

log = logging.getLogger("ball")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# ---------------------------------------------------------------- storage
db = sqlite3.connect(DATA / "orders.sqlite3", check_same_thread=False)
db.row_factory = sqlite3.Row
db.executescript("""
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  code TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  guest2 TEXT DEFAULT '',
  telegram TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  receipt TEXT DEFAULT '',
  tg_chat INTEGER,
  admin_msgs TEXT DEFAULT '[]',
  decided_by TEXT DEFAULT '',
  created REAL NOT NULL,
  receipt_at REAL,
  paid_at REAL,
  checked_in REAL
);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
""")
db.commit()


def q(sql, *args):
    cur = db.execute(sql, args)
    db.commit()
    return cur


def get_order(token=None, oid=None):
    if token:
        return q("SELECT * FROM orders WHERE token=?", token).fetchone()
    return q("SELECT * FROM orders WHERE id=?", oid).fetchone()


def seats_taken():
    rows = q("SELECT kind, COUNT(*) c FROM orders WHERE status IN ('paid','review') GROUP BY kind").fetchall()
    return sum(SEATS[r["kind"]] * r["c"] for r in rows)


def seats_left():
    cap = int(CFG.get("capacity") or 0)
    return None if cap <= 0 else max(cap - seats_taken(), 0)


def ticket_no(row):
    return f"{row['id']:04d}"


def public(row):
    return {
        "token": row["token"], "code": row["code"], "kind": row["kind"],
        "kind_label": KIND_LABEL[row["kind"]], "amount": row["amount"],
        "name": row["name"], "guest2": row["guest2"], "status": row["status"],
        "number": ticket_no(row), "checked_in": bool(row["checked_in"]),
        "tg_linked": bool(row["tg_chat"]),
    }


def new_code():
    while True:
        code = f"ZB-{secrets.randbelow(9000) + 1000}"
        if not q("SELECT 1 FROM orders WHERE code=?", code).fetchone():
            return code


# ---------------------------------------------------------------- telegram
TG_URL = f"https://api.telegram.org/bot{CFG.get('telegram_token', '')}/"
http: ClientSession | None = None


async def tg(method, data=None, file=None):
    if not CFG.get("telegram_token"):
        return None
    try:
        if file:
            form = FormData()
            for k, v in (data or {}).items():
                form.add_field(k, v if isinstance(v, str) else json.dumps(v))
            field, path, fname = file
            form.add_field(field, path.read_bytes(), filename=fname)
            resp = await http.post(TG_URL + method, data=form)
        else:
            resp = await http.post(TG_URL + method, json=data or {})
        body = await resp.json()
        if not body.get("ok"):
            log.warning("telegram %s: %s", method, body.get("description"))
            return None
        return body["result"]
    except Exception as e:  # network hiccups must never break the site
        log.warning("telegram %s failed: %s", method, e)
        return None


def esc(s):
    return html.escape(str(s or ""))


def admin_caption(row, verdict=""):
    lines = [
        f"<b>🎟 Заявка №{ticket_no(row)}</b> · код <code>{esc(row['code'])}</code>",
        f"Билет: {esc(KIND_LABEL[row['kind']])} — <b>{row['amount']} тг</b>",
        f"Имя: {esc(row['name'])}",
    ]
    if row["guest2"]:
        lines.append(f"Второй гость: {esc(row['guest2'])}")
    lines.append(f"Телефон: {esc(row['phone'])}")
    if row["telegram"]:
        lines.append(f"Telegram: {esc(row['telegram'])}")
    lines.append("")
    lines.append(verdict or "Проверьте в Kaspi, что перевод пришёл, и сумма совпадает.")
    return "\n".join(lines)


def decision_kb(oid):
    return {"inline_keyboard": [[
        {"text": "✅ Подтвердить", "callback_data": f"ok:{oid}"},
        {"text": "❌ Отклонить", "callback_data": f"no:{oid}"},
    ]]}


def admin_targets():
    chat = str(CFG.get("admin_chat_id") or "").strip()
    return [chat] if chat else [str(i) for i in ADMIN_IDS]


async def notify_admins(row):
    path = RECEIPTS / row["receipt"]
    is_photo = path.suffix in (".jpg", ".png")
    sent = []
    for chat in admin_targets():
        data = {"chat_id": chat, "caption": admin_caption(row), "parse_mode": "HTML",
                "reply_markup": decision_kb(row["id"])}
        res = await tg("sendPhoto" if is_photo else "sendDocument", data,
                       ("photo" if is_photo else "document", path, path.name))
        if res:
            sent.append([res["chat"]["id"], res["message_id"]])
    q("UPDATE orders SET admin_msgs=? WHERE id=?", json.dumps(sent), row["id"])


def ticket_link(row):
    return f"{CFG['public_url'].rstrip('/')}/t/{row['token']}"


async def send_ticket(row):
    if not row["tg_chat"]:
        return
    who = esc(row["name"]) + (f" и {esc(row['guest2'])}" if row["guest2"] else "")
    text = (f"✨ <b>Оплата подтверждена!</b>\n\n"
            f"Билет №{ticket_no(row)} · {esc(KIND_LABEL[row['kind']])}\nГости: {who}\n\n"
            f"📅 {esc(CFG['event']['date'])} · {esc(CFG['event']['time'])}\n📍 {esc(CFG['event']['place'])}\n\n"
            f"Ваш билет с QR-кодом: {ticket_link(row)}\n"
            f"Покажите QR на входе. До встречи на Зимнем балу! ❄️")
    await tg("sendMessage", {"chat_id": row["tg_chat"], "text": text, "parse_mode": "HTML",
                             "disable_web_page_preview": True})


async def decide(oid, ok, by):
    """Confirm or reject an order. Returns (changed, row)."""
    row = get_order(oid=oid)
    if not row:
        return False, None
    if ok and row["status"] == "paid" or not ok and row["status"] == "rejected":
        return False, row
    if ok:
        q("UPDATE orders SET status='paid', paid_at=?, decided_by=? WHERE id=?", time.time(), by, oid)
    else:
        q("UPDATE orders SET status='rejected', decided_by=? WHERE id=?", by, oid)
    row = get_order(oid=oid)
    verdict = (f"✅ <b>Подтверждено</b> — {esc(by)}" if ok else
               f"❌ <b>Отклонено</b> — {esc(by)}")
    for chat, mid in json.loads(row["admin_msgs"] or "[]"):
        await tg("editMessageCaption", {"chat_id": chat, "message_id": mid,
                                        "caption": admin_caption(row, verdict), "parse_mode": "HTML",
                                        "reply_markup": {"inline_keyboard": []}})
    if ok:
        await send_ticket(row)
    elif row["tg_chat"]:
        await tg("sendMessage", {"chat_id": row["tg_chat"], "text":
                 "Не получилось подтвердить оплату по вашему чеку. Откройте страницу заявки "
                 f"и загрузите чек ещё раз: {ticket_link(row)}"})
    return True, row


def stats_text():
    rows = q("SELECT status, kind, COUNT(*) c, SUM(amount) s FROM orders GROUP BY status, kind").fetchall()
    agg = {}
    for r in rows:
        a = agg.setdefault(r["status"], {"orders": 0, "seats": 0, "sum": 0})
        a["orders"] += r["c"]; a["seats"] += SEATS[r["kind"]] * r["c"]; a["sum"] += r["s"] or 0
    paid = agg.get("paid", {"orders": 0, "seats": 0, "sum": 0})
    inside = q("SELECT COUNT(*) FROM orders WHERE checked_in IS NOT NULL").fetchone()[0]
    left = seats_left()
    return (f"📊 <b>Зимний бал</b>\n"
            f"Оплачено: {paid['orders']} билетов · {paid['seats']} гостей · <b>{paid['sum']} тг</b>\n"
            f"На проверке: {agg.get('review', {}).get('orders', 0)}\n"
            f"Ждут чек: {agg.get('pending', {}).get('orders', 0)}\n"
            f"Прошли вход: {inside}"
            + (f"\nСвободно мест: {left}" if left is not None else ""))


async def handle_update(u):
    if "callback_query" in u:
        cb = u["callback_query"]
        uid = cb["from"]["id"]
        if uid not in ADMIN_IDS:
            await tg("answerCallbackQuery", {"callback_query_id": cb["id"], "text": "Только для организаторов"})
            return
        m = re.fullmatch(r"(ok|no):(\d+)", cb.get("data", ""))
        if not m:
            return
        by = cb["from"].get("first_name", "") + (f" @{cb['from']['username']}" if cb["from"].get("username") else "")
        changed, row = await decide(int(m[2]), m[1] == "ok", by.strip())
        msg = ("Готово ✅" if m[1] == "ok" else "Отклонено") if changed else "Уже обработано"
        await tg("answerCallbackQuery", {"callback_query_id": cb["id"], "text": msg})
        return
    msg = u.get("message") or {}
    text = (msg.get("text") or "").strip()
    chat = msg.get("chat", {})
    if not text or chat.get("type") != "private":
        if text.startswith("/id"):
            await tg("sendMessage", {"chat_id": chat["id"], "text": f"chat_id: {chat['id']}"})
        return
    cid = chat["id"]
    if text.startswith("/start"):
        token = text[6:].strip()
        row = get_order(token=token) if token else None
        if row:
            q("UPDATE orders SET tg_chat=? WHERE id=?", cid, row["id"])
            row = get_order(oid=row["id"])
            if row["status"] == "paid":
                await send_ticket(row)
            else:
                await tg("sendMessage", {"chat_id": cid, "text":
                         f"Готово! Заявка №{ticket_no(row)} привязана ✨\n"
                         "Как только организаторы подтвердят оплату, я пришлю сюда ваш билет с QR-кодом."})
        else:
            await tg("sendMessage", {"chat_id": cid, "text":
                     f"❄️ Это бот Зимнего бала.\nКупить билет: {CFG['public_url']}"})
    elif text.startswith("/stats") and cid in ADMIN_IDS:
        await tg("sendMessage", {"chat_id": cid, "text": stats_text(), "parse_mode": "HTML"})
    elif text.startswith("/id"):
        await tg("sendMessage", {"chat_id": cid, "text": f"Ваш Telegram ID: {cid}"})


async def poll_telegram(app):
    if not CFG.get("telegram_token"):
        log.warning("telegram_token пуст — бот выключен, подтверждать можно в /admin")
        return
    me = await tg("getMe")
    if me:
        CFG["bot_username"] = me["username"]
        log.info("бот @%s запущен", me["username"])
    await tg("deleteWebhook")
    offset = int((q("SELECT v FROM kv WHERE k='offset'").fetchone() or [0])[0])
    while True:
        try:
            resp = await http.post(TG_URL + "getUpdates", json={"offset": offset, "timeout": 25},
                                   timeout=ClientTimeout(total=40))
            body = await resp.json()
            for u in body.get("result", []):
                offset = u["update_id"] + 1
                q("INSERT OR REPLACE INTO kv VALUES('offset',?)", str(offset))
                try:
                    await handle_update(u)
                except Exception:
                    log.exception("update failed")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.warning("polling: %s", e)
            await asyncio.sleep(3)


# ---------------------------------------------------------------- http api
hits: dict[str, list[float]] = {}


def throttle(request, limit=12, window=600):
    ip = request.headers.get("X-Forwarded-For", request.remote or "?").split(",")[0].strip()
    now = time.time()
    lst = [t for t in hits.get(ip, []) if now - t < window]
    if len(lst) >= limit:
        raise web.HTTPTooManyRequests(text=json.dumps({"error": "Слишком много попыток, попробуйте позже"}),
                                      content_type="application/json")
    lst.append(now)
    hits[ip] = lst


def bad(msg, status=400):
    return web.json_response({"error": msg}, status=status)


async def api_config(request):
    left = seats_left()
    return web.json_response({
        "prices": PRICES, "kaspi_phone": CFG["kaspi_phone"], "kaspi_name": CFG["kaspi_name"],
        "bot_username": CFG.get("bot_username", ""), "contact": CFG.get("contact", ""),
        "sales_open": bool(CFG.get("sales_open", True)) and left != 0, "seats_left": left,
        "event": CFG["event"],
    })


def clean_phone(p):
    digits = re.sub(r"\D", "", p or "")
    if len(digits) == 11 and digits[0] in "78":
        digits = "7" + digits[1:]
    elif len(digits) == 10:
        digits = "7" + digits
    if not re.fullmatch(r"7\d{10}", digits):
        return None
    return f"+7 {digits[1:4]} {digits[4:7]} {digits[7:9]} {digits[9:]}"


async def api_create(request):
    throttle(request)
    try:
        body = await request.json()
    except Exception:
        return bad("Неверный запрос")
    kind = body.get("kind")
    if kind not in PRICES:
        return bad("Выберите тип билета")
    name = " ".join(str(body.get("name", "")).split())[:80]
    guest2 = " ".join(str(body.get("guest2", "")).split())[:80] if kind == "pair" else ""
    telegram = str(body.get("telegram", "")).strip()[:40]
    phone = clean_phone(body.get("phone"))
    if len(name) < 2:
        return bad("Укажите имя и фамилию")
    if not phone:
        return bad("Проверьте номер телефона")
    if kind == "pair" and len(guest2) < 2:
        return bad("Укажите имя второго гостя")
    if not CFG.get("sales_open", True):
        return bad("Продажа билетов закрыта")
    left = seats_left()
    if left is not None and left < SEATS[kind]:
        return bad("К сожалению, билеты закончились")
    token = secrets.token_urlsafe(16)
    q("INSERT INTO orders(token,code,kind,amount,name,phone,guest2,telegram,created) VALUES(?,?,?,?,?,?,?,?,?)",
      token, new_code(), kind, PRICES[kind], name, phone, guest2, telegram, time.time())
    return web.json_response(public(get_order(token=token)))


async def api_order(request):
    row = get_order(token=request.match_info["token"])
    if not row:
        return bad("Заявка не найдена", 404)
    return web.json_response(public(row))


def sniff(head: bytes):
    if head.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if head.startswith(b"\x89PNG"):
        return ".png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return ".webp"
    if head.startswith(b"%PDF"):
        return ".pdf"
    if head[4:8] == b"ftyp" and head[8:12] in (b"heic", b"heix", b"mif1", b"msf1", b"hevc"):
        return ".heic"
    return None


async def api_receipt(request):
    throttle(request, limit=20)
    row = get_order(token=request.match_info["token"])
    if not row:
        return bad("Заявка не найдена", 404)
    if row["status"] in ("paid", "review"):
        return web.json_response(public(row))
    reader = await request.multipart()
    part = await reader.next()
    while part is not None and part.name != "file":
        part = await reader.next()
    if part is None:
        return bad("Прикрепите чек")
    buf = bytearray()
    while chunk := await part.read_chunk(65536):
        buf += chunk
        if len(buf) > MAX_UPLOAD:
            return bad("Файл больше 10 МБ")
    ext = sniff(bytes(buf[:16]))
    if not ext:
        return bad("Загрузите чек как фото, скриншот или PDF")
    fname = f"{row['id']:04d}-{secrets.token_hex(4)}{ext}"
    (RECEIPTS / fname).write_bytes(buf)
    q("UPDATE orders SET receipt=?, status='review', receipt_at=? WHERE id=?", fname, time.time(), row["id"])
    row = get_order(oid=row["id"])
    asyncio.create_task(notify_admins(row))
    return web.json_response(public(row))


# ---------------------------------------------------------------- admin api
def require_admin(request):
    key = request.headers.get("X-Admin-Key", "")
    if not CFG.get("admin_key") or not secrets.compare_digest(key, CFG["admin_key"]):
        raise web.HTTPUnauthorized(text=json.dumps({"error": "Неверный ключ"}), content_type="application/json")


async def admin_orders(request):
    require_admin(request)
    rows = q("SELECT * FROM orders ORDER BY id DESC").fetchall()
    out = []
    for r in rows:
        d = public(r)
        d.update(id=r["id"], phone=r["phone"], telegram=r["telegram"], created=r["created"],
                 receipt=bool(r["receipt"]), decided_by=r["decided_by"], paid_at=r["paid_at"],
                 checked_in_at=r["checked_in"])
        out.append(d)
    return web.json_response({"orders": out, "stats": stats_text(), "seats_left": seats_left()})


async def admin_action(request):
    require_admin(request)
    row = get_order(token=request.match_info["token"])
    if not row:
        return bad("Не найдено", 404)
    action = request.match_info["action"]
    if action in ("confirm", "reject"):
        await decide(row["id"], action == "confirm", "сайт /admin")
    elif action == "checkin":
        if row["status"] != "paid":
            return bad("Билет не оплачен")
        if row["checked_in"]:
            return web.json_response({**public(row), "already": True,
                                      "checked_in_at": row["checked_in"]})
        q("UPDATE orders SET checked_in=? WHERE id=?", time.time(), row["id"])
    elif action == "uncheck":
        q("UPDATE orders SET checked_in=NULL WHERE id=?", row["id"])
    return web.json_response(public(get_order(oid=row["id"])))


async def admin_receipt(request):
    require_admin(request)
    row = get_order(token=request.match_info["token"])
    if not row or not row["receipt"]:
        raise web.HTTPNotFound()
    return web.FileResponse(RECEIPTS / row["receipt"])


# ---------------------------------------------------------------- pages
def page(name):
    async def handler(request):
        return web.FileResponse(STATIC / name, headers={"Cache-Control": "no-cache"})
    return handler


# ---------------------------------------------------------------- seo
def site_url():
    return CFG.get("public_url", "").rstrip("/")


def event_jsonld():
    """Разметка schema.org/Event: Google может показать бал карточкой мероприятия в поиске."""
    ev, base = CFG["event"], site_url()
    left = seats_left()
    on_sale = bool(CFG.get("sales_open", True)) and left != 0
    place = {"@type": "Place", "name": ev.get("place", "")}
    place["address"] = ev.get("address") or ev.get("place", "")
    data = {
        "@context": "https://schema.org",
        "@type": "Event",
        "name": "Зимний бал ЕАГИ × DOSTEAM",
        "description": f"Зимний бал — {ev.get('date', '')}, {ev.get('time', '')}, {ev.get('place', '')}. "
                       f"{ev.get('dress_girls', '')}, {ev.get('dress_boys', '').lower()}. Билеты онлайн через Kaspi.",
        "startDate": ev.get("date_iso", ""),
        "eventStatus": "https://schema.org/EventScheduled",
        "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
        "location": place,
        "image": [f"{base}/static/img/poster.webp"],
        "organizer": [{"@type": "Organization", "name": "ЕАГИ"},
                      {"@type": "Organization", "name": "DOSTEAM"}],
        "offers": [{
            "@type": "Offer", "name": KIND_LABEL[k], "price": PRICES[k], "priceCurrency": "KZT",
            "url": f"{base}/#tickets",
            "availability": "https://schema.org/InStock" if on_sale else "https://schema.org/SoldOut",
        } for k in ("single", "pair") if k in PRICES],
    }
    return json.dumps(data, ensure_ascii=False).replace("</", "<\\/")


async def index_page(request):
    base = site_url()
    a = lambda s: html.escape(s, quote=True)
    head = [f'<link rel="canonical" href="{a(base)}/">',
            f'<meta property="og:url" content="{a(base)}/">',
            '<meta property="og:type" content="website">',
            '<meta property="og:locale" content="ru_RU">',
            f'<script type="application/ld+json">{event_jsonld()}</script>']
    if CFG.get("google_site_verification"):
        head.append(f'<meta name="google-site-verification" content="{a(CFG["google_site_verification"])}">')
    text = (STATIC / "index.html").read_text("utf-8")
    # превью в Telegram/WhatsApp и Google требуют абсолютный адрес картинки
    text = text.replace('content="/static/img/', f'content="{a(base)}/static/img/')
    text = text.replace("</head>", "\n".join(head) + "\n</head>", 1)
    return web.Response(text=text, content_type="text/html", headers={"Cache-Control": "no-cache"})


async def robots_txt(request):
    lines = ["User-agent: *", "Allow: /", "Disallow: /admin", "Disallow: /api/", "",
             f"Sitemap: {site_url()}/sitemap.xml", ""]
    return web.Response(text="\n".join(lines), content_type="text/plain")


async def sitemap_xml(request):
    lastmod = time.strftime("%Y-%m-%d", time.gmtime((STATIC / "index.html").stat().st_mtime))
    xml = ('<?xml version="1.0" encoding="UTF-8"?>\n'
           '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
           f'  <url><loc>{html.escape(site_url())}/</loc><lastmod>{lastmod}</lastmod></url>\n'
           '</urlset>\n')
    return web.Response(text=xml, content_type="application/xml")


async def on_start(app):
    global http
    http = ClientSession(timeout=ClientTimeout(total=30))
    app["poller"] = asyncio.create_task(poll_telegram(app))


async def on_stop(app):
    app["poller"].cancel()
    await http.close()


def make_app():
    app = web.Application(client_max_size=MAX_UPLOAD + 1024 * 64)
    app.router.add_get("/", index_page)
    app.router.add_get("/robots.txt", robots_txt)
    app.router.add_get("/sitemap.xml", sitemap_xml)
    app.router.add_get("/t/{token}", page("ticket.html"))
    app.router.add_get("/admin", page("admin.html"))
    app.router.add_get("/api/config", api_config)
    app.router.add_post("/api/orders", api_create)
    app.router.add_get("/api/orders/{token}", api_order)
    app.router.add_post("/api/orders/{token}/receipt", api_receipt)
    app.router.add_get("/api/admin/orders", admin_orders)
    app.router.add_post("/api/admin/orders/{token}/{action:confirm|reject|checkin|uncheck}", admin_action)
    app.router.add_get("/api/admin/orders/{token}/receipt", admin_receipt)
    app.router.add_static("/static", STATIC)
    app.on_startup.append(on_start)
    app.on_cleanup.append(on_stop)
    return app


if __name__ == "__main__":
    web.run_app(make_app(), host=CFG.get("host", "0.0.0.0"), port=int(CFG.get("port", 8080)))
