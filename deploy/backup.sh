#!/usr/bin/env bash
# Резервная копия базы бота (безопасно и на работающем боте). Хранит 14 последних дней.
set -euo pipefail
APP_DIR=/opt/max-football-bot
cd "$APP_DIR" # из /root (cwd root-а) у пользователя maxbot нет прав — find падал
DB="$APP_DIR/data/bot.db"
DIR="$APP_DIR/data/backups"
[ -f "$DB" ] || { echo "$(date '+%F %T') базы ещё нет — пропуск"; exit 0; }
mkdir -p "$DIR"
sqlite3 "$DB" ".backup '$DIR/bot-$(date +%F_%H%M).db'"
find "$DIR" -name 'bot-*.db' -mtime +14 -delete
echo "$(date '+%F %T') бэкап готов"
