import cron, { ScheduledTask } from "node-cron";
import { config } from "./config";
import { closeSignupIfStarted, publishNewSession } from "./sessionLogic";
import { runNotifications } from "./notifications";
import { loadSchedule } from "./settingsStore";
import { getAllSessions, getAllVoteSessions } from "./store";
import { autoStartVoteIfDue, finalizeVote } from "./voteLogic";

let task: ScheduledTask | null = null;

/**
 * (Пере)запускает публикацию записи по cron-выражению; предыдущее расписание
 * останавливается. Вызывается при старте и после настройки расписания админом.
 */
export function applySchedule(expression: string): void {
  if (!cron.validate(expression)) {
    throw new Error(`Некорректное cron-выражение: ${expression}`);
  }
  if (!config.defaultChatId) {
    console.warn("[scheduler] CHAT_ID не задан — планировщик не запущен");
    return;
  }

  task?.stop();
  task = cron.schedule(
    expression,
    async () => {
      try {
        console.log(`[scheduler] публикую новую запись в чат ${config.defaultChatId}`);
        await publishNewSession(config.defaultChatId);
      } catch (err) {
        console.error("[scheduler] ошибка публикации записи:", err);
      }
    },
    { timezone: config.timezone },
  );

  console.log(
    `[scheduler] запущен: "${expression}" (${config.timezone}), чат ${config.defaultChatId}`,
  );
}

/**
 * Раз в TICK_INTERVAL_MS: уведомления перед/после игры (notifications.ts) и
 * автозакрытие голосования. Отметки хранятся в базе — рестарт не даёт повторов.
 */
async function tick(now = Date.now()): Promise<void> {
  // Игра началась — запись закрывается, список фиксируется.
  for (const session of getAllSessions()) {
    try {
      await closeSignupIfStarted(session, now);
    } catch (err) {
      console.error("[scheduler] ошибка закрытия записи:", err);
    }
  }

  await runNotifications(now);

  // Через час после начала игры (в 21:30) голосование за MVP открывается само.
  for (const session of getAllSessions()) {
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
  applySchedule(loadSchedule()?.cron ?? config.cronSchedule);
  setInterval(() => {
    if (ticking) return; // предыдущая проверка ещё идёт (очистка чата может занять время)
    ticking = true;
    tick()
      .catch((err) => console.error("[scheduler] ошибка периодической проверки:", err))
      .finally(() => (ticking = false));
  }, config.tickIntervalMs);
}
