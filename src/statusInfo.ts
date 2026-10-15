import { dateFull, gameWhen, pad } from "./format";
import { getMaxPlayers, getRole, legendUntil } from "./settingsStore";
import { db } from "./db";
import * as api from "./maxApi";
import { currentScheduleText } from "./scheduleLogic";
import { getArchivedSession, getSession, getVoteSession } from "./store";
import { FootballSession } from "./types";
import { computeNextGameDate, isSignupOpen, nextPublicationDate } from "./gameDays";
import { teamsText } from "./draftLogic";

/**
 * /статус — для всех: актуальна ли запись, на какую игру, сколько мест
 * осталось, идёт ли голосование и когда бот сам опубликует следующую запись.
 */



/** «Пт 09.10, 20:30» (с секундами, если они есть: 11:59:59). */
function formatWhen(date: Date): string {
  const sec = date.getSeconds() ? `:${pad(date.getSeconds())}` : "";
  return `${gameWhen(date)}${sec}`;
}

/** «1 д 3 ч», «2 ч 15 мин», «12 мин». */
function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(Math.abs(ms) / 60_000));
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d > 0) return h ? `${d} д ${h} ч` : `${d} д`;
  if (h > 0) return m ? `${h} ч ${m} мин` : `${h} ч`;
  return `${m} мин`;
}

function rosterLines(session: FootballSession): string[] {
  const main = session.players.filter((p) => !p.isReserve);
  const reserve = session.players.filter((p) => p.isReserve);
  const max = getMaxPlayers(session.chatId);
  const free = Math.max(0, max - main.length);
  const name = (p: FootballSession["players"][number]) => (p.lastName ? `${p.displayName} ${p.lastName}` : p.displayName);
  const lines = [
    "",
    `Основа ${main.length}/${max}${free ? `, свободно ${free}` : ", мест нет"}:`,
    ...(main.length ? main.map((p, i) => `${i + 1}. ${name(p)}`) : ["— никого"]),
  ];
  if (reserve.length) {
    lines.push("", `Резерв ${reserve.length}:`, ...reserve.map((p, i) => `${main.length + i + 1}. ${name(p)}`));
  }
  return lines;
}

export function buildStatusText(chatId: number, now = Date.now()): string {
  const session = getSession(chatId);
  const vote = getVoteSession(chatId);
  const lines: string[] = [];

  if (session) {
    const game = new Date(session.date);
    const left = game.getTime() - now;
    lines.push(`📋 Игра ${formatWhen(game)}`);
    lines.push(
      isSignupOpen(session, now)
        ? `✅ Запись открыта, до игры ${formatDuration(left)}. Записаться: «+».`
        : `🔒 Запись закрыта: игра ${left > -3 * 3_600_000 ? "идёт" : "прошла"} (${formatDuration(left)} назад). Состав меняет админ.`,
    );
    lines.push(...rosterLines(session));
    const teams = teamsText(session);
    if (teams) lines.push("", teams);
  } else {
    const last = getArchivedSession(chatId);
    lines.push(`📋 Записи нет.${last ? ` Последняя игра: ${formatWhen(new Date(last.date))}, игроков ${last.players.length}.` : ""}`);
  }

  const next = nextPublicationDate(chatId, new Date(now));
  const legend = getRole(chatId, "legend", now);
  const maniska = getRole(chatId, "maniska", now);
  lines.push("");
  if (legend) lines.push(`🏆 Легенда: ${legend.displayName} (до ${dateFull(legendUntil(legend))})`);
  if (maniska) lines.push(`👕 Манишки: ${maniska.displayName}`);
  if (vote) lines.push(`🗳 Голосование MVP: ${vote.votes.length} из ${Object.values(vote.creditsByVoter).reduce((a, b) => a + b, 0)} голосов`);
  lines.push(
    next
      ? `🗓 Следующая запись: ${formatWhen(next)} → игра ${formatWhen(computeNextGameDate(chatId, next))}`
      : `🗓 Расписание: ${currentScheduleText(chatId)}`,
  );
  return lines.join("\n");
}

// Новое /статус заменяет прошлое сообщение со статусом, чтобы они не копились;
// одновременные запросы (несколько человек сразу) дают одно сообщение.
const statusKey = (chatId: number) => `status_msg:${chatId}`;
const inFlight = new Map<number, Promise<void>>();

async function postStatus(chatId: number): Promise<void> {
  const prev = db().prepare("SELECT value FROM meta WHERE key = ?").get(statusKey(chatId)) as { value: string } | undefined;
  if (prev) await api.deleteMessage(chatId, prev.value).catch(() => undefined);
  const res = await api.sendMessageToChat(chatId, { text: buildStatusText(chatId) });
  db().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(statusKey(chatId), res.message.body.mid);
}

/** /статус в общем чате. */
export function showStatus(chatId: number): Promise<void> {
  const running = inFlight.get(chatId);
  if (running) return running;
  const task = postStatus(chatId).finally(() => inFlight.delete(chatId));
  inFlight.set(chatId, task);
  return task;
}
