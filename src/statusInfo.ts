import { getMaxPlayers, getRole, legendUntil } from "./settingsStore";
import { config } from "./config";
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

const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const pad = (n: number) => String(n).padStart(2, "0");

function formatWhen(date: Date): string {
  const sec = date.getSeconds() ? `:${pad(date.getSeconds())}` : ""; // 11:59:59 — с секундами, если они есть
  return `${WEEKDAYS[date.getDay()]} ${pad(date.getDate())}.${pad(date.getMonth() + 1)} в ${pad(date.getHours())}:${pad(date.getMinutes())}${sec}`;
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
    `Основа: ${main.length} из ${max}${free ? `, свободно мест: ${free}` : " — мест нет, дальше резерв"}`,
    ...(main.length ? main.map((p, i) => `${i + 1}. ${name(p)}`) : ["— пока никого"]),
  ];
  if (reserve.length) {
    lines.push("", `Резерв: ${reserve.length}`, ...reserve.map((p, i) => `${main.length + i + 1}. ${name(p)}`));
  }
  return lines;
}

export function buildStatusText(chatId: number, now = Date.now()): string {
  const session = getSession(chatId);
  const vote = getVoteSession(chatId);
  const lines: string[] = ["📋 Статус записи", ""];

  if (session) {
    const game = new Date(session.date);
    const left = game.getTime() - now;
    if (isSignupOpen(session, now)) {
      lines.push(
        `✅ Запись открыта до начала игры — ${formatWhen(game)}, осталось ${formatDuration(left)}.`,
        "Записаться: «+» или кнопка «➕ Записаться».",
      );
    } else {
      lines.push(
        `🔒 Запись закрыта — игра ${left > -3 * 3_600_000 ? "началась" : "прошла"}: ${formatWhen(game)} (${formatDuration(left)} назад).`,
        "Состав зафиксирован, менять его может только админ.",
      );
    }
    lines.push(`Запись открыта: ${formatWhen(new Date(session.createdAt))}.`, ...rosterLines(session));
    const teams = teamsText(session);
    if (teams) lines.push("", teams);
  } else {
    const last = getArchivedSession(chatId);
    lines.push("⛔ Сейчас записи нет — она закрыта.");
    if (last) lines.push(`Последняя игра: ${formatWhen(new Date(last.date))}, игроков: ${last.players.length}.`);
  }

  const next = nextPublicationDate(chatId, new Date(now));
  const legend = getRole(chatId, "legend", now);
  const maniska = getRole(chatId, "maniska", now);
  if (legend || maniska) lines.push("");
  if (legend) lines.push(`🏆 Легенда: ${legend.displayName} (до ${pad(legendUntil(legend).getDate())}.${pad(legendUntil(legend).getMonth() + 1)}.${legendUntil(legend).getFullYear()}) — всегда 1-й в записи.`);
  if (maniska) lines.push(`👕 Манишки у: ${maniska.displayName} — всегда 2-й в записи.`);
  lines.push(
    "",
    vote ? `🗳 Идёт голосование за MVP — отдано голосов: ${vote.votes.length}.` : "🗳 Голосование за MVP сейчас не идёт.",
    next
      ? `🗓 Следующая запись откроется ${formatWhen(next)} — на игру ${formatWhen(computeNextGameDate(chatId, next))}. Расписание: ${currentScheduleText(chatId)}.`
      : `🗓 Новая запись публикуется автоматически: ${currentScheduleText(chatId)}.`,
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
