# Деплой: winterball.egi.edu.kz

## Схема

```
Посетитель ──HTTPS──▶ Сервер Moodle ──HTTP, внутренняя сеть──▶ Сервер DoSteam
                      188.130.173.173                          192.168.2.102:8095
                      nginx/Apache + сертификат                 winter-ball (systemd)
                      Moodle работает как раньше                DoSteam и боты не трогаются
```

- DNS: запись `A winterball → 188.130.173.173` (уже добавлена в панели egi.edu.kz).
- **Сервер Moodle** принимает все запросы на 80/443. Для имени `winterball.egi.edu.kz` он пересылает их на сервер DoSteam, остальное остаётся Moodle. Сертификат HTTPS тоже здесь.
- **Сервер DoSteam** (без внешнего IP) запускает сайт отдельным сервисом на своём порту (порт 8095), рядом с DoSteam и ботами. Telegram-бот бала работает через long polling, то есть сам ходит в интернет, входящие соединения ему не нужны.

`192.168.2.102` везде пример: подставьте реальный внутренний IP сервера DoSteam (`hostname -I` на нём).

---

## Часть 1. Сервер DoSteam: ставим сайт с GitHub

```bash
ssh user@сервер-dosteam
```

### 1.1. Доступ к репозиторию

Если репозиторий публичный, пропустите этот шаг. Если приватный, нужен ключ только для чтения:

```bash
sudo ssh-keygen -t ed25519 -N "" -f /root/.ssh/winterball_deploy -C winterball-deploy
```

```bash
sudo cat /root/.ssh/winterball_deploy.pub
```

GitHub → репозиторий → Settings → Deploy keys → Add deploy key → вставить ключ (галочку «Allow write access» не ставить). Затем:

```bash
printf 'Host github-winterball\n  HostName github.com\n  User git\n  IdentityFile /root/.ssh/winterball_deploy\n' | sudo tee -a /root/.ssh/config
```

### 1.2. Клонирование

Приватный репозиторий:

```bash
sudo git clone git@github-winterball:dosmuhamedkemelbekov-ui/winter-ball.git /opt/winter-ball
```

Публичный:

```bash
sudo git clone https://github.com/dosmuhamedkemelbekov-ui/winter-ball.git /opt/winter-ball
```

Папка `deploy/` пока есть только в ветке `claude/epic-wright-iacgd1`. Пока её не слили в `main`, переключитесь на неё:

```bash
sudo git -C /opt/winter-ball checkout claude/epic-wright-iacgd1
```

### 1.3. Установка одной командой

```bash
sudo bash /opt/winter-ball/deploy/deploy.sh
```

Скрипт:
- ставит `python3-venv`, если его нет, создаёт `venv` и ставит `aiohttp`;
- создаёт системного пользователя `winterball`. Сайт работает от него и может писать только в `data/`;
- при первом запуске создаёт `config.json` с адресом `https://winterball.egi.edu.kz`, портом 8090 и случайным паролем для `/admin`. Если порт занят DoSteam или ботами, останавливается и пишет об этом;
- ставит и запускает сервис `winter-ball` (systemd, автозапуск, перезапуск при сбое);
- проверяет, что сайт отвечает, и печатает адрес для прокси и пароль админки.

Другой порт: `sudo PORT=8095 bash /opt/winter-ball/deploy/deploy.sh`.

### 1.4. Заполнить config.json

```bash
sudo nano /opt/winter-ball/config.json
```

Заполните `telegram_token`, `admin_ids`, `admin_chat_id`, `kaspi_phone`, `kaspi_name`, `contact` (см. README). Для бала нужен **отдельный бот**: один токен нельзя одновременно опрашивать из двух программ, поэтому токен ботов DoSteam сюда не подходит.

```bash
sudo systemctl restart winter-ball
```

### 1.5. Открыть порт только для сервера Moodle

Если на сервере DoSteam включён ufw (`sudo ufw status`), разрешите доступ к порту только серверу Moodle (его **внутренний** IP):

```bash
sudo ufw allow from ВНУТРЕННИЙ_IP_MOODLE to any port 8095 proto tcp
```

Если ufw выключен, не включайте его ради этого: можно случайно закрыть доступ к DoSteam и SSH.

С сервера Moodle проверьте, что сайт виден:

```bash
curl -s http://192.168.2.102:8095/api/config
```

Должен вернуться JSON.

---

## Часть 2. Сервер Moodle: перенаправление winterball.egi.edu.kz

Какой веб-сервер стоит:

```bash
systemctl is-active nginx apache2 httpd
```

### Вариант A: nginx

```bash
sudo nano /etc/nginx/sites-available/winterball.egi.edu.kz
```

Вставьте содержимое `deploy/nginx-winter-ball.conf`, заменив `192.168.2.102:8095` на свой адрес. Затем:

```bash
sudo ln -s /etc/nginx/sites-available/winterball.egi.edu.kz /etc/nginx/sites-enabled/
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

`reload` не обрывает Moodle. Если `nginx -t` пишет ошибку, ничего не применяется и Moodle продолжает работать по-старому.

### Вариант B: Apache

```bash
sudo a2enmod proxy proxy_http headers
```

```bash
sudo nano /etc/apache2/sites-available/winterball.egi.edu.kz.conf
```

Вставьте содержимое `deploy/apache-winter-ball.conf`, заменив `192.168.2.102:8095`. Затем:

```bash
sudo a2ensite winterball.egi.edu.kz && sudo apachectl configtest && sudo systemctl reload apache2
```

### HTTPS

```bash
sudo apt install -y certbot python3-certbot-nginx
```

(для Apache: `python3-certbot-apache`)

```bash
sudo certbot --nginx -d winterball.egi.edu.kz --redirect
```

(для Apache: `--apache`). Certbot меняет только блок winterball, сертификат Moodle не трогает и продлевает новый сертификат сам.

---

## Часть 3. Проверка

1. `nslookup winterball.egi.edu.kz` возвращает `188.130.173.173`.
2. https://winterball.egi.edu.kz открывает афишу. Moodle по своему адресу работает как раньше.
3. Тестовый билет → чек приходит в Telegram → «✅ Подтвердить» → на странице появляется QR.
4. https://winterball.egi.edu.kz/admin → пароль из `config.json` → скан QR телефоном → «Отметить вход».

## Обновление после изменений на GitHub

На сервере DoSteam:

```bash
sudo bash /opt/winter-ball/deploy/deploy.sh
```

Скрипт сам сделает `git pull`, обновит зависимости и перезапустит сайт. `config.json` и `data/` при этом не трогаются.

## Резервная копия

Всё ценное лежит в `data/` (заявки и чеки) и `config.json`:

```bash
echo '0 3 * * * root tar czf /root/winter-ball-$(date +\%F).tgz -C /opt/winter-ball data config.json' | sudo tee /etc/cron.d/winter-ball-backup
```

## Если что-то не работает

| Симптом | Где смотреть |
|---|---|
| `502 Bad Gateway` | сервер Moodle не достаёт до DoSteam: `curl http://192.168.2.102:8095/api/config` с сервера Moodle; на DoSteam: `systemctl status winter-ball`, `journalctl -u winter-ball -n 50` |
| Открывается Moodle вместо бала | блок winterball не включён или опечатка в `server_name`/`ServerName` |
| `413 Request Entity Too Large` при загрузке чека | нет `client_max_body_size` (nginx) |
| Ссылки в Telegram ведут на localhost | неверный `public_url` в `config.json` |
| Бот молчит, в логе `Conflict: terminated by other getUpdates` | этот токен уже использует другой бот: нужен отдельный |
| certbot: «Timeout during connect» | DNS ещё не обновился или порт 80 сервера Moodle закрыт снаружи |
