import { db } from "./db";
import { config } from "./config";
import { FootballSession, PendingAction, VoteSession } from "./types";

// Состояние бота по чатам. Источник правды — SQLite (см. db.ts); в памяти —
// кэш тех же объектов: обработчики меняют объект и потом вызывают set*, а
// параллельные запросы работают с одним и тем же объектом и не затирают друг
// друга. Каждая запись сразу уходит в базу, поэтому перезапуск ничего не теряет.

const sessions = new Map<number, FootballSession>(); // текущая запись чата
// Последняя закрытая запись чата: по ней голосуют за MVP, если новая уже открыта.
const archived = new Map<number, FootballSession>();
const votes = new Map<number, VoteSession>();
const pendingActions = new Map<string, PendingAction>(); // key = `${chatId}:${userId}`
// id сообщений бота с момента последней очистки — после голосования их удаляем.
const sentMessageIds = new Map<number, Set<string>>();
// Последнее сообщение с рейтингом MVP — новое /mvp заменяет его.
const ratingMessages = new Map<number, string>();

const pendingKey = (chatId: number, userId: number) => `${chatId}:${userId}`;

// ---- Запись ----

export function getSession(chatId: number): FootballSession | undefined {
  return sessions.get(chatId);
}

export function getAllSessions(): FootballSession[] {
  return [...sessions.values()];
}

export function setSession(session: FootballSession): void {
  sessions.set(session.chatId, session);
  db().prepare("INSERT OR REPLACE INTO sessions (chat_id, data) VALUES (?, ?)").run(session.chatId, JSON.stringify(session));
}

export function deleteSession(chatId: number): void {
  sessions.delete(chatId);
  db().prepare("DELETE FROM sessions WHERE chat_id = ?").run(chatId);
}

export function getArchivedSession(chatId: number): FootballSession | undefined {
  return archived.get(chatId);
}

export function getAllArchivedSessions(): FootballSession[] {
  return [...archived.values()];
}

export function setArchivedSession(session: FootballSession): void {
  archived.set(session.chatId, session);
  db()
    .prepare("INSERT OR REPLACE INTO archived_sessions (chat_id, data) VALUES (?, ?)")
    .run(session.chatId, JSON.stringify(session));
}

// ---- Открытые вопросы ("Да/Нет", "напишите имя") ----

/** Возвращает вопрос, если он ещё не устарел (PENDING_TTL_MINUTES); устаревший забывается. */
export function getPendingAction(chatId: number, userId: number): PendingAction | undefined {
  const action = pendingActions.get(pendingKey(chatId, userId));
  if (action && Date.now() - action.createdAt > config.pendingTtlMinutes * 60_000) {
    clearPendingAction(chatId, userId);
    return undefined;
  }
  return action;
}

export function setPendingAction(action: PendingAction): void {
  pendingActions.set(pendingKey(action.chatId, action.userId), action);
  db()
    .prepare("INSERT OR REPLACE INTO pending_actions (chat_id, user_id, data) VALUES (?, ?, ?)")
    .run(action.chatId, action.userId, JSON.stringify(action));
}

export function clearPendingAction(chatId: number, userId: number): void {
  if (!pendingActions.delete(pendingKey(chatId, userId))) return;
  db().prepare("DELETE FROM pending_actions WHERE chat_id = ? AND user_id = ?").run(chatId, userId);
}

// ---- Голосование ----

export function getVoteSession(chatId: number): VoteSession | undefined {
  return votes.get(chatId);
}

export function getAllVoteSessions(): VoteSession[] {
  return [...votes.values()];
}

export function setVoteSession(vote: VoteSession): void {
  votes.set(vote.chatId, vote);
  db().prepare("INSERT OR REPLACE INTO votes (chat_id, data) VALUES (?, ?)").run(vote.chatId, JSON.stringify(vote));
}

export function deleteVoteSession(chatId: number): void {
  votes.delete(chatId);
  db().prepare("DELETE FROM votes WHERE chat_id = ?").run(chatId);
}

// ---- Сообщения бота (для очистки) и рейтинг ----

/** Запоминает id сообщения, отправленного ботом в чат (для последующей очистки). */
export function trackSentMessage(chatId: number, messageId: string): void {
  let set = sentMessageIds.get(chatId);
  if (!set) sentMessageIds.set(chatId, (set = new Set()));
  set.add(messageId);
  db().prepare("INSERT OR IGNORE INTO sent_messages (chat_id, message_id) VALUES (?, ?)").run(chatId, messageId);
}

/** Забывает id удалённого сообщения, чтобы очистка не пыталась удалить его снова. */
export function untrackSentMessage(chatId: number, messageId: string): void {
  sentMessageIds.get(chatId)?.delete(messageId);
  db().prepare("DELETE FROM sent_messages WHERE chat_id = ? AND message_id = ?").run(chatId, messageId);
}

/**
 * Возвращает все отслеженные id сообщений чата, кроме `keep`, и сбрасывает
 * список (сообщения из `keep` остаются отслеженными дальше).
 */
export function takeSentMessagesForCleanup(chatId: number, keep: Array<string | null | undefined>): string[] {
  const set = sentMessageIds.get(chatId);
  if (!set) return [];
  const keepSet = new Set(keep.filter((id): id is string => Boolean(id)));
  const toDelete = [...set].filter((id) => !keepSet.has(id));
  const del = db().prepare("DELETE FROM sent_messages WHERE chat_id = ? AND message_id = ?");
  db().transaction(() => {
    for (const id of toDelete) {
      set.delete(id);
      del.run(chatId, id);
    }
  })();
  return toDelete;
}

export function getRatingMessage(chatId: number): string | undefined {
  return ratingMessages.get(chatId);
}

export function setRatingMessage(chatId: number, messageId: string): void {
  ratingMessages.set(chatId, messageId);
  db().prepare("INSERT OR REPLACE INTO rating_messages (chat_id, message_id) VALUES (?, ?)").run(chatId, messageId);
}

// ---- Загрузка при старте ----

/** Поднимает состояние из базы в кэш (и один раз переносит старые JSON — см. db.ts). */
export function loadSessionsFromDisk(): void {
  const d = db();
  const rows = (table: string) => d.prepare(`SELECT data FROM ${table}`).all() as Array<{ data: string }>;
  for (const r of rows("sessions")) {
    const s = JSON.parse(r.data) as FootballSession;
    sessions.set(s.chatId, s);
  }
  for (const r of rows("archived_sessions")) {
    const s = JSON.parse(r.data) as FootballSession;
    archived.set(s.chatId, s);
  }
  for (const r of rows("votes")) {
    const v = JSON.parse(r.data) as VoteSession;
    votes.set(v.chatId, v);
  }
  for (const r of rows("pending_actions")) {
    const p = JSON.parse(r.data) as PendingAction;
    pendingActions.set(pendingKey(p.chatId, p.userId), p);
  }
  for (const r of d.prepare("SELECT chat_id, message_id FROM sent_messages").all() as Array<{ chat_id: number; message_id: string }>) {
    let set = sentMessageIds.get(r.chat_id);
    if (!set) sentMessageIds.set(r.chat_id, (set = new Set()));
    set.add(r.message_id);
  }
  for (const r of d.prepare("SELECT chat_id, message_id FROM rating_messages").all() as Array<{ chat_id: number; message_id: string }>) {
    ratingMessages.set(r.chat_id, r.message_id);
  }
  console.log(
    `[store] восстановлено из ${config.dbFile}: записей ${sessions.size}, голосований ${votes.size}, открытых вопросов ${pendingActions.size}`,
  );
}

/** Каждая правка уже записана в базу — при остановке остаётся только закрыть её. */
export { closeDb as flushSessionsToDiskSync } from "./db";
