import express, { Request, Response } from "express";
import { config } from "./config";
import * as api from "./maxApi";
import { decodePayload } from "./keyboard";
import * as sessionLogic from "./sessionLogic";
import * as actions from "./actions";
import * as adminPanel from "./adminPanel";
import { buildStatusText } from "./statusInfo";
import { NICK_RE, handleAwaitedNick, handleDmUserAction, isDmUserAction, nickCommand } from "./dmMenu";
import * as rosterEdit from "./rosterEdit";
import * as draft from "./draftLogic";
import { DESCRIPTION_RE, handleDescriptionAndReply } from "./descriptionLogic";
import * as scheduleLogic from "./scheduleLogic";
import * as voteLogic from "./voteLogic";
import { MaxUpdate } from "./types";
import { fullName } from "./messageFormatter";

// /голос — показать голосование за MVP (для всех).
const VOTE_RE = /^\/(голос|vote)$/i;

// /статус — актуальность записи (для всех, в чате и в личке с ботом).
const STATUS_RE = /^\/(статус|status)$/i;

// Текстовые команды панели. Админские проверяют права внутри (через API MAX);
// те же действия вызываются и кнопками под сообщением записи (см. actions.ts).
const COMMANDS: Array<{ re: RegExp; run: (chatId: number, userId: number) => Promise<actions.ActionResult> }> = [
  { re: /^\/(mvp|мвп)$/i, run: actions.mvp }, // для всех
  { re: STATUS_RE, run: actions.status }, // для всех
  { re: actions.HELP_RE, run: actions.sendHelp }, // для всех: инструкция в личку
  { re: /^\/(schedule|расписание|голосование_расписание)$/i, run: actions.schedule },
  { re: /^\/(start_signup|старт)$/i, run: actions.start },
  { re: /^\/(close_signup|закрыть)$/i, run: actions.close },
  { re: /^\/(vote_mvp|голосование)$/i, run: actions.voteStart },
  { re: /^\/(finish_vote|итоги)$/i, run: actions.voteFinish },
];

/**
 * Имя человека из профиля MAX — только first_name. Оно подставляется при записи
 * через голое "+" и попадает в список, лог голосов и рейтинг MVP.
 */
function senderDisplayName(user: { first_name: string }): string {
  return user.first_name.trim();
}

async function handleMessageCreated(update: MaxUpdate): Promise<void> {
  const message = update.message;
  if (!message) return;

  // Основной путь — message.recipient.chat_id, но на случай, если в реальном
  // апдейте chat_id лежит на верхнем уровне (как иногда бывает у message_callback),
  // подстраховываемся тем же фолбэком, что и в диагностическом логе ниже.
  const chatId = message.recipient?.chat_id ?? (update as { chat_id?: number }).chat_id;
  const userId = message.sender?.user_id;
  const text = (message.body?.text || "").trim();

  if (!chatId || !userId || !text) {
    console.log(
      `[webhook] handleMessageCreated: пропуск (chatId=${chatId}, userId=${userId}, text=${JSON.stringify(text)})`,
    );
    return;
  }

  // Подсказка при подключении к новому чату: его chat_id нигде в MAX не показывается.
  if (message.recipient?.chat_type !== "dialog" && chatId !== config.defaultChatId) {
    console.log(`[webhook] сообщение из чата chat_id=${chatId} (в .env CHAT_ID=${config.defaultChatId})`);
  }

  // 0) Личный чат с ботом — это панель администратора (кнопки, скрытые от участников).
  if (message.recipient?.chat_type === "dialog") {
    if (await handleAwaitedNick(chatId, userId, text)) return;
    if (await rosterEdit.handleAwaitedRename(chatId, userId, text)) return;
    if (await scheduleLogic.handleAwaitedTime(chatId, userId, text)) return;
    // /имя Новое имя — своё имя в списке.
    const nickDm = text.match(NICK_RE);
    if (nickDm) {
      await api.sendMessageToChat(chatId, { text: await nickCommand(userId, nickDm[2]) });
      return;
    }
    // Правка списка общего чата из лички: /удалить 3, /переименовать 3 Имя.
    const rmDm = text.match(rosterEdit.REMOVE_RE);
    if (rmDm) {
      await api.sendMessageToChat(chatId, { text: await rosterEdit.removeCommand(config.defaultChatId, userId, rmDm[2]) });
      return;
    }
    const swapDm = text.match(rosterEdit.SWAP_RE);
    if (swapDm) {
      await api.sendMessageToChat(chatId, { text: await rosterEdit.swapCommand(config.defaultChatId, userId, swapDm[2], swapDm[3]) });
      return;
    }
    const renDm = text.match(rosterEdit.RENAME_RE);
    if (renDm) {
      await api.sendMessageToChat(chatId, { text: await rosterEdit.renameCommand(config.defaultChatId, userId, renDm[2], renDm[3]) });
      return;
    }
    // /help в личке: админу — полная инструкция, участнику — его (как и на любой другой текст).
    if (actions.HELP_RE.test(text)) {
      await actions.sendHelp(config.defaultChatId, userId);
      return;
    }
    // /описание в личке — меняет запись общего чата (CHAT_ID), ответ сюда же.
    const descDm = text.match(DESCRIPTION_RE);
    if (descDm) {
      await handleDescriptionAndReply(config.defaultChatId, chatId, userId, descDm[2]);
      return;
    }
    // /статус в личке — статус записи общего чата (CHAT_ID), ответ сюда же.
    if (STATUS_RE.test(text)) {
      await api.sendMessageToChat(chatId, { text: buildStatusText(config.defaultChatId) });
      return;
    }
    const merge = text.match(actions.MERGE_RE);
    if (merge) {
      const result = await actions.mergeMvp(config.defaultChatId, userId, merge[2], merge[3]);
      if (result.chat) await api.sendMessageToChat(chatId, { text: result.chat });
      return;
    }
    // Сброс рейтинга MVP группы CHAT_ID — подтверждение приходит сюда же, в личку.
    const resetDm = actions.MVP_RESET_RE.find((r) => r.re.test(text));
    if (resetDm) {
      const result = await actions.requestMvpReset(config.defaultChatId, chatId, userId, resetDm.scope);
      if (result.chat) await api.sendMessageToChat(chatId, { text: result.chat });
      return;
    }
    // «/Всем …» в личке — упоминание всех участников группы CHAT_ID.
    const all = text.match(actions.MENTION_ALL_RE);
    if (all) {
      const result = await actions.mentionAll(config.defaultChatId, userId, all[1], { allowEmpty: text.startsWith("@") });
      await api.sendMessageToChat(chatId, { text: result.chat ?? "Отправлено в общий чат." });
      return;
    }
    await adminPanel.sendPanel(chatId, userId);
    return;
  }

  // 1) Если бот ждёт от этого пользователя имя нового игрока — это оно, вне очереди.
  const consumed = await sessionLogic.handleAwaitedPlayerName(chatId, userId, text, message.sender);
  if (consumed) return;

  // 1.1) Ручной ввод времени на шаге диалога настройки расписания.
  if (await scheduleLogic.handleAwaitedTime(chatId, userId, text)) return;

  // 1.15) /имя Новое имя — своё имя в списке (для всех).
  const nick = text.match(NICK_RE);
  if (nick) {
    await api.sendMessageToChat(chatId, { text: await nickCommand(userId, nick[2]) });
    return;
  }

  // 1.2) /голос — голосование внизу чата (для всех); если его нет — админ запускает.
  if (VOTE_RE.test(text)) {
    const reply = await voteLogic.voteCommand(chatId, userId);
    if (reply) await api.sendMessageToChat(chatId, { text: reply });
    return;
  }

  // 1.25) Дележка на команды (админ) и /составы (все).
  const dr = text.match(draft.DRAFT_RE);
  if (dr) {
    const reply = await draft.draftCommand(chatId, userId, dr[2]);
    if (reply) await api.sendMessageToChat(chatId, { text: reply });
    return;
  }
  if (draft.TEAMS_RE.test(text)) {
    await api.sendMessageToChat(chatId, { text: draft.teamsCommand(chatId) });
    return;
  }

  // 1.3) Правка списка админом: /удалить 3 (или имя), /переименовать 3 Новое имя.
  const rm = text.match(rosterEdit.REMOVE_RE);
  if (rm) {
    await api.sendMessageToChat(chatId, { text: await rosterEdit.removeCommand(chatId, userId, rm[2]) });
    return;
  }
  const swap = text.match(rosterEdit.SWAP_RE);
  if (swap) {
    await api.sendMessageToChat(chatId, { text: await rosterEdit.swapCommand(chatId, userId, swap[2], swap[3]) });
    return;
  }
  const ren = text.match(rosterEdit.RENAME_RE);
  if (ren) {
    await api.sendMessageToChat(chatId, { text: await rosterEdit.renameCommand(chatId, userId, ren[2], ren[3]) });
    return;
  }

  // 1.4) /описание — своя шапка записи и время игры (только админ).
  const desc = text.match(DESCRIPTION_RE);
  if (desc) {
    await handleDescriptionAndReply(chatId, chatId, userId, desc[2]);
    return;
  }

  // 1.5) Объединение игроков в рейтинге MVP: /объединить Рус = Ruslan (только админ).
  const merge = text.match(actions.MERGE_RE);
  if (merge) {
    const result = await actions.mergeMvp(chatId, userId, merge[2], merge[3]);
    if (result.chat) await api.sendMessageToChat(chatId, { text: result.chat });
    return;
  }

  // 1.55) Сброс рейтинга MVP (только админ, с подтверждением «Да/Нет»).
  const reset = actions.MVP_RESET_RE.find((r) => r.re.test(text));
  if (reset) {
    const result = await actions.requestMvpReset(chatId, chatId, userId, reset.scope);
    if (result.chat) await api.sendMessageToChat(chatId, { text: result.chat });
    return;
  }

  // 1.6) «/Всем текст» — упомянуть всех участников чата (только админ).
  const all = text.match(actions.MENTION_ALL_RE);
  if (all) {
    const result = await actions.mentionAll(chatId, userId, all[1], { allowEmpty: text.startsWith("@") });
    if (result.chat) await api.sendMessageToChat(chatId, { text: result.chat });
    return;
  }

  // 2) Команды панели: /mvp, /расписание, /старт, /закрыть, /голосование, /итоги.
  for (const command of COMMANDS) {
    if (!command.re.test(text)) continue;
    const result = await command.run(chatId, userId);
    if (result.chat) await api.sendMessageToChat(chatId, { text: result.chat });
    return;
  }

  // 3) Иначе обычные команды +Имя / -Имя.
  // "+" — записать себя по профилю; "+Сергей +Владимир" — записать нескольких сразу.
  if (text.startsWith("+")) {
    const names = text.split("+").map((s) => s.trim()).filter(Boolean);
    await sessionLogic.handlePlusCommand(chatId, userId, names, message.sender);
    return;
  }

  // "-" — убрать себя; "-Рома" — убрать свою запись с этим именем (с подтверждением).
  if (text.startsWith("-")) {
    await sessionLogic.handleMinusCommand(chatId, userId, text.slice(1).trim() || undefined);
    return;
  }

  // Незнакомая команда — не молчим, а подсказываем похожую и /help.
  const unknown = unknownCommandReply(text);
  if (unknown) await api.sendMessageToChat(chatId, { text: unknown });
}

// Все команды бота — для подсказки, если команду написали с ошибкой.
const KNOWN_COMMANDS = [
  "статус", "голос", "имя", "mvp", "мвп", "help", "инструкция", "помощь", "составы",
  "старт", "закрыть", "описание", "расписание", "голосование", "итоги", "объединить",
  "удалить", "переименовать", "заменить", "поменять", "дележка", "всем", "мвпСезонныйСброс", "мвпОбщийСброс",
];

/** «/статс» → «Не знаю команду /статс. Возможно, вы имели в виду /статус. Все команды — /help». */
export function unknownCommandReply(text: string): string | null {
  const m = text.match(/^\/([a-zа-яё_]+)/i);
  if (!m) return null;
  const word = m[1].toLowerCase();
  // Расстояние Левенштейна — сколько букв поправить, чтобы получилась известная команда.
  const dist = (a: string, b: string) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  };
  const best = KNOWN_COMMANDS.map((c) => ({ c, d: dist(word, c.toLowerCase()) })).sort((x, y) => x.d - y.d)[0];
  if (best && best.d === 0) return `Команда /${best.c} написана в неверном формате. Как пользоваться — /help.`;
  const hint = best && best.d <= Math.max(1, Math.floor(word.length / 3)) ? ` Возможно, вы имели в виду /${best.c}.` : "";
  return `Не знаю команду /${m[1]}.${hint} Все команды — /help.`;
}

async function handleMessageCallback(update: MaxUpdate): Promise<void> {
  const callback = update.callback;
  const message = update.message;
  if (!callback) return;

  const chatId = message?.recipient?.chat_id ?? (update as { chat_id?: number }).chat_id ?? 0;
  const pressedByUserId = callback.user.user_id;
  const action = decodePayload(callback.payload);

  console.log(
    `[webhook] handleMessageCallback: chatId=${chatId}, pressedByUserId=${pressedByUserId}, payload=${callback.payload}`,
  );

  if (!action) {
    await api.answerCallback(chatId, callback.callback_id, { notification: "Готово" });
    return;
  }

  // Кнопки в личном чате с ботом — панель администратора (и её диалог расписания).
  // Редактор списка в личке админа.
  if (message?.recipient?.chat_type === "dialog" && rosterEdit.isRosterEditAction(action)) {
    const notification = await rosterEdit.handleEditAction(chatId, pressedByUserId, action, message.body?.mid);
    await api.answerCallback(chatId, callback.callback_id, { notification });
    return;
  }

  // Кнопки участника в личке (записаться, статус, рейтинг…) — доступны всем.
  if (message?.recipient?.chat_type === "dialog" && isDmUserAction(action)) {
    const notification = await handleDmUserAction(chatId, callback.user, action, message.body?.mid);
    await api.answerCallback(chatId, callback.callback_id, { notification });
    return;
  }

  if (message?.recipient?.chat_type === "dialog" && !scheduleLogic.isScheduleAction(action)) {
    const notification = await adminPanel.handlePanelAction(
      chatId,
      pressedByUserId,
      action,
      message.body?.mid,
    );
    await api.answerCallback(chatId, callback.callback_id, { notification });
    return;
  }

  // Кнопки дележки в общем чате: капитанов назначает админ, игроков выбирает капитан.
  if (draft.isDraftAction(action) && action.a !== "adm_draft") {
    const notification = await draft.handleDraftAction(chatId, pressedByUserId, action);
    await api.answerCallback(chatId, callback.callback_id, { notification });
    return;
  }

  // Кнопки без адресата (панель под записью, голосование) видны всем в чате:
  // право и лимиты проверяются на сервере, ответ — личное уведомление нажавшему.
  if (!("u" in action)) {
    let toast: string | undefined;
    switch (action.a) {
      case "join":
        await sessionLogic.handlePlusCommand(chatId, pressedByUserId, [], callback.user);
        break;
      case "leave":
        await sessionLogic.handleMinusCommand(chatId, pressedByUserId);
        break;
      case "help":
        toast = (await actions.sendHelp(chatId, pressedByUserId)).toast;
        break;
      case "show_mvp":
        toast = (await actions.mvp(chatId, pressedByUserId)).toast;
        break;
      case "admin_restart":
        toast = (await actions.start(chatId, pressedByUserId)).toast;
        break;
      case "adm_close":
        toast = (await actions.close(chatId, pressedByUserId)).toast;
        break;
      case "adm_vote":
        toast = (await actions.voteStart(chatId, pressedByUserId)).toast;
        break;
      case "adm_finish":
        toast = (await actions.voteFinish(chatId, pressedByUserId)).toast;
        break;
      case "adm_schedule":
        toast = (await actions.schedule(chatId, pressedByUserId)).toast;
        break;
      case "mvp_results": // кнопка из старых сообщений голосования — итоги теперь на кнопках
        toast = "Счёт — прямо на кнопках, кто за кого — в сообщении голосования";
        break;
      case "mvp_vote": {
        const outcome = await voteLogic.castVote(
          chatId,
          pressedByUserId,
          senderDisplayName(callback.user),
          action.c,
          fullName(callback.user),
        );
        toast =
          outcome === "self_vote"
            ? "За себя голосовать нельзя — выберите другого игрока"
            : outcome === "not_eligible"
            ? "Голосовать может только тот, кто был записан на игру"
            : outcome === "no_credits_left"
              ? "У вас закончились голоса"
              : outcome === "no_vote"
                ? "Голосование уже завершено"
                : outcome === "invalid_candidate"
                  ? "Такого кандидата больше нет"
                  : "Голос принят";
        break;
      }
    }
    await api.answerCallback(chatId, callback.callback_id, { notification: toast ?? "Готово" });
    return;
  }

  // Остальные кнопки адресованы конкретному пользователю (тот, кто инициировал диалог).
  // Любой другой участник чата, нажавший её, получает только личное уведомление.
  const targetUserId = action.u;
  if (pressedByUserId !== targetUserId) {
    await api.answerCallback(chatId, callback.callback_id, {
      notification: "Вы не участвуете в этой записи",
    });
    return;
  }

  // Диалог расписания многошаговый: его сообщение живёт до конца диалога,
  // поэтому обрабатываем отдельно и не удаляем сообщение после нажатия.
  if (scheduleLogic.isScheduleAction(action)) {
    const notification = await scheduleLogic.handleScheduleCallback(
      chatId,
      pressedByUserId,
      action,
    );
    await api.answerCallback(chatId, callback.callback_id, { notification });
    return;
  }

  switch (action.a) {
    case "add_another_yes":
      await sessionLogic.handleAddAnotherYes(chatId, pressedByUserId);
      break;
    case "add_another_no":
      await sessionLogic.handleAddAnotherNo(chatId, pressedByUserId);
      break;
    case "remove_yes":
      await sessionLogic.handleRemoveYes(chatId, pressedByUserId);
      break;
    case "remove_no":
      await sessionLogic.handleRemoveNo(chatId, pressedByUserId);
      break;
    case "rm_pick":
      await sessionLogic.handleRemovePick(chatId, pressedByUserId, action.n);
      break;
    case "restart_yes":
      await sessionLogic.handleRestartYes(chatId, pressedByUserId);
      break;
    case "restart_no":
      await sessionLogic.handleRestartNo(chatId, pressedByUserId);
      break;
    case "close_yes":
      await sessionLogic.handleCloseYes(chatId, pressedByUserId);
      break;
    case "close_no":
      await sessionLogic.handleCloseNo(chatId, pressedByUserId);
      break;
    case "mvp_reset":
      await actions.confirmMvpReset(chatId, pressedByUserId, action.s);
      break;
    case "mvp_reset_no":
      break;
  }

  // Обязательный ответ на callback (иначе MAX считает нажатие необработанным).
  await api.answerCallback(chatId, callback.callback_id, { notification: "Готово" });

  // Сообщение-вопрос с кнопками Да/Нет своё дело сделало — убираем его из чата,
  // чтобы по нему нельзя было случайно нажать повторно (например, второй раз "Да").
  const dialogMessageId = message?.body?.mid;
  if (dialogMessageId) {
    try {
      await api.deleteMessage(chatId, dialogMessageId);
    } catch (err) {
      console.error(`[webhook] не удалось удалить диалоговое сообщение ${dialogMessageId}:`, err);
    }
  }
}

/**
 * Обработка одного апдейта MAX — общая для вебхука (POST /webhook) и long
 * polling (poller.ts). Ошибки логируются и не прерывают приём следующих апдейтов.
 */
export async function handleUpdate(update: MaxUpdate): Promise<void> {
  // Подсказка для первичной настройки: chat_id чата, куда добавили бота,
  // нигде в личном кабинете не показывается — смотрите его в логе.
  if (update.update_type === "bot_added") {
    const chatId = (update as { chat_id?: number }).chat_id;
    if (chatId) console.log(`[bot] бота добавили в чат, chat_id=${chatId} — впишите его в CHAT_ID`);
  }

  try {
    if (update.update_type === "bot_started") {
      // Пользователь открыл личный чат с ботом и нажал «Начать» — приветствие/панель.
      const started = update as { chat_id?: number; user?: { user_id: number } };
      if (started.chat_id && started.user) await adminPanel.sendPanel(started.chat_id, started.user.user_id);
    } else if (update.update_type === "message_created") {
      await handleMessageCreated(update);
    } else if (update.update_type === "message_callback") {
      await handleMessageCallback(update);
    }
  } catch (err) {
    console.error(`[bot] ошибка обработки update_type=${update?.update_type}:`, err);
  }
}

export function createWebhookApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.post("/webhook", async (req: Request, res: Response) => {
    // Проверка секрета вебхука, если он настроен.
    if (config.webhookSecret) {
      const provided = req.header("X-Max-Bot-Api-Secret");
      if (provided !== config.webhookSecret) {
        res.status(401).json({ success: false, message: "invalid secret" });
        return;
      }
    }

    // Отвечаем 200 сразу же (MAX требует ответ в течение 30 секунд и ретраит иначе),
    // а сам апдейт обрабатываем асинхронно.
    res.status(200).json({ success: true });

    await handleUpdate(req.body as MaxUpdate);
  });

  app.get("/health", (_req, res) => res.json({ ok: true }));

  return app;
}
