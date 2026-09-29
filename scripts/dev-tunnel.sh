#!/usr/bin/env bash
# Поднимает Cloudflare quick tunnel, подставляет свежий URL в .env
# (PUBLIC_WEBHOOK_URL) и запускает бота — так не нужно вручную ловить
# новый адрес и переписывать .env при каждом перезапуске туннеля.
#
# Использование:
#   ./scripts/dev-tunnel.sh          # разработка (npm run dev)
#   ./scripts/dev-tunnel.sh start    # продакшен (npm run build && npm start)
#
# Ctrl+C останавливает и бота, и туннель (см. trap ниже).

set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=".env"
CF_LOG="$(mktemp)"
MODE="${1:-dev}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Не найден $ENV_FILE — скопируйте .env.example и заполните его." >&2
  exit 1
fi

PORT="$(grep -E '^PORT=' "$ENV_FILE" | tail -1 | cut -d= -f2)"
PORT="${PORT:-8443}"

# На всякий случай гасим уже висящие quick tunnel'ы, чтобы не плодить процессы
# и не путаться, какой из них актуальный.
pkill -f "cloudflared tunnel.*http://localhost:${PORT}" 2>/dev/null || true
sleep 1

echo "[tunnel] запускаю cloudflared quick tunnel на localhost:${PORT}..."
cloudflared tunnel --protocol http2 --url "http://localhost:${PORT}" > "$CF_LOG" 2>&1 &
CF_PID=$!

cleanup() {
  echo ""
  echo "[tunnel] останавливаю cloudflared (pid $CF_PID)..."
  kill "$CF_PID" 2>/dev/null || true
  rm -f "$CF_LOG"
}
trap cleanup EXIT INT TERM

URL=""
for _ in $(seq 1 30); do
  URL="$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$CF_LOG" | head -1 || true)"
  if [[ -n "$URL" ]]; then break; fi
  sleep 1
done

if [[ -z "$URL" ]]; then
  echo "[tunnel] не удалось получить URL туннеля за 30 секунд, лог:" >&2
  cat "$CF_LOG" >&2
  exit 1
fi

echo "[tunnel] получен адрес: ${URL}"

# Обновляем PUBLIC_WEBHOOK_URL в .env (кроссплатформенно, без -i у sed).
NEW_LINE="PUBLIC_WEBHOOK_URL=${URL}/webhook"
if grep -q '^PUBLIC_WEBHOOK_URL=' "$ENV_FILE"; then
  awk -v line="$NEW_LINE" '/^PUBLIC_WEBHOOK_URL=/{print line; next} {print}' "$ENV_FILE" > "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"
else
  echo "$NEW_LINE" >> "$ENV_FILE"
fi
echo "[tunnel] .env обновлён: ${NEW_LINE}"

if [[ "$MODE" == "start" ]]; then
  npm run build
  npm start
else
  npm run dev
fi
