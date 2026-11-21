#!/usr/bin/env bash
# Установленная root-копия скрипта запускает сборку и проверки от maxbot.
set -Eeuo pipefail

APP_DIR=/opt/max-football-bot
APP_USER=maxbot
RELEASES=/opt/max-football-bot-releases
LIBEXEC=/usr/local/libexec/max-football-bot
SERVICE=max-football-bot
mode="${1:-manual}"

[[ "$(id -u)" == 0 && "$0" == "$LIBEXEC/update.sh" ]] || {
  echo "Запустите установленную root-копию: sudo $LIBEXEC/update.sh" >&2
  exit 1
}
case "$mode" in manual|--auto|--prepare) ;; *) exit 2 ;; esac
as_app() { sudo -u "$APP_USER" -H -- "$@"; }

exec 9>/run/lock/max-football-bot-update.lock
flock 9
cd "$APP_DIR"

as_app git fetch -q origin +refs/heads/main:refs/remotes/origin/main
target=$(as_app git rev-parse --verify 'refs/remotes/origin/main^{commit}')
[[ "$target" =~ ^[0-9a-f]{40}$ ]]
if [[ -f "$RELEASES/active-sha" && "$(cat "$RELEASES/active-sha")" == "$target" ]]; then exit 0; fi
if [[ "$mode" == --auto && -f "$RELEASES/failed-sha" && "$(cat "$RELEASES/failed-sha")" == "$target" ]]; then exit 0; fi

current=$(readlink "$RELEASES/current" || true)
old_previous=$(readlink "$RELEASES/previous" || true)
candidate=$(mktemp -d "$RELEASES/release.XXXXXX")
switching=0

point_release() {
  local path="$1" name="$2"
  ln -sfn -- "$path" "$RELEASES/.${name}.next"
  mv -Tf -- "$RELEASES/.${name}.next" "$RELEASES/$name"
}

remove_release() {
  local release="$1"
  if [[ "$release" == "$RELEASES"/release.* && -d "$release" && ! -L "$release" ]]; then
    as_app find "$release" -mindepth 1 -delete || true
    rmdir -- "$release" || true
  fi
}

on_exit() {
  local status=$?
  trap - EXIT
  if (( status == 0 )); then return; fi
  set +e
  if (( switching )); then
    if [[ -n "$current" ]]; then
      if point_release "$current" current; then
        systemctl restart "$SERVICE" || echo "Не удалось запустить прежнюю версию" >&2
      else
        echo "Не удалось вернуть указатель прежнего релиза" >&2
        exit "$status"
      fi
    else
      systemctl stop "$SERVICE"
      rm -f -- "$RELEASES/current"
    fi
  fi
  printf '%s\n' "$target" > "$RELEASES/failed-sha"
  remove_release "$candidate"
  echo "Релиз ${target:0:7} не принят" >&2
  exit "$status"
}
trap on_exit EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

echo "==> Подготовка ${target:0:7}"
chown "$APP_USER:$APP_USER" "$candidate"
as_app git archive "$target" | as_app tar -x -C "$candidate"
as_app bash -c 'cd "$1" && npm ci --include=dev --no-audit --no-fund && npm test' bash "$candidate"
as_app "$LIBEXEC/backup.sh"

switching=1
point_release "$candidate" current
if [[ "$mode" != --prepare ]]; then
  systemctl restart "$SERVICE"
  for ((attempt = 1; attempt <= 20; attempt++)); do
    if systemctl is-active --quiet "$SERVICE" && as_app /usr/bin/node "$candidate/dist/readyProbe.js"; then break; fi
    if (( attempt == 20 )); then
      echo "Бот не подтвердил готовность принимать события MAX" >&2
      exit 1
    fi
    sleep 4
  done
fi

if [[ -n "$current" ]]; then point_release "$current" previous; fi
printf '%s\n' "$target" > "$RELEASES/.active-sha.next"
mv -Tf -- "$RELEASES/.active-sha.next" "$RELEASES/active-sha"
switching=0
rm -f -- "$RELEASES/failed-sha"
if [[ "$old_previous" != "$current" && "$old_previous" != "$candidate" ]]; then remove_release "$old_previous"; fi
echo "==> Релиз ${target:0:7} принят"
