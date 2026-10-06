import { config } from "./config";
import * as actions from "./actions";
import * as api from "./maxApi";
import { dmRemoveKeyboard, userMenuKeyboard } from "./keyboard";
import { buildMvpRatingText } from "./messageFormatter";
import { joinSelf, ownEntries, removeOwnByName, setOwnNickname } from "./sessionLogic";
import { getMvpRating, getNickname, getSeasonStart } from "./settingsStore";
import { buildStatusText } from "./statusInfo";
import { ButtonAction, MaxUser } from "./types";

/**
 * Кнопки участника в личном чате с ботом (у админа они над его панелью):
 * записаться/убрать себя, статус, рейтинг MVP, инструкция. Действуют на запись
 * общего чата CHAT_ID; ответы приходят сюда же, в личку.
 */

const DM_USER_ACTIONS = new Set(["join", "leave", "show_status", "show_mvp", "help", "dm_rm", "dm_rm_cancel", "nick"]);

/** «/имя Руслан Большой» (в чате или в личке) — своё имя в списке. */
export const NICK_RE = /^\/(имя|name)(?:\s+([\s\S]+))?$/i;

// Кто после «✏️ Изменить имя» должен прислать новое имя: `${dmChatId}:${userId}`.
const awaitingNick = new Set<string>();

/** Ответ на /имя или на присланное после кнопки имя. */
async function applyNick(userId: number, name: string): Promise<string> {
  const error = await setOwnNickname(config.defaultChatId, userId, name);
  return error ?? `✅ Готово! Теперь в списке вы — «${name.trim()}». Так бот будет записывать вас и дальше.`;
}

/** /имя Новое имя — из общего чата или лички. */
export async function nickCommand(userId: number, arg?: string): Promise<string> {
  if (!arg?.trim()) {
    const current = getNickname(userId);
    return `${current ? `Сейчас в списке вы — «${current}».` : "Своё имя ещё не задано — в списке ваше имя из профиля MAX."}\nЧтобы изменить: /имя Новое имя (например, /имя Руслан Большой).`;
  }
  return applyNick(userId, arg);
}

/** Текст в личке после «✏️ Изменить имя». true — это было новое имя. */
export async function handleAwaitedNick(dmChatId: number, userId: number, text: string): Promise<boolean> {
  const key = `${dmChatId}:${userId}`;
  if (!awaitingNick.has(key) || text.startsWith("/")) return false;
  awaitingNick.delete(key);
  await api.sendMessageToChat(dmChatId, { text: await applyNick(userId, text), attachments: [userMenuKeyboard()] });
  return true;
}

export function isDmUserAction(action: ButtonAction): boolean {
  return DM_USER_ACTIONS.has(action.a);
}

/** Возвращает текст всплывающего уведомления. */
export async function handleDmUserAction(
  dmChatId: number,
  user: MaxUser,
  action: ButtonAction,
  dialogMessageId?: string,
): Promise<string> {
  const group = config.defaultChatId;
  if (!group) return "CHAT_ID не задан в .env";
  const dropDialog = () => (dialogMessageId ? api.deleteMessage(dmChatId, dialogMessageId).catch(() => undefined) : undefined);

  switch (action.a) {
    case "join": {
      const outcome = await joinSelf(group, user);
      if (outcome === "no_session") return "Сейчас записи нет — она откроется по расписанию";
      if (outcome === "closed") return "🔒 Запись закрыта — игра уже началась";
      if (outcome === "already") return "Вы уже записаны";
      return "✅ Вы записаны";
    }
    case "leave": {
      const names = ownEntries(group, user.user_id);
      if (names.length === 0) return "Вас нет в записи";
      await api.sendMessageToChat(dmChatId, {
        text: names.length === 1 ? `Убрать из записи: ${names[0]}?` : "Кого убрать из записи?",
        attachments: [dmRemoveKeyboard(user.user_id, names)],
      });
      return "Выберите ниже";
    }
    case "dm_rm": {
      await dropDialog();
      return (await removeOwnByName(group, user.user_id, action.n))
        ? `Убрано из записи: ${action.n}`
        : "Не удалось: записи уже нет или игра началась (тогда менять состав может только админ)";
    }
    case "dm_rm_cancel":
      await dropDialog();
      return "Отменено";
    case "show_status":
      await api.sendMessageToChat(dmChatId, { text: buildStatusText(group), attachments: [userMenuKeyboard()] });
      return "Статус ниже";
    case "show_mvp":
      await api.sendMessageToChat(dmChatId, {
        text: buildMvpRatingText(getMvpRating(group), getSeasonStart(group)),
        attachments: [userMenuKeyboard()],
      });
      return "Рейтинг ниже";
    case "help":
      return (await actions.sendHelp(group, user.user_id)).toast ?? "Готово";
    case "nick": {
      awaitingNick.add(`${dmChatId}:${user.user_id}`);
      const current = getNickname(user.user_id) ?? user.first_name;
      await api.sendMessageToChat(dmChatId, {
        text: `✏️ Сейчас в списке вы — «${current}».\nНапишите сообщением, как вас показывать (например, «Руслан Большой»). Можно менять сколько угодно раз.`,
      });
      return "Напишите новое имя";
    }
    default:
      return "Готово";
  }
}
