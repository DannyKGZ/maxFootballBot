import { config, isManagedChat } from "./config";
import * as api from "./maxApi";
import { buildPaymentText, buildReminderText } from "./messageFormatter";
import { getAllArchivedSessions, getAllSessions, setArchivedSession, setSession } from "./store";
import { FootballSession } from "./types";

/**
 * Уведомления по времени игры:
 *  - «reminder» — за REMINDER_HOURS_BEFORE ч: сколько человек в основе и резерве;
 *  - «pay-3…pay-1», «pay+1…pay+2» — оплата каждый час за PAYMENT_HOURS_BEFORE ч
 *    до игры и PAYMENT_HOURS_AFTER ч после, отдельным сообщением с упоминаниями.
 * Что уже отправлено, хранится в session.notified (в базе) — рестарт не даёт повторов.
 * Если бот был выключен, пропущенные уведомления не рассылаются пачкой:
 * отправляется только последнее, и только если оно опоздало не больше чем на час.
 */

const HOUR = 3_600_000;
const FRESH_MS = HOUR;

interface Slot {
  key: string;
  at: number;
  kind: "reminder" | "payment";
  phase?: "before" | "after";
  hours: number;
}

function slotsFor(session: FootballSession): Slot[] {
  const game = new Date(session.date).getTime();
  const slots: Slot[] = [];
  if (config.reminderHoursBefore > 0) {
    slots.push({ key: "reminder", at: game - config.reminderHoursBefore * HOUR, kind: "reminder", hours: config.reminderHoursBefore });
  }
  for (let h = config.paymentHoursBefore; h >= 1; h--) {
    slots.push({ key: `pay-${h}`, at: game - h * HOUR, kind: "payment", phase: "before", hours: h });
  }
  for (let h = 1; h <= config.paymentHoursAfter; h++) {
    slots.push({ key: `pay+${h}`, at: game + h * HOUR, kind: "payment", phase: "after", hours: h });
  }
  return slots;
}

/** Какие слоты наступили (их отмечаем) и какие из них реально отправить. Чистая функция — для тестов. */
export function dueNotifications(session: FootballSession, now: number): { mark: string[]; send: Slot[] } {
  const notified = new Set(session.notified ?? []);
  if (session.reminderSent) notified.add("reminder");
  const game = new Date(session.date).getTime();
  const due = slotsFor(session).filter((s) => now >= s.at && !notified.has(s.key));
  const fresh = due.filter((s) => now - s.at <= FRESH_MS);

  const send: Slot[] = [];
  const reminder = fresh.find((s) => s.kind === "reminder");
  if (reminder && now < game) send.push(reminder);
  const payment = fresh.filter((s) => s.kind === "payment").pop(); // только самое свежее
  if (payment) send.push(payment);
  return { mark: due.map((s) => s.key), send };
}

async function notifySession(session: FootballSession, now: number, save: (s: FootballSession) => void) {
  if (session.players.length === 0) return;
  const { mark, send } = dueNotifications(session, now);
  if (mark.length === 0) return;
  // Сначала отмечаем, потом отправляем: при сбое лучше пропустить одно, чем слать дважды.
  session.notified = [...new Set([...(session.notified ?? []), ...mark])];
  save(session);

  for (const slot of send) {
    try {
      if (slot.kind === "reminder") {
        await api.sendMessageToChat(session.chatId, { text: buildReminderText(session) });
        continue;
      }
      if (session.paymentMessageId) {
        // Прошлое напоминание об оплате заменяем новым, чтобы не копились.
        await api.deleteMessage(session.chatId, session.paymentMessageId).catch(() => undefined);
      }
      const res = await api.sendMessageToChat(session.chatId, {
        text: buildPaymentText(session, slot.phase!, slot.hours),
        format: "html",
      });
      session.paymentMessageId = res.message.body.mid;
      save(session);
    } catch (err) {
      console.error(`[notifications] не удалось отправить «${slot.key}» в чат ${session.chatId}:`, err);
    }
  }
}

/** Вызывается планировщиком периодически (TICK_INTERVAL_MS). */
export async function runNotifications(now = Date.now()): Promise<void> {
  for (const s of getAllSessions().filter((x) => isManagedChat(x.chatId))) await notifySession(s, now, setSession);
  // Игра прошла, а запись уже закрыта (например, открыли новую) — оплату после игры всё равно напоминаем.
  for (const s of getAllArchivedSessions().filter((x) => isManagedChat(x.chatId))) await notifySession(s, now, setArchivedSession);
}
