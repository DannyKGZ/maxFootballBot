import { db } from "./db";
import { getMinPlayers } from "./settingsStore";
import type { FootballSession } from "./types";

let from = Infinity;

// Уже сыгранные матчи сохраняют историю, голоса и состояние оплаты.
export function initGameAttendance(now = Date.now()): void {
  const key = "attendance_check_from";
  db().prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(key, String(now));
  const row = db().prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string };
  from = Number(row.value);
}

export function needsAttendanceCheck(session: FootballSession): boolean {
  return !session.attendanceConfirmed && Date.parse(session.date) >= from;
}

export function mainPlayerCount(session: FootballSession): number {
  return session.players.filter((player) => !player.isReserve).length;
}

export function hasEnoughPlayers(session: FootballSession): boolean {
  return !needsAttendanceCheck(session) || mainPlayerCount(session) >= getMinPlayers(session.chatId);
}
