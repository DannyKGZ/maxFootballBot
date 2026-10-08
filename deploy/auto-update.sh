#!/usr/bin/env bash
# Автодеплой: раз в 5 минут (таймер max-football-bot-update.timer) проверяет GitHub;
# если в main новый коммит — запускает deploy/update.sh. Коммит, который не удалось
# собрать или запустить, запоминается и повторно не пробуется, пока не появится новый.
# Лог: journalctl -u max-football-bot-update
set -euo pipefail
APP_DIR=/opt/max-football-bot
APP_USER=maxbot
FAILED="$APP_DIR/data/deploy-failed"

main() {
  cd "$APP_DIR"
  as_app() { sudo -u "$APP_USER" -H bash -c "cd '$APP_DIR' && $1"; }
  as_app "git fetch -q origin main"
  local local_sha remote_sha
  local_sha=$(as_app "git rev-parse HEAD")
  remote_sha=$(as_app "git rev-parse origin/main")
  [ "$local_sha" = "$remote_sha" ] && exit 0
  if [ -f "$FAILED" ] && [ "$(cat "$FAILED")" = "$remote_sha" ]; then exit 0; fi

  echo "Новый коммит ${remote_sha:0:7} — обновляю"
  # Копия update.sh: git pull внутри него может поменять сам файл.
  local script
  script=$(mktemp)
  cp "$APP_DIR/deploy/update.sh" "$script"
  if bash "$script"; then
    rm -f "$FAILED"
  else
    echo "$remote_sha" > "$FAILED"
    echo "Обновление до ${remote_sha:0:7} не удалось — бот остался на прежней версии"
  fi
  rm -f "$script"
}
main "$@"
exit
