# Деплой на сервер с поддоменом

Пример: поддомен `bal.example.kz`, сервер Ubuntu 22.04/24.04 (VPS с публичным IP).
Везде замените `bal.example.kz` на свой поддомен и `203.0.113.10` на IP сервера.

## 1. Поддомен (DNS)

В панели, где куплен домен (ps.kz, hoster.kz, Cloudflare, REG.RU и т. п.) → DNS-записи → добавить:

| Тип | Имя | Значение | TTL |
|---|---|---|---|
| A | `bal` | `203.0.113.10` | 300 |

Если домен в Cloudflare: на время получения сертификата поставьте «DNS only» (серое облако).
Проверка (обычно 5–30 минут):

```bash
dig +short bal.example.kz
```

Должен вернуться IP сервера.

## 2. Подготовка сервера

```bash
ssh root@203.0.113.10
```

```bash
apt update && apt install -y python3 python3-venv git nginx certbot python3-certbot-nginx
```

```bash
ufw allow OpenSSH && ufw allow 'Nginx Full' && ufw --force enable
```

Отдельный пользователь без прав входа:

```bash
useradd --system --home /opt/winter-ball --shell /usr/sbin/nologin winterball
```

## 3. Код и зависимости

```bash
git clone https://github.com/dosmuhamedkemelbekov-ui/winter-ball.git /opt/winter-ball
```

(репозиторий приватный — нужен deploy key или токен; либо скопируйте папку через `scp -r`.)

```bash
cd /opt/winter-ball && python3 -m venv venv && venv/bin/pip install -r requirements.txt
```

## 4. config.json

```bash
cp config.example.json config.json && nano config.json
```

Обязательно поменять:

- `"public_url": "https://bal.example.kz"` — без слэша в конце, иначе ссылки в Telegram и QR будут неверные;
- `"host": "127.0.0.1"` — сайт будет доступен только через nginx;
- `admin_key` — длинный случайный пароль (`openssl rand -hex 16`);
- `telegram_token`, `admin_ids`, `admin_chat_id`, `kaspi_phone`, `kaspi_name`, `contact` — см. README.

```bash
mkdir -p data && chown -R winterball:winterball /opt/winter-ball && chmod 600 config.json
```

## 5. Автозапуск (systemd)

```bash
cp deploy/winter-ball.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now winter-ball
```

```bash
systemctl status winter-ball
```

```bash
curl -s http://127.0.0.1:8080/api/config
```

Логи: `journalctl -u winter-ball -f`

## 6. nginx + HTTPS

```bash
sed 's/bal.example.kz/ВАШ_ПОДДОМЕН/' deploy/nginx-winter-ball.conf > /etc/nginx/sites-available/winter-ball
```

```bash
ln -s /etc/nginx/sites-available/winter-ball /etc/nginx/sites-enabled/ && nginx -t && systemctl reload nginx
```

Бесплатный сертификат Let's Encrypt (с автопродлением):

```bash
certbot --nginx -d bal.example.kz --redirect -m you@example.com --agree-tos -n
```

HTTPS обязателен: без него камера/копирование в браузере телефона работают хуже, и Kaspi-ссылки выглядят подозрительно.

## 7. Проверка

1. Откройте `https://bal.example.kz` — афиша.
2. Оформите тестовый билет, загрузите любой скриншот — чек должен прийти в Telegram.
3. Нажмите «✅ Подтвердить» — на странице заявки появится QR.
4. `https://bal.example.kz/admin` → ключ → отсканируйте QR телефоном → «Отметить вход».
5. Удалите тестовую заявку или просто не учитывайте её (видна в /admin).

## Обновление сайта

```bash
cd /opt/winter-ball && sudo -u winterball git pull && systemctl restart winter-ball
```

## Резервная копия

Всё ценное — в `data/` (база заявок и чеки). Ежедневная копия:

```bash
echo '0 3 * * * root tar czf /root/winter-ball-$(date +\%F).tgz -C /opt/winter-ball data config.json' > /etc/cron.d/winter-ball-backup
```

## Без своего сервера

- **Render / Railway:** Start command `python server.py`, `host` = `0.0.0.0`, `port` = порт платформы, подключить Persistent Disk на `/opt/render/project/src/data`. Поддомен — CNAME на адрес платформы.
- **Быстрый тест с компьютера:** `cloudflared tunnel --url http://localhost:8080` (адрес меняется при каждом запуске, для продажи не годится).

## Если что-то не работает

| Симптом | Причина |
|---|---|
| `502 Bad Gateway` | сервис не запущен: `journalctl -u winter-ball -n 50` |
| `413 Request Entity Too Large` при загрузке чека | нет `client_max_body_size` в nginx |
| Ссылки в Telegram ведут на localhost | не исправлен `public_url` |
| Бот молчит | неверный `telegram_token` или у бота стоит вебхук другого сервиса |
| certbot: «Timeout during connect» | DNS ещё не обновился или порт 80 закрыт |
