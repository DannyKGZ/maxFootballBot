import { deleteSubscription, getSubscriptions, getUpdates } from "./maxApi";
import { enqueuePollingBatch, isMaxUpdate, loadPollingMarker, UPDATE_TYPES } from "./updateQueue";

/**
 * Режим UPDATES_MODE=polling: бот сам забирает события у MAX (GET /updates),
 * поэтому ему не нужны ни публичный адрес, ни HTTPS, ни туннель — достаточно
 * исходящего интернета. Позиция (marker) хранится в базе: после перезапуска бот
 * продолжает с того же места и не обрабатывает события повторно.
 */

const POLL_TIMEOUT_SEC = 30;

let running = false;
let lastSuccess = 0;

export function isPollingReady(): boolean {
  return running && lastSuccess > 0 && Date.now() - lastSuccess < 90_000;
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
  lastSuccess = 0;
  try {
    await dropWebhookSubscriptions();
  } catch (err) {
    console.error("[poller] не удалось проверить подписки на вебхук:", err);
  }

  if (!running) return;
  let marker = loadPollingMarker();
  let backoffMs = 1000;
  let failures = 0;
  console.log(`[poller] приём сообщений через long polling (marker=${marker ?? "нет"})`);

  while (running) {
    try {
      const res = await getUpdates(marker, POLL_TIMEOUT_SEC, UPDATE_TYPES);
      if (!running) break;
      if (!Array.isArray(res?.updates) || !res.updates.every(isMaxUpdate) || (res.marker != null && !Number.isFinite(res.marker))) {
        throw new Error("MAX вернул некорректную пачку событий");
      }
      for (const update of res.updates) {
        const lagSec = Math.round((Date.now() - update.timestamp) / 1000);
        if (update.timestamp > 100_000_000_000 && lagSec > 30) {
          console.warn(`[poller] событие ${update.update_type} пришло с опозданием ${lagSec} с`);
        }
      }
      if (res.updates.length || (res.marker != null && res.marker !== marker)) enqueuePollingBatch(res.updates, res.marker);
      if (res.marker != null) marker = res.marker;
      lastSuccess = Date.now();
      backoffMs = 1000;
      if (failures > 1) console.log("[poller] связь с MAX восстановлена");
      failures = 0;
    } catch (err) {
      if (!running) break;
      // Сеть или MAX недоступны — пробуем снова с растущей паузой (до минуты).
      // Разовый сбой (например, сервер закрыл простаивавшее соединение) — норма, это предупреждение;
      // ошибка — если сбои идут подряд.
      failures++;
      const msg = err instanceof Error ? err.message : String(err);
      if (failures === 1) console.warn(`[poller] разовый сбой связи с MAX, повтор через ${backoffMs / 1000} с: ${msg}`);
      else console.error(`[poller] нет связи с MAX (${failures}-й сбой подряд), повтор через ${backoffMs / 1000} с: ${msg}`);
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 60_000);
    }
  }
}

export function stopPolling(): void {
  running = false;
}
