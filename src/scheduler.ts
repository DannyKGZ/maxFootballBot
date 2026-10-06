import cron, { ScheduledTask } from "node-cron";
import { config, isManagedChat } from "./config";
import { closeSignupIfStarted, publishNewSession } from "./sessionLogic";
import { runNotifications } from "./notifications";
import { loadSchedule } from "./settingsStore";
import { slotCrons } from "./gameDays";
import { getAllSessions, getAllVoteSessions } from "./store";
import { autoStartVoteIfDue, finalizeVote } from "./voteLogic";

// Свои cron-задачи публикации записи у каждого чата (у /игры — по одной на пару).
const tasks = new Map<number, ScheduledTask[]>();

/**
 * (Пере)запускает публикацию записи чата по cron-выражению; прежнее расписание
 * этого чата останавливается. Вызывается при старте и после /расписание.
 */
export function applySchedule(chatId: number, expression: string | string[]): void {
  const expressions = Array.isArray(expression) ? expression : [expression];
  for (const e of expressions) if (!cron.validate(e)) throw new Error(`Некорректное cron-выражение: ${e}`);
  for (const t of tasks.get(chatId) ?? []) t.stop();
  tasks.set(
    chatId,
    expressions.map((e) =>
      cron.schedule(
        e,
        async () => {
          try {
            console.log(`[scheduler] публикую новую запись в чат ${chatId}`);
            await publishNewSession(chatId);
          } catch (err) {
            console.error(`[scheduler] ошибка публикации записи в чат ${chatId}:`, err);
          }
        },
        { timezone: config.timezone },
      ),
    ),
  );
  console.log(`[scheduler] чат ${chatId}: запись по расписанию ${expressions.map((e) => `"${e}"`).join(", ")} (${config.timezone})`);
}

/** Действующее расписание чата: /игры, иначе /расписание, иначе CRON_SCHEDULE. */
export function applyChatSchedule(chatId: number): void {
  applySchedule(chatId, slotCrons(chatId) ?? loadSchedule(chatId)?.cron ?? config.cronSchedule);
}

/**
 * Раз в TICK_INTERVAL_MS: уведомления перед/после игры (notifications.ts) и
 * автозакрытие голосования. Отметки хранятся в базе — рестарт не даёт повторов.
 */
async function tick(now = Date.now()): Promise<void> {
  // Игра началась — запись закрывается, список фиксируется.
  const sessions = getAllSessions().filter((s) => isManagedChat(s.chatId)); // только чаты из CHAT_IDS
  for (const session of sessions) {
    try {
      await closeSignupIfStarted(session, now);
    } catch (err) {
      console.error("[scheduler] ошибка закрытия записи:", err);
    }
  }

  await runNotifications(now);

  // Через час после начала игры (в 21:30) голосование за MVP открывается само.
  for (const session of sessions) {
    try {
      await autoStartVoteIfDue(session, now);
    } catch (err) {
      console.error("[scheduler] ошибка автозапуска голосования:", err);
    }
  }

  if (config.voteAutoCloseHours > 0) {
    for (const vote of getAllVoteSessions()) {
      if (now - vote.createdAt < config.voteAutoCloseHours * 3_600_000) continue;
      try {
        console.log(`[scheduler] автозакрытие голосования в чате ${vote.chatId}`);
        await finalizeVote(vote.chatId, true);
      } catch (err) {
        console.error("[scheduler] ошибка автозакрытия голосования:", err);
      }
    }
  }
}

let ticking = false;

/** Старт: расписание, сохранённое админом (иначе CRON_SCHEDULE), и периодические проверки. */
export function startScheduler(): void {
  if (config.chatIds.length === 0) console.warn("[scheduler] CHAT_IDS (CHAT_ID) не задан — публиковать запись некуда");
  for (const chatId of config.chatIds) applyChatSchedule(chatId);
  setInterval(() => {
    if (ticking) return; // предыдущая проверка ещё идёт (очистка чата может занять время)
    ticking = true;
    tick()
      .catch((err) => console.error("[scheduler] ошибка периодической проверки:", err))
      .finally(() => (ticking = false));
  }, config.tickIntervalMs);
}
