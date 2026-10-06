#!/usr/bin/env bash
# Обновление бота на сервере до последней версии из GitHub. Запуск от root: bash /opt/max-football-bot/deploy/update.sh
set -euo pipefail
APP_DIR=/opt/max-football-bot
APP_USER=maxbot
cd "$APP_DIR" # sudo -u maxbot не может работать из /root

sudo -u "$APP_USER" "$APP_DIR/deploy/backup.sh"   # свежая копия базы перед обновлением
sudo -u "$APP_USER" -H bash -c "cd '$APP_DIR' && git pull --ff-only && npm ci && npm run build"
install -m 644 "$APP_DIR/deploy/max-football-bot.service" /etc/systemd/system/max-football-bot.service
systemctl daemon-reload
systemctl restart max-football-bot
sleep 3
systemctl --no-pager --lines=15 status max-football-bot
