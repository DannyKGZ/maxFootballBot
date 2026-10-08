#!/usr/bin/env bash
# Обновление бота на сервере до последней версии из GitHub. Запуск от root: bash /opt/max-football-bot/deploy/update.sh
# Если сборка не прошла или бот после перезапуска не поднялся — откат на прежнюю версию (exit 1).
# Его же запускает автодеплой (deploy/auto-update.sh по таймеру).
set -euo pipefail
APP_DIR=/opt/max-football-bot
APP_USER=maxbot

# Всё внутри функции: git pull может поменять этот файл, а bash читает скрипт по ходу выполнения.
main() {
  cd "$APP_DIR" # sudo -u maxbot не может работать из /root
  as_app() { sudo -u "$APP_USER" -H bash -c "cd '$APP_DIR' && $1"; }

  local prev
  prev=$(as_app "git rev-parse HEAD")
  rollback() {
    echo "!!! $1 — откат на ${prev:0:7}"
    as_app "git reset -q --hard $prev && npm ci --no-audit --no-fund && npm run build"
    systemctl restart max-football-bot
    exit 1
  }

  sudo -u "$APP_USER" "$APP_DIR/deploy/backup.sh"   # свежая копия базы перед обновлением
  as_app "git pull -q --ff-only" || { echo "!!! git pull не удался"; exit 1; }
  echo "==> ${prev:0:7} → $(as_app 'git log --oneline -1')"
  # noEmitOnError: при ошибке компиляции dist/ не трогается — работающий бот не ломается.
  as_app "npm ci --no-audit --no-fund && npm run build" || rollback "сборка не удалась"

  install -m 644 "$APP_DIR/deploy/max-football-bot.service" /etc/systemd/system/max-football-bot.service
  install -m 644 "$APP_DIR/deploy/max-football-bot-update.service" /etc/systemd/system/max-football-bot-update.service
  install -m 644 "$APP_DIR/deploy/max-football-bot-update.timer" /etc/systemd/system/max-football-bot-update.timer
  systemctl daemon-reload
  systemctl restart max-football-bot
  sleep 10
  systemctl is-active --quiet max-football-bot || rollback "бот не запустился после обновления"
  systemctl --no-pager --lines=8 status max-football-bot || true
  echo "==> обновлено"
}
main "$@"
exit
