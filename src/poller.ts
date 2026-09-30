import { config } from "./config";
import { db } from "./db";
import { deleteSubscription, getSubscriptions, getUpdates } from "./maxApi";
import { handleUpdate } from "./webhookServer";

/**
 * Режим UPDATES_MODE=polling: бот сам забирает события у MAX (GET /updates),
 * поэтому ему не нужны ни публичный адрес, ни HTTPS, ни туннель — достаточно
 * исходящего интернета. Позиция (marker) хранится в базе: после перезапуска бот
 * продолжает с того же места и не обрабатывает события повторно.
 */

const UPDATE_TYPES = ["message_created", "message_callback", "bot_started", "bot_added"];
const POLL_TIMEOUT_SEC = 30;
const MARKER_KEY = "updates_marker";

let running = false;

function loadMarker(): number | undefined {
  const row = db().prepare("SELECT value FROM meta WHERE key = ?").get(MARKER_KEY) as { value: string } | undefined;
  return row ? Number(row.value) : undefined;
}

function saveMarker(marker: number): void {
  db().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(MARKER_KEY, String(marker));
}

/** Long polling работает только без подписок на вебхук — снимаем их (например, оставшиеся от туннеля). */
async function dropWebhookSubscriptions(): Promise<void> {
  const { subscriptions } = await getSubscriptions();
  for (const sub of subscriptions) {
    await deleteSubscription(sub.url);
    console.log(`[poller] снята подписка на вебхук (мешает long polling): ${sub.url}`);
  }
}

export async function startPolling(): Promise<void> {
  running = true;
  try {
    await dropWebhookSubscriptions();
  } catch (err) {
    console.error("[poller] не удалось проверить подписки на вебхук:", err);
  }

  let marker = loadMarker();
  let backoffMs = 1000;
  console.log(`[poller] приём сообщений через long polling (marker=${marker ?? "нет"})`);

  while (running) {
    try {
      const res = await getUpdates(marker, POLL_TIMEOUT_SEC, UPDATE_TYPES);
      for (const update of res.updates ?? []) {
        if (!running) break;
        // Диагностика задержек: пришло ли событие поздно (со стороны MAX/сети) или долго обрабатывалось у нас.
        const lagSec = update.timestamp ? Math.round((Date.now() - update.timestamp) / 1000) : 0;
        if (lagSec > 30) console.warn(`[poller] событие ${update.update_type} пришло с опозданием ${lagSec} с`);
        const started = Date.now();
        await handleUpdate(update); // по порядку, как пришли
        const tookSec = Math.round((Date.now() - started) / 1000);
        if (tookSec > 10) console.warn(`[poller] обработка ${update.update_type} заняла ${tookSec} с`);
      }
      if (res.marker != null && res.marker !== marker) {
        marker = res.marker;
        saveMarker(marker);
      }
      backoffMs = 1000;
    } catch (err) {
      if (!running) break;
      // Сеть или MAX недоступны — пробуем снова с растущей паузой (до минуты).
      console.error(`[poller] ошибка получения событий, повтор через ${backoffMs / 1000} с:`, err instanceof Error ? err.message : err);
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
  }
}

export function stopPolling(): void {
  running = false;
}

export const pollingEnabled = () => config.updatesMode === "polling";
