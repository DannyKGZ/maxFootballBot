import { sendMessageToChat, editMessage } from "./maxApi";
import { computeNextGameDate } from "./gameDays";
import { dateFull, NOT_ADMIN, timeHM } from "./format";
import { isChatAdmin } from "./sessionLogic";
import { cancelStoredGame, getArchivedSession, getSession } from "./store";
import { getLedgerMessageId } from "./paymentLedger";
import { db } from "./db";

export const CANCEL_GAME_RE = /^\/(?:отмена_?игры|отменить_?игру|cancel_game)(?:\s+([\s\S]+))?$/i;
const USAGE = "Укажите дату будущей игры в формате /отменаигры ДД.ММ.ГГГГ. Если в этот день две игры, добавьте время ЧЧ:ММ.";

function selectGame(chatId: number, arg: string, now: number): Date | string {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})(?:\s+((?:[01]\d|2[0-3]):[0-5]\d))?$/.exec(arg);
  if (!match) return USAGE;
  const [, day, month, year, time] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (dateFull(date) !== `${day}.${month}.${year}`) return "Такой даты в календаре нет.";
  const end = new Date(date);
  end.setDate(date.getDate() + 1);

  const games = new Set<number>();
  for (const session of [getSession(chatId), getArchivedSession(chatId)]) {
    const start = Date.parse(session?.date ?? "");
    if (start >= date.getTime() && start < end.getTime()) games.add(start);
  }
  for (let game = computeNextGameDate(chatId, new Date(date.getTime() - 1)); game < end; game = computeNextGameDate(chatId, game)) {
    games.add(game.getTime());
  }

  const matching = [...games].map((start) => new Date(start)).filter((game) => !time || timeHM(game) === time);
  if (matching.length > 1) return `На эту дату несколько игр. Укажите время игры: ${matching.map(timeHM).sort().join(", ")}.`;
  if (!matching.length) return `На ${arg} в этом чате нет игры.`;
  if (matching[0].getTime() <= now) return "Отменить можно только игру, которая ещё не началась.";
  return matching[0];
}

export async function cancelGameCommand(chatId: number, replyChatId: number, userId: number, arg?: string): Promise<string> {
  if (!(await isChatAdmin(chatId, userId))) return NOT_ADMIN;
  const game = selectGame(chatId, arg?.trim() ?? "", Date.now());
  if (typeof game === "string") return game;
  const when = `${dateFull(game)} в ${timeHM(game)}`;
  const gameDate = game.toISOString();
  if (db().prepare("SELECT 1 FROM match_history WHERE chat_id = ? AND game_at = ? AND mvp IS NOT NULL").get(chatId, game.getTime())) {
    return "По этой игре уже подведены итоги MVP.";
  }
  const cancelled = cancelStoredGame(chatId, gameDate);
  if (!cancelled) return `Игра ${when} уже отменена.`;

  const notice = `🚫 Игра ${when} отменена. Остальные игры остаются по расписанию.`;
  const messages = new Set([
    ...cancelled.sessions.flatMap((session) => [session.messageId, session.draft?.messageId, session.paymentMessageId]),
    cancelled.vote?.messageId,
    getLedgerMessageId(chatId, gameDate),
  ]);
  for (const mid of messages) {
    if (mid) await editMessage(chatId, mid, { text: notice, attachments: [] })
      .catch((err) => console.warn("[gameCancel] не удалось обновить сообщение:", err));
  }
  if (replyChatId !== chatId) await sendMessageToChat(chatId, { text: notice })
    .catch((err) => console.warn("[gameCancel] не удалось объявить отмену в группе:", err));
  return notice;
}
