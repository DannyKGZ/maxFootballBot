import { config } from "./config";
import * as api from "./maxApi";
import { adminConfirmKeyboard, adminKeyboard, userMenuKeyboard } from "./keyboard";
import { buildAdminHelp, buildUserWelcome } from "./helpInfo";
import * as actions from "./actions";
import { chatSwitchRow, chatTitle, dmTarget } from "./dmTarget";
import { openEditor } from "./rosterEdit";
import { draftCommand } from "./draftLogic";
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

// Чат, которым управляют из лички, — свой у каждого (см. dmTarget.ts).

async function statusText(group: number): Promise<string> {
  const session = getSession(group);
  const vote = getVoteSession(group);
  const signup = session ? `идёт, записано ${session.players.length}` : "нет";
  const voting = vote ? `идёт, голосов ${vote.votes.length}` : "нет";
  return `⚙️ Панель администратора — ${await chatTitle(group)}\nЗапись: ${signup}\nГолосование: ${voting}\n\nДействия выполняются в этом чате.`;
}

/** Показывает панель в личке; не-админу — отказ. */
export async function sendPanel(dmChatId: number, userId: number): Promise<void> {
  const group = await dmTarget(userId);
  if (!group) {
    await api.sendMessageToChat(dmChatId, { text: "CHAT_IDS (CHAT_ID) не задан в .env — не знаю, каким чатом управлять." });
    return;
  }
  const switchRow = await chatSwitchRow(userId);
  if (!(await sessionLogic.isChatAdmin(group, userId))) {
    // Участнику в личке — приветствие, его статус и кнопки меню (панель только для админов).
    const header = config.chatIds.length > 1 ? `Чат: ${await chatTitle(group)}\n\n` : "";
    await api.sendMessageToChat(dmChatId, { text: header + buildUserWelcome(group, userId), attachments: [userMenuKeyboard(switchRow)] });
    return;
  }
  await api.sendMessageToChat(dmChatId, { text: await statusText(group), attachments: [adminKeyboard(switchRow)] });
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
  const group = await dmTarget(userId);
  if (!group) return "CHAT_IDS (CHAT_ID) не задан в .env";
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

    case "adm_draft": {
      const reply = await draftCommand(group, userId);
      return reply || "Дележка открыта в общем чате — выберите капитанов там";
    }

    case "adm_edit":
      await openEditor(dmChatId, group);
      return "Редактор списка ниже";

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
