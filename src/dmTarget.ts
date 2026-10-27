import { config } from "./config";
import { db } from "./db";
import * as api from "./maxApi";
import { KeyboardButton } from "./maxApi";

/**
 * Каким чатом управляет человек из лички с ботом. Бот ведёт несколько чатов
 * (CHAT_IDS), у каждого свои запись, расписание и админы. Из лички действует
 * выбранный чат: тот, в котором человек состоит; если он в нескольких — по
 * умолчанию первый, а сменить можно кнопкой «🔁 Чат: …» (выбор запоминается).
 */

const titles = new Map<number, string>();
const membership = new Map<string, { member: boolean; at: number }>();
const MEMBERSHIP_TTL_MS = 10 * 60_000;

/** Название чата из MAX (кэшируется). */
export async function chatTitle(chatId: number): Promise<string> {
  const cached = titles.get(chatId);
  if (cached) return cached;
  try {
    const title = (await api.getChat(chatId)).title?.trim();
    if (title) {
      titles.set(chatId, title);
      return title;
    }
  } catch (err) {
    console.warn(`[dmTarget] не удалось узнать название чата ${chatId}:`, err instanceof Error ? err.message : err);
  }
  return `чат ${chatId}`;
}

async function isMember(chatId: number, userId: number): Promise<boolean> {
  const key = `${chatId}:${userId}`;
  const hit = membership.get(key);
  if (hit && Date.now() - hit.at < MEMBERSHIP_TTL_MS) return hit.member;
  try {
    const member = await api.isChatMember(chatId, userId);
    membership.set(key, { member, at: Date.now() });
    return member;
  } catch (err) {
    // Ошибку не кэшируем: при следующем обращении проверим снова.
    console.warn(`[dmTarget] не удалось проверить участника ${userId} в чате ${chatId}:`, err instanceof Error ? err.message : err);
    return false;
  }
}

/** Чаты бота, в которых состоит человек. */
export async function userChats(userId: number): Promise<number[]> {
  const result: number[] = [];
  for (const chatId of config.chatIds) if (await isMember(chatId, userId)) result.push(chatId);
  return result;
}

/**
 * Личка с ботом — только для участников чатов бота. Чужому человеку бот отвечает
 * отказом и пишет попытку в лог. true — можно продолжать.
 */
export async function dmAllowed(userId: number, userName = ""): Promise<boolean> {
  if ((await userChats(userId)).length) return true;
  console.log(`[dm] отказ: ${userName || "без имени"} (user_id=${userId}) не состоит ни в одном чате бота`);
  return false;
}

export const DM_DENIED = "Бот работает только для участников футбольных чатов. Вступите в чат — и запись станет доступна.";

const keyOf = (userId: number) => `dm_target:${userId}`;

/** Чат, которым человек сейчас управляет из лички. */
export async function dmTarget(userId: number): Promise<number> {
  const chats = await userChats(userId);
  const saved = db().prepare("SELECT value FROM meta WHERE key = ?").get(keyOf(userId)) as { value: string } | undefined;
  const savedId = saved ? Number(saved.value) : NaN;
  if (chats.includes(savedId)) return savedId;
  return chats[0] ?? config.defaultChatId;
}

export function setDmTarget(userId: number, chatId: number): void {
  db().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(keyOf(userId), String(chatId));
}

const btn = (text: string, payload: object): KeyboardButton => ({ type: "callback", text, payload: JSON.stringify(payload) });

/** Ряд «🔁 Чат: …» для меню в личке — только если человек состоит в нескольких чатах бота. */
export async function chatSwitchRow(userId: number): Promise<KeyboardButton[][]> {
  const chats = await userChats(userId);
  if (chats.length < 2) return [];
  return [[btn(`🔁 Чат: ${await chatTitle(await dmTarget(userId))}`, { a: "dm_chat" })]];
}

/** Кнопки выбора чата. */
export async function chatChoiceRows(userId: number): Promise<KeyboardButton[][]> {
  const current = await dmTarget(userId);
  const rows: KeyboardButton[][] = [];
  for (const chatId of await userChats(userId)) {
    rows.push([btn(`${chatId === current ? "✅ " : ""}${await chatTitle(chatId)}`, { a: "dm_chat_set", c: chatId })]);
  }
  return rows;
}
