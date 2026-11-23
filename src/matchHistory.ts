import { db } from "./db";
import { dateFull, gameWhen, timeHM } from "./format";
import { packBlocks } from "./messageParts";
import { isGameCancelled } from "./gameCancellations";
import { hasEnoughPlayers } from "./gameAttendance";
import type { FootballSession, VoteSession } from "./types";
import type { KeyboardButton, NewMessageBody } from "./maxApi";
import { callbackButton } from "./keyboard";

export const HISTORY_RE = /^\/(?:история|history)(?:\s+([\s\S]+))?$/i;
const PAGE_SIZE = 5;
const ROSTER_PART_CHARS = 850;
const HISTORY_FILTER = "FROM match_history WHERE chat_id = ? AND (game_at <= ? OR cancellation_reason IS NOT NULL) AND expires_at > ?";

type Roster = Array<{ displayName: string; isReserve: boolean }>;
export type CancellationReason = "admin" | "not_enough_players";
interface HistoryRow {
  game_at: number;
  roster: string;
  mvp: string | null;
  cancellation_reason: CancellationReason | null;
}

function matchRoster(session: FootballSession): Roster {
  return session.players.map(({ displayName, isReserve }) => ({ displayName, isReserve }));
}

export function matchExpiresAt(gameAt: number): number {
  const expiry = new Date(gameAt);
  const day = expiry.getDate();
  expiry.setDate(1);
  expiry.setMonth(expiry.getMonth() + 6);
  const lastDay = new Date(expiry.getFullYear(), expiry.getMonth() + 1, 0).getDate();
  expiry.setDate(Math.min(day, lastDay));
  return expiry.getTime();
}

function saveRoster(chatId: number, gameAt: number, roster: Roster, refresh: boolean, now: number): void {
  const expiresAt = matchExpiresAt(gameAt);
  if (!Number.isFinite(gameAt) || expiresAt <= now || !roster.some((player) => !player.isReserve)) return;
  db().prepare(
    `INSERT INTO match_history (chat_id, game_at, expires_at, roster)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (chat_id, game_at) DO UPDATE SET roster = excluded.roster
     WHERE ? AND roster <> excluded.roster`,
  ).run(chatId, gameAt, expiresAt, JSON.stringify(roster), Number(refresh));
}

export function rememberPlayedMatch(session: FootballSession, now = Date.now()): void {
  const gameAt = Date.parse(session.date);
  if (gameAt > now || !hasEnoughPlayers(session) || isGameCancelled(session.chatId, session.date)) return;
  saveRoster(session.chatId, gameAt, matchRoster(session), true, now);
}

export function rememberCancelledMatch(chatId: number, gameDate: string, reason: CancellationReason, session?: FootballSession): void {
  const gameAt = Date.parse(gameDate);
  const expiresAt = matchExpiresAt(gameAt);
  if (!Number.isFinite(gameAt) || expiresAt <= Date.now()) return;
  const roster = session ? matchRoster(session) : [];
  db().prepare(
    `INSERT INTO match_history (chat_id, game_at, expires_at, roster, cancellation_reason)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (chat_id, game_at) DO UPDATE SET
       roster = excluded.roster, cancellation_reason = excluded.cancellation_reason, mvp = NULL`,
  ).run(chatId, gameAt, expiresAt, JSON.stringify(roster), reason);
}

export function saveMatchMvp(vote: VoteSession, winners: string[], session?: FootballSession, now = Date.now()): void {
  if (isGameCancelled(vote.chatId, vote.gameDate)) return;
  const gameAt = Date.parse(vote.gameDate);
  const roster = session ? matchRoster(session) : vote.candidates.map(({ displayName }) => ({ displayName, isReserve: false }));
  saveRoster(vote.chatId, gameAt, roster, false, now);
  db().prepare("UPDATE match_history SET mvp = ? WHERE chat_id = ? AND game_at = ? AND expires_at > ?")
    .run(JSON.stringify(winners), vote.chatId, gameAt, now);
}

export function pruneMatchHistory(now = Date.now()): void {
  db().transaction(() => {
    db().prepare("DELETE FROM match_history WHERE expires_at <= ?").run(now);
    db().prepare("DELETE FROM mvp_announcements WHERE expires_at <= ?").run(now);
  })();
}

function historyView(text: string, rows: KeyboardButton[][] = []): NewMessageBody {
  return { text, attachments: rows.length ? [{ type: "inline_keyboard", payload: { buttons: rows } }] : [] };
}

const listButton = (text: string, chatId: number, page: number) => callbackButton(text, { a: "history_list", g: chatId, p: page });
const matchButton = (text: string, chatId: number, page: number, gameAt: number, part: number) =>
  callbackButton(text, { a: "history_match", g: chatId, p: page, t: gameAt, r: part });

export function historyCommand(chatId: number, pageArg?: string, groupTitle?: string): NewMessageBody {
  const page = pageArg === undefined ? 1 : Number(pageArg.trim());
  if (pageArg !== undefined && !/^\d+$/.test(pageArg.trim())) return historyView("Укажите номер страницы, например /история 2.");
  return buildHistoryPage(chatId, page, groupTitle);
}

export function buildHistoryPage(chatId: number, page: number, groupTitle?: string): NewMessageBody {
  if (!Number.isSafeInteger(page) || page < 1) return historyView("Укажите номер страницы, например /история 2.");
  const now = Date.now();
  const { count } = db().prepare(`SELECT count(*) AS count ${HISTORY_FILTER}`).get(chatId, now, now) as { count: number };
  const pages = Math.ceil(count / PAGE_SIZE);
  if (!pages) return historyView("За последние полгода матчей в истории нет.");
  if (page > pages) {
    return historyView("Эта страница больше недоступна.", [[listButton("📚 К списку матчей", chatId, 1)]]);
  }
  const matches = db().prepare(`SELECT game_at, cancellation_reason ${HISTORY_FILTER} ORDER BY game_at DESC LIMIT ? OFFSET ?`)
    .all(chatId, now, now, PAGE_SIZE, (page - 1) * PAGE_SIZE) as Array<Pick<HistoryRow, "game_at" | "cancellation_reason">>;
  const buttons = matches.map((row) => {
    const label = `${row.cancellation_reason ? "🚫" : "⚽"} ${gameWhen(new Date(row.game_at))}`;
    return [matchButton(label, chatId, page, row.game_at, 1)];
  });
  const navigation = [];
  if (page > 1) navigation.push(listButton("‹ Назад", chatId, page - 1));
  if (page < pages) navigation.push(listButton("Дальше ›", chatId, page + 1));
  if (navigation.length) buttons.push(navigation);
  return historyView([
    `📚 История матчей${pages > 1 ? ` · ${page}/${pages}` : ""}`,
    ...(groupTitle ? [groupTitle] : []),
    "",
    "Нажмите на дату, чтобы открыть состав.",
    ...(matches.some((row) => row.cancellation_reason) ? ["🚫 — отменённый матч"] : []),
  ].join("\n"), buttons);
}

export function buildHistoryMatch(chatId: number, page: number, gameAt: number, part: number, groupTitle?: string): NewMessageBody {
  const back = [listButton("‹ К списку матчей", chatId, page)];
  const now = Date.now();
  const row = Number.isSafeInteger(gameAt)
    ? db().prepare(`SELECT game_at, roster, mvp, cancellation_reason ${HISTORY_FILTER} AND game_at = ?`)
      .get(chatId, now, now, gameAt) as HistoryRow | undefined
    : undefined;
  if (!row) return historyView("Этот матч больше недоступен.", [back]);

  const roster = JSON.parse(row.roster) as Roster;
  const winners = new Set<string>(row.mvp === null ? [] : JSON.parse(row.mvp) as string[]);
  const listPlayers = (players: Roster) => players.map(({ displayName }, index) =>
    `${index + 1}. ${displayName}${winners.has(displayName) ? " — 🏆 MVP" : ""}`,
  );
  const main = roster.filter((player) => !player.isReserve);
  const reserve = roster.filter((player) => player.isReserve);
  const parts = packBlocks([
    [`👥 Состав (${main.length})`, ...(main.length ? listPlayers(main) : ["— Никто не записался в основу"])],
    ...(reserve.length ? [[`🪑 Резерв (${reserve.length})`, ...listPlayers(reserve)]] : []),
  ], ROSTER_PART_CHARS);
  if (!Number.isSafeInteger(part) || part < 1 || part > parts.length) {
    return historyView("Эта часть состава больше недоступна.", [
      [matchButton("👥 К составу", chatId, page, gameAt, 1)], back,
    ]);
  }
  const date = new Date(gameAt);
  const cancellation = row.cancellation_reason === "not_enough_players"
    ? `🚫 Игра отменена. Состав не собрался (в основе ${main.length}).`
    : "🚫 Игра отменена администратором.";
  const navigation = [];
  if (part > 1) navigation.push(matchButton("‹ Состав", chatId, page, gameAt, part - 1));
  if (part < parts.length) navigation.push(matchButton("Состав ›", chatId, page, gameAt, part + 1));
  return historyView([
    `⚽ ${dateFull(date)}, ${timeHM(date)}`,
    ...(groupTitle ? [groupTitle] : []),
    ...(row.cancellation_reason ? [cancellation] : []),
    "",
    parts[part - 1],
  ].join("\n"), navigation.length ? [navigation, back] : [back]);
}
