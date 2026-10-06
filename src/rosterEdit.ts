import * as api from "./maxApi";
import { InlineKeyboardAttachment, KeyboardButton } from "./maxApi";
import { adminRemoveAt, adminRenameAt, adminSwap, ensurePlayerIds, findPlayerIndex, isChatAdmin, playerKey } from "./sessionLogic";
import { getSession } from "./store";
import { dmTarget } from "./dmTarget";
import { ButtonAction, FootballSession } from "./types";

/**
 * Правка списка админом:
 *  - команды (в общем чате или в личке): /удалить 3 · /удалить Имя ·
 *    /переименовать 3 Новое имя (синоним /заменить);
 *  - редактор в личке (кнопка «✏️ Список игроков» в панели): выбрать игрока →
 *    «❌ Удалить» или «✏️ Переименовать» (новое имя — следующим сообщением).
 * Работает и после начала игры: так админ поправляет итоговый состав.
 */

export const REMOVE_RE = /^\/(удалить|remove)\s+([\s\S]+)$/i;
export const RENAME_RE = /^\/(переименовать|заменить|rename)\s+(\S+)\s+([\s\S]+)$/i;
/** «/поменять 1 на 12», «/поменять 1 12», «/поменять 1 и 12» — номера в списке. */
export const SWAP_RE = /^\/(поменять|swap)\s+(\d+)\s+(?:(?:на|и)\s+)?(\d+)$/i;

const NOT_ADMIN = "Эта команда доступна только администраторам чата.";

function label(session: FootballSession, i: number): string {
  const p = session.players[i];
  return `${i + 1}. ${p.displayName}${p.isReserve ? " (резерв)" : ""}`;
}

/** /удалить 3 или /удалить Имя → текст ответа. */
export async function removeCommand(groupChatId: number, userId: number, ref: string): Promise<string> {
  if (!(await isChatAdmin(groupChatId, userId))) return NOT_ADMIN;
  const session = getSession(groupChatId);
  if (!session) return "Сейчас записи нет.";
  const i = findPlayerIndex(session, ref);
  if (i === -1) return `В списке нет «${ref.trim()}». Укажите номер из списка или имя, например: /удалить 3`;
  const name = await adminRemoveAt(session, i);
  return `✅ Админ убрал из списка: ${name}`;
}

/** /переименовать 3 Новое имя → текст ответа. */
export async function renameCommand(groupChatId: number, userId: number, ref: string, newName: string): Promise<string> {
  if (!(await isChatAdmin(groupChatId, userId))) return NOT_ADMIN;
  const session = getSession(groupChatId);
  if (!session) return "Сейчас записи нет.";
  const i = findPlayerIndex(session, ref);
  if (i === -1) return `В списке нет «${ref.trim()}». Пример: /переименовать 3 Новое имя`;
  const old = session.players[i].displayName;
  const error = await adminRenameAt(session, i, newName);
  return error ?? `✅ ${i + 1}. ${old} → ${newName.trim()}`;
}

/** /поменять 1 на 12 → текст ответа. */
export async function swapCommand(groupChatId: number, userId: number, a: string, b: string): Promise<string> {
  if (!(await isChatAdmin(groupChatId, userId))) return NOT_ADMIN;
  const session = getSession(groupChatId);
  if (!session) return "Сейчас записи нет.";
  const [i, j] = [Number(a) - 1, Number(b) - 1];
  const n = session.players.length;
  if (i === j || i < 0 || j < 0 || i >= n || j >= n) {
    return `Укажите два разных номера из списка (1–${n}), например: /поменять 1 на 12`;
  }
  const [x, y] = [session.players[i], session.players[j]];
  await adminSwap(session, i, j);
  const where = (p: typeof x) => (p.isReserve ? "в резерве" : "в основе");
  return `✅ Поменял местами: ${x.displayName} теперь №${j + 1} (${where(x)}), ${y.displayName} — №${i + 1} (${where(y)}).`;
}

// ---- Редактор в личке ----

const btn = (text: string, action: ButtonAction): KeyboardButton => ({ type: "callback", text, payload: JSON.stringify(action) });
const kb = (rows: KeyboardButton[][]): InlineKeyboardAttachment => ({ type: "inline_keyboard", payload: { buttons: rows } });

// Админ, который сейчас вводит новое имя: ключ `${dmChatId}:${userId}` → ключ игрока.
const awaitingRename = new Map<string, { k: string; messageId: string; group: number }>();

function listView(session: FootballSession | undefined) {
  if (session) ensurePlayerIds(session);
  if (!session || session.players.length === 0) {
    return { text: "✏️ В записи пока никого нет.", attachments: [kb([[btn("Закрыть", { a: "ed_close" })]])] };
  }
  return {
    text: "✏️ Список игроков — выберите, кого изменить:",
    attachments: [
      kb([
        ...session.players.map((p, i) => [btn(label(session, i), { a: "ed_pick", k: playerKey(p) })]),
        [btn("Закрыть", { a: "ed_close" })],
      ]),
    ],
  };
}

export function isRosterEditAction(action: ButtonAction): boolean {
  return action.a.startsWith("ed_");
}

/** Кнопка «✏️ Список игроков» в панели — новое сообщение-редактор в личке. */
export async function openEditor(dmChatId: number, group: number): Promise<void> {
  await api.sendMessageToChat(dmChatId, listView(getSession(group)));
}

/** Нажатия в редакторе. Возвращает текст всплывающего уведомления. */
export async function handleEditAction(
  dmChatId: number,
  userId: number,
  action: ButtonAction,
  messageId: string | undefined,
): Promise<string> {
  const group = await dmTarget(userId);
  if (!(await isChatAdmin(group, userId))) return "Только для администраторов чата";
  if (!messageId) return "Готово";
  const session = getSession(group);
  const index = "k" in action && session ? session.players.findIndex((p) => playerKey(p) === action.k) : -1;
  const show = (view: { text: string; attachments: InlineKeyboardAttachment[] }) => api.editMessage(dmChatId, messageId, view);

  switch (action.a) {
    case "ed_list":
      awaitingRename.delete(`${dmChatId}:${userId}`);
      await show(listView(session));
      return "Ок";
    case "ed_close":
      awaitingRename.delete(`${dmChatId}:${userId}`);
      await api.deleteMessage(dmChatId, messageId).catch(() => undefined);
      return "Закрыто";
    case "ed_pick":
      if (index === -1) {
        await show(listView(session));
        return "Этого игрока уже нет в списке";
      }
      await show({
        text: `✏️ ${label(session!, index)}`,
        attachments: [
          kb([
            [btn("❌ Удалить", { a: "ed_del", k: action.k }), btn("✏️ Переименовать", { a: "ed_ren", k: action.k })],
            [btn("↩️ Назад к списку", { a: "ed_list" })],
          ]),
        ],
      });
      return "Ок";
    case "ed_del": {
      if (index === -1) {
        await show(listView(session));
        return "Этого игрока уже нет в списке";
      }
      const name = await adminRemoveAt(session!, index);
      await show(listView(session));
      return `Удалён: ${name}`;
    }
    case "ed_ren":
      if (index === -1) {
        await show(listView(session));
        return "Этого игрока уже нет в списке";
      }
      awaitingRename.set(`${dmChatId}:${userId}`, { k: action.k, messageId, group });
      await show({
        text: `✏️ Напишите новое имя для «${session!.players[index].displayName}» следующим сообщением.`,
        attachments: [kb([[btn("Отмена", { a: "ed_list" })]])],
      });
      return "Жду новое имя";
    default:
      return "Готово";
  }
}

/** Текст в личке, пока админ переименовывает игрока. true — сообщение «съедено». */
export async function handleAwaitedRename(dmChatId: number, userId: number, text: string): Promise<boolean> {
  const state = awaitingRename.get(`${dmChatId}:${userId}`);
  if (!state || text.startsWith("/")) return false;
  awaitingRename.delete(`${dmChatId}:${userId}`);
  const session = getSession(state.group);
  const index = session ? session.players.findIndex((p) => playerKey(p) === state.k) : -1;
  if (index === -1) {
    await api.sendMessageToChat(dmChatId, { text: "Этого игрока уже нет в списке." });
    return true;
  }
  const old = session!.players[index].displayName;
  const error = await adminRenameAt(session!, index, text);
  await api.editMessage(dmChatId, state.messageId, listView(session)).catch(() => undefined);
  await api.sendMessageToChat(dmChatId, { text: error ?? `✅ ${old} → ${text.trim()}` });
  return true;
}
