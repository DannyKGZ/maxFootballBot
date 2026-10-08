#!/usr/bin/env bash
# Первоначальная установка бота на чистый сервер Ubuntu 22.04/24.04 (Timeweb Cloud).
# Запуск от root:   bash setup-server.sh
# Репозиторий можно переопределить: REPO=git@github.com:DannyKGZ/maxFootballBot.git bash setup-server.sh
set -euo pipefail

REPO="${REPO:-https://github.com/DannyKGZ/maxFootballBot.git}"
APP_DIR=/opt/max-football-bot
APP_USER=maxbot

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
if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO" "$APP_DIR"
fi
mkdir -p "$APP_DIR/data/backups"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

echo "==> Сборка"
sudo -u "$APP_USER" -H bash -c "cd '$APP_DIR' && npm ci && npm run build"

echo "==> .env"
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  sed -i 's/^UPDATES_MODE=.*/UPDATES_MODE=polling/; s/^AUTO_REGISTER_WEBHOOK=.*/AUTO_REGISTER_WEBHOOK=false/' "$APP_DIR/.env"
  chown "$APP_USER:$APP_USER" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  NEED_ENV=1
fi

echo "==> Сервис systemd, автодеплой и ежедневный бэкап базы"
install -m 644 "$APP_DIR/deploy/max-football-bot.service" /etc/systemd/system/max-football-bot.service
echo "30 4 * * * $APP_USER $APP_DIR/deploy/backup.sh >> $APP_DIR/data/backups/backup.log 2>&1" > /etc/cron.d/max-football-bot
chmod +x "$APP_DIR/deploy/"*.sh
install -m 644 "$APP_DIR/deploy/max-football-bot-update.service" /etc/systemd/system/max-football-bot-update.service
install -m 644 "$APP_DIR/deploy/max-football-bot-update.timer" /etc/systemd/system/max-football-bot-update.timer
systemctl daemon-reload
systemctl enable max-football-bot
systemctl enable --now max-football-bot-update.timer   # автодеплой: раз в час проверяет GitHub

if [ "${NEED_ENV:-0}" = 1 ] || grep -q '^BOT_TOKEN=your_bot_token_here' "$APP_DIR/.env"; then
  echo
  echo "Готово, осталось заполнить $APP_DIR/.env (BOT_TOKEN, CHAT_IDS и др.), затем:"
  echo "  systemctl start max-football-bot && journalctl -u max-football-bot -f"
else
  systemctl restart max-football-bot
  echo "Бот запущен. Логи: journalctl -u max-football-bot -f"
fi
