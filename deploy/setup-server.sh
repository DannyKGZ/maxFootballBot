#!/usr/bin/env bash
# Первоначальная установка бота на чистый сервер Ubuntu 22.04/24.04 (Timeweb Cloud).
# Запуск от root:   bash setup-server.sh
# Репозиторий можно переопределить: REPO=git@github.com:DannyKGZ/maxFootballBot.git bash setup-server.sh
set -euo pipefail

REPO="${REPO:-https://github.com/DannyKGZ/maxFootballBot.git}"
APP_DIR=/opt/max-football-bot
APP_USER=maxbot
RELEASES=/opt/max-football-bot-releases
LIBEXEC=/usr/local/libexec/max-football-bot

[ "$(id -u)" -eq 0 ] || { echo "Запустите от root (sudo -i)"; exit 1; }

echo "==> Пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git build-essential python3 sqlite3

echo "==> Node.js 22 LTS"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "==> Swap 1 ГБ (страховка для npm на сервере с 1 ГБ памяти)"
if ! swapon --show | grep -q .; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Часовой пояс сервера: Москва (бот и так считает время по TIMEZONE, это для удобства логов)"
timedatectl set-timezone Europe/Moscow || true

echo "==> Пользователь $APP_USER и код в $APP_DIR"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"
as_app() { sudo -u "$APP_USER" -H -- "$@"; }

# Привилегированные скрипты и юниты берём из отдельного root-каталога.
trusted=$(mktemp -d)
trap 'rm -rf -- "$trusted"' EXIT
git clone -q --branch main --single-branch -- "$REPO" "$trusted"
if [ ! -d "$APP_DIR/.git" ]; then
  install -d -m 755 "$APP_DIR"
  cp -a "$trusted/." "$APP_DIR/"
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
fi
as_app mkdir -p "$APP_DIR/data/backups"

echo "==> .env"
if [ ! -f "$APP_DIR/.env" ]; then
  cd "$APP_DIR"
  as_app bash -c 'umask 077; sed -e "s/^UPDATES_MODE=.*/UPDATES_MODE=polling/" -e "s/^PORT=.*/PORT=8443/" .env.example > .env'
  NEED_ENV=1
fi

echo "==> Сервис systemd, автодеплой и ежедневный бэкап базы"
systemctl stop max-football-bot-update.timer max-football-bot-update.service 2>/dev/null || true
install -d -m 755 -o root -g root "$LIBEXEC" "$RELEASES"
install -m 755 "$trusted/deploy/update.sh" "$trusted/deploy/backup.sh" "$LIBEXEC/"
install -m 644 "$trusted/deploy/"*.service "$trusted/deploy/max-football-bot-update.timer" /etc/systemd/system/
echo "30 4 * * * $APP_USER $LIBEXEC/backup.sh >> $APP_DIR/data/backups/backup.log 2>&1" > /etc/cron.d/max-football-bot
if [[ ! -L "$RELEASES/current" ]] && as_app test -f "$APP_DIR/dist/index.js"; then
  ln -s "$APP_DIR" "$RELEASES/current"
fi
systemctl daemon-reload
systemctl enable max-football-bot
if [ "${NEED_ENV:-0}" = 1 ] || as_app grep -Eq '^BOT_TOKEN=(your_bot_token_here)?$' "$APP_DIR/.env"; then
  "$LIBEXEC/update.sh" --prepare
  echo
  echo "Готово, осталось заполнить $APP_DIR/.env (BOT_TOKEN, CHAT_IDS и др.), затем:"
  echo "  systemctl start max-football-bot && journalctl -u max-football-bot -f"
else
  "$LIBEXEC/update.sh"
  echo "Бот запущен. Логи: journalctl -u max-football-bot -f"
fi
systemctl enable --now max-football-bot-update.timer
