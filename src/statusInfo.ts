import { config } from "./config";
import { db } from "./db";
import * as api from "./maxApi";
import { currentScheduleText } from "./scheduleLogic";
import { getArchivedSession, getSession, getVoteSession } from "./store";
import { FootballSession } from "./types";

/**
 * /статус — для всех: актуальна ли запись, на какую игру, сколько мест
 * осталось, идёт ли голосование и когда бот сам опубликует следующую запись.
 */

const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const pad = (n: number) => String(n).padStart(2, "0");

function formatWhen(date: Date): string {
  return `${WEEKDAYS[date.getDay()]} ${pad(date.getDate())}.${pad(date.getMonth() + 1)} в ${pad(date.getHours())}:${pad(date.getMinutes())}`;
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
  const main = session.players.filter((p) => !p.isReserve).length;
  const reserve = session.players.length - main;
  const free = Math.max(0, config.maxPlayers - main);
  return [
    `Основа: ${main} из ${config.maxPlayers}${free ? `, свободно мест: ${free}` : " — мест нет, дальше резерв"}`,
    `Резерв: ${reserve}`,
  ];
}

export function buildStatusText(chatId: number, now = Date.now()): string {
  const session = getSession(chatId);
  const vote = getVoteSession(chatId);
  const lines: string[] = ["📋 Статус записи", ""];

  if (session) {
    const game = new Date(session.date);
    const left = game.getTime() - now;
    if (left > 0) {
      lines.push(
        "✅ Запись актуальна — можно записываться («+» или кнопка «Записаться»).",
        `Игра: ${formatWhen(game)} — через ${formatDuration(left)}.`,
      );
    } else {
      lines.push(
        "⚠️ Запись устарела: игра уже прошла, новая запись ещё не открыта.",
        `Игра была: ${formatWhen(game)} — ${formatDuration(left)} назад.`,
      );
    }
    lines.push(`Запись открыта: ${formatWhen(new Date(session.createdAt))}.`, ...rosterLines(session));
  } else {
    const last = getArchivedSession(chatId);
    lines.push("⛔ Сейчас записи нет — она закрыта.");
    if (last) lines.push(`Последняя игра: ${formatWhen(new Date(last.date))}, игроков: ${last.players.length}.`);
  }

  lines.push(
    "",
    vote ? `🗳 Идёт голосование за MVP — отдано голосов: ${vote.votes.length}.` : "🗳 Голосование за MVP сейчас не идёт.",
    `🗓 Новая запись публикуется автоматически: ${currentScheduleText()}.`,
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
