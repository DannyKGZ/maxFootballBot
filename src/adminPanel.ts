import { config } from "./config";
import * as api from "./maxApi";
import { adminConfirmKeyboard, adminKeyboard, userMenuKeyboard } from "./keyboard";
import { buildAdminHelp, buildUserWelcome } from "./helpInfo";
import * as actions from "./actions";
import * as scheduleLogic from "./scheduleLogic";
import * as sessionLogic from "./sessionLogic";
import { getSession, getVoteSession } from "./store";
import { ButtonAction } from "./types";
import * as voteLogic from "./voteLogic";
import { getMvpRating } from "./settingsStore";

/**
 * Панель администратора в личном чате с ботом. В групповом чате MAX
 * инлайн-кнопки видят все, поэтому админские кнопки показываются только тут:
 * админ пишет боту в личку, получает панель, а действия выполняются в группе
 * (CHAT_ID из .env). Права проверяются у MAX при каждом нажатии.
 */

const groupChatId = () => config.defaultChatId;

function statusText(): string {
  const session = getSession(groupChatId());
  const vote = getVoteSession(groupChatId());
  const signup = session ? `идёт, записано ${session.players.length}` : "нет";
  const voting = vote ? `идёт, голосов ${vote.votes.length}` : "нет";
  return `⚙️ Панель администратора\nЗапись: ${signup}\nГолосование: ${voting}\n\nДействия выполняются в общем чате.`;
}

/** Показывает панель в личке; не-админу — отказ. */
export async function sendPanel(dmChatId: number, userId: number): Promise<void> {
  if (!groupChatId()) {
    await api.sendMessageToChat(dmChatId, { text: "CHAT_ID не задан в .env — не знаю, каким чатом управлять." });
    return;
  }
  if (!(await sessionLogic.isChatAdmin(groupChatId(), userId))) {
    // Участнику в личке — приветствие, его статус и кнопки меню (панель только для админов).
    await api.sendMessageToChat(dmChatId, { text: buildUserWelcome(groupChatId(), userId), attachments: [userMenuKeyboard()] });
    return;
  }
  await api.sendMessageToChat(dmChatId, { text: statusText(), attachments: [adminKeyboard()] });
}

/** Опасное действие при непустой записи — спрашиваем в личке, а не в группе. */
async function askConfirm(dmChatId: number, userId: number, op: "restart" | "close", players: number) {
  const text =
    op === "restart"
      ? `В записи ${players} чел. Начать новую? Старая запись закроется.`
      : `В записи ${players} чел. Закрыть её без открытия новой?`;
  await api.sendMessageToChat(dmChatId, { text, attachments: [adminConfirmKeyboard(userId, op)] });
}

/**
 * Нажатие кнопки в личке админа. Возвращает текст всплывающего уведомления.
 * `dialogMessageId` — сообщение с кнопками (удаляем после подтверждения/отмены).
 */
export async function handlePanelAction(
  dmChatId: number,
  userId: number,
  action: ButtonAction,
  dialogMessageId?: string,
): Promise<string> {
  const group = groupChatId();
  if (!group) return "CHAT_ID не задан в .env";
  if (!(await sessionLogic.isChatAdmin(group, userId))) return "Только для администраторов чата";

  const players = getSession(group)?.players.length ?? 0;
  const dropDialog = async () => {
    if (!dialogMessageId) return;
    try {
      await api.deleteMessage(dmChatId, dialogMessageId);
    } catch (err) {
      console.error("[adminPanel] не удалось удалить сообщение подтверждения:", err);
    }
  };

  switch (action.a) {
    case "admin_restart":
      if (players > 0) {
        await askConfirm(dmChatId, userId, "restart", players);
        return "Подтвердите ниже";
      }
      await sessionLogic.handleRestartYes(group, userId);
      return "Новая запись опубликована";

    case "adm_close":
      if (!getSession(group)) return "Сейчас нет активной записи";
      if (players > 0) {
        await askConfirm(dmChatId, userId, "close", players);
        return "Подтвердите ниже";
      }
      await sessionLogic.handleCloseYes(group, userId);
      return "Запись закрыта";

    case "dm_ok":
      await dropDialog();
      if (action.op === "restart") {
        await sessionLogic.handleRestartYes(group, userId);
        return "Новая запись опубликована";
      }
      await sessionLogic.handleCloseYes(group, userId);
      return "Запись закрыта";

    case "dm_cancel":
      await dropDialog();
      return "Отменено";

    case "adm_vote": {
      const outcome = await voteLogic.startVote(group, userId);
      if (outcome === "no_session") return "Нет записи с игроками для голосования";
      if (outcome === "already_active") return "Голосование уже идёт";
      return "Голосование опубликовано в чате";
    }

    case "adm_finish": {
      const outcome = await voteLogic.finishVote(group, userId);
      if (outcome === "no_vote") return "Сейчас нет активного голосования";
      return "Итоги опубликованы, MVP засчитан";
    }

    case "help":
      await api.sendMessageToChat(dmChatId, { text: buildAdminHelp(group, userId) });
      return "Инструкция ниже";

    case "adm_mvp_reset":
      return (await actions.requestMvpReset(group, dmChatId, userId, action.s)).toast ?? "Готово";

    case "mvp_reset":
      await dropDialog();
      return (await actions.confirmMvpReset(group, userId, action.s)).toast ?? "Готово";

    case "mvp_reset_no":
      await dropDialog();
      return "Отменено";

    case "adm_merge": {
      const names = getMvpRating(group).map((e) => `${e.name} — ${e.count} (сезон: ${e.season})`);
      await api.sendMessageToChat(dmChatId, {
        text: [
          "Если один игрок попал в рейтинг под разными именами, объедините их.",
          "Напишите сюда: /объединить Рус = Ruslan",
          "(имя слева исчезнет, его MVP прибавятся к имени справа; будущие победы «Рус» тоже пойдут к «Ruslan»)",
          "",
          names.length ? "Сейчас в рейтинге:\n" + names.join("\n") : "Рейтинг пока пуст.",
        ].join("\n"),
      });
      return "Подсказка ниже";
    }

    case "adm_schedule":
      await scheduleLogic.startScheduleDialog(dmChatId, userId, group);
      return "Выберите дни ниже";

    default:
      return "Эта кнопка работает в общем чате";
  }
}
