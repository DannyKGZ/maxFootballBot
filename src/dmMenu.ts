import { config } from "./config";
import * as actions from "./actions";
import * as api from "./maxApi";
import { dmRemoveKeyboard, userMenuKeyboard } from "./keyboard";
import { buildMvpRatingText } from "./messageFormatter";
import { joinSelf, ownEntries, removeOwnByName } from "./sessionLogic";
import { getMvpRating, getSeasonStart } from "./settingsStore";
import { buildStatusText } from "./statusInfo";
import { ButtonAction, MaxUser } from "./types";

/**
 * Кнопки участника в личном чате с ботом (у админа они над его панелью):
 * записаться/убрать себя, статус, рейтинг MVP, инструкция. Действуют на запись
 * общего чата CHAT_ID; ответы приходят сюда же, в личку.
 */

const DM_USER_ACTIONS = new Set(["join", "leave", "show_status", "show_mvp", "help", "dm_rm", "dm_rm_cancel"]);

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
      return (await removeOwnByName(group, user.user_id, action.n)) ? `Убрано из записи: ${action.n}` : "Этой записи уже нет";
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
    default:
      return "Готово";
  }
}
