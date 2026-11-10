#!/usr/bin/env bash
# Установка и обновление «Зимнего бала» на сервере приложения (где DoSteam и боты).
# Повторный запуск = обновление: git pull, зависимости, перезапуск.
#
#   sudo bash deploy/deploy.sh
#
# Настройки (необязательно): PORT=8090 PUBLIC_URL=https://winterball.egi.edu.kz APP_USER=winterball
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_USER="${APP_USER:-winterball}"
PORT="${PORT:-8090}"
PUBLIC_URL="${PUBLIC_URL:-https://winterball.egi.edu.kz}"
SERVICE=winter-ball

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mОшибка: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "запустите через sudo"
cd "$APP_DIR"
[ -f server.py ] || die "не найден server.py в $APP_DIR"

if [ -d .git ]; then
  say "Обновляю код с GitHub"
  git -c safe.directory="$APP_DIR" pull --ff-only
fi

say "Проверяю Python"
if ! python3 -c 'import venv, ensurepip' 2>/dev/null; then
  command -v apt-get >/dev/null || die "установите python3-venv вручную"
  apt-get update -qq && apt-get install -y -qq python3-venv
fi

if ! id "$APP_USER" >/dev/null 2>&1; then
  say "Создаю системного пользователя $APP_USER"
  useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
fi

say "Ставлю зависимости в $APP_DIR/venv"
[ -x venv/bin/python ] || python3 -m venv venv
venv/bin/pip install -q --upgrade pip
venv/bin/pip install -q -r requirements.txt

FIRST_RUN=0
if [ ! -f config.json ]; then
  FIRST_RUN=1
  # перед первым запуском проверяем, что порт не занят DoSteam или ботами
  if command -v ss >/dev/null && ss -ltn | awk '{print $4}' | grep -qE "[:.]$PORT\$"; then
    die "порт $PORT уже занят (ss -ltnp | grep $PORT). Запустите с другим: sudo PORT=8095 bash deploy/deploy.sh"
  fi
  say "Создаю config.json"
  PORT="$PORT" PUBLIC_URL="$PUBLIC_URL" python3 - <<'PY'
import json, os, secrets
c = json.load(open("config.example.json", encoding="utf-8"))
c["public_url"] = os.environ["PUBLIC_URL"].rstrip("/")
c["host"] = "0.0.0.0"          # принимать запросы от сервера Moodle по внутренней сети
c["port"] = int(os.environ["PORT"])
c["admin_key"] = secrets.token_urlsafe(18)
json.dump(c, open("config.json", "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
fi

runuser -u "$APP_USER" -- test -r "$APP_DIR/server.py" || \
  die "пользователь $APP_USER не может читать $APP_DIR — положите проект в /opt/winter-ball, а не в домашнюю папку"

# код принадлежит root, сервис может писать только в data/
mkdir -p data
chown -R "$APP_USER:$APP_USER" data
chown "root:$APP_USER" config.json
chmod 640 config.json

say "Настраиваю автозапуск (systemd)"
sed "s#/opt/winter-ball#$APP_DIR#g; s#^User=.*#User=$APP_USER#; s#^Group=.*#Group=$APP_USER#" \
  deploy/winter-ball.service > /etc/systemd/system/$SERVICE.service
systemctl daemon-reload
systemctl enable -q $SERVICE
systemctl restart $SERVICE

CFG_PORT="$(python3 -c 'import json;print(json.load(open("config.json",encoding="utf-8")).get("port",8080))')"
say "Проверяю, что сайт отвечает на порту $CFG_PORT"
for _ in $(seq 20); do
  if curl -fs -o /dev/null "http://127.0.0.1:$CFG_PORT/api/config"; then OK=1; break; fi
  sleep 1
done
[ "${OK:-0}" = 1 ] || { journalctl -u $SERVICE -n 30 --no-pager; die "сайт не запустился, лог выше"; }

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
printf '\n\033[1;32mГотово.\033[0m Сайт работает: http://%s:%s\n' "${IP:-IP_СЕРВЕРА}" "$CFG_PORT"
echo "На сервере Moodle в proxy_pass укажите: http://${IP:-IP_СЕРВЕРА}:$CFG_PORT"
if [ "$FIRST_RUN" = 1 ]; then
  echo
  echo "Пароль для /admin: $(python3 -c 'import json;print(json.load(open("config.json",encoding="utf-8"))["admin_key"])')"
  echo "Дальше заполните telegram_token, admin_ids, kaspi_phone, kaspi_name в $APP_DIR/config.json"
  echo "и перезапустите: sudo systemctl restart $SERVICE"
fi
