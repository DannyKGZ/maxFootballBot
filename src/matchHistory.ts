import { db } from "./db";
import { dateFull, timeHM } from "./format";
import { packBlocks } from "./messageParts";
import { isGameCancelled } from "./gameCancellations";
import { hasEnoughPlayers } from "./gameAttendance";
import type { FootballSession, VoteSession } from "./types";

export const HISTORY_RE = /^\/(?:история|history)(?:\s+([\s\S]+))?$/i;
const PAGE_SIZE = 5;

type Roster = Array<{ displayName: string; isReserve: boolean }>;

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
  saveRoster(session.chatId, gameAt, session.players.map(({ displayName, isReserve }) => ({ displayName, isReserve })), true, now);
}

export function saveMatchMvp(vote: VoteSession, winners: string[], session?: FootballSession, now = Date.now()): void {
  if (isGameCancelled(vote.chatId, vote.gameDate)) return;
  const gameAt = Date.parse(vote.gameDate);
  const roster = session?.players.map(({ displayName, isReserve }) => ({ displayName, isReserve }))
    ?? vote.candidates.map(({ displayName }) => ({ displayName, isReserve: false }));
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

export function buildMatchHistory(chatId: number, pageArg?: string): string[] {
  const page = pageArg === undefined ? 1 : Number(pageArg.trim());
  if (!Number.isSafeInteger(page) || page < 1 || (pageArg !== undefined && !/^\d+$/.test(pageArg.trim()))) {
    return ["Номер страницы: /история 2"];
  }
  const now = Date.now();
  const filter = "FROM match_history WHERE chat_id = ? AND game_at <= ? AND expires_at > ?";
  const { count } = db().prepare(`SELECT count(*) AS count ${filter}`).get(chatId, now, now) as { count: number };
  const pages = Math.ceil(count / PAGE_SIZE);
  if (pages === 0 || page > pages) {
    return [pages === 0 ? "За последние полгода матчей в истории нет." : `В истории ${pages} стр. Начните с /история.`];
  }
  const rows = db().prepare(`SELECT game_at, roster, mvp ${filter} ORDER BY game_at DESC LIMIT ? OFFSET ?`)
    .all(chatId, now, now, PAGE_SIZE, (page - 1) * PAGE_SIZE) as Array<{ game_at: number; roster: string; mvp: string | null }>;
  const blocks = [[`📚 История матчей · ${page}/${pages}`]];
  for (const row of rows) {
    const date = new Date(row.game_at);
    const roster = JSON.parse(row.roster) as Roster;
    const winners = new Set<string>(row.mvp === null ? [] : JSON.parse(row.mvp) as string[]);
    const listPlayers = (names: string[]) => names.map((name, index) => {
      const badge = winners.has(name) ? " — 🏆 MVP" : "";
      return `${index + 1}. ${name}${badge}`;
    });
    const main = roster.filter((player) => !player.isReserve).map((player) => player.displayName);
    const reserve = roster.filter((player) => player.isReserve).map((player) => player.displayName);
    blocks.push([
      `⚽ ${dateFull(date)}, ${timeHM(date)}`,
      "",
      `👥 Состав (${main.length})`,
      ...listPlayers(main),
      ...(reserve.length ? ["", `🪑 Резерв (${reserve.length})`, ...listPlayers(reserve)] : []),
    ]);
  }
  if (page < pages) blocks.push([`Следующая страница: /история ${page + 1}`]);
  return packBlocks(blocks);
}
