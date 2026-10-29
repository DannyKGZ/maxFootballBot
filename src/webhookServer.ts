import express, { Request, Response } from "express";
import { config, isManagedChat } from "./config";
import * as api from "./maxApi";
import { decodePayload } from "./keyboard";
import * as sessionLogic from "./sessionLogic";
import * as actions from "./actions";
import * as adminPanel from "./adminPanel";
import { buildStatusText } from "./statusInfo";
import { NICK_RE, handleAwaitedNick, handleDmUserAction, isDmUserAction, nickCommand } from "./dmMenu";
import * as rosterEdit from "./rosterEdit";
import { DM_DENIED, dmAllowed, dmTarget } from "./dmTarget";
import { RECEIPTS_RE, SETTINGS_RE, handleSettingsAction, isSettingsAction, receiptsCommand, settingsCommand } from "./chatSettings";
import * as draft from "./draftLogic";
import { DESCRIPTION_RE, handleDescription } from "./descriptionLogic";
import { GAMES_RE, gamesCommand } from "./gameSlotsLogic";
import {
  DEBTORS_RE,
  LIMIT_RE,
  PAID_RE,
  PAYMENT_RE,
  REMINDERS_RE,
  debtorsCommand,
  sendDebtorsWithReceipts,
  limitCommand,
  paidCommand,
  paymentCommand,
  remindersCommand,
} from "./paymentLogic";
import * as receipts from "./receiptLogic";
import { receiptsEnabled } from "./paymentLedger";
import * as scheduleLogic from "./scheduleLogic";
import * as voteLogic from "./voteLogic";
import { MaxUpdate, MaxUser } from "./types";
import { noteChatActivity } from "./stickyLogic";
import * as roles from "./rolesLogic";
import { fullName } from "./messageFormatter";

// /голос — показать голосование за MVP (для всех).
const VOTE_RE = /^\/(голос|vote)$/i;

// /статус — актуальность записи (для всех, в чате и в личке с ботом).
const STATUS_RE = /^\/(статус|status)$/i;

/**
 * Текстовая команда. `group` — чат, на который она действует; `reply` — куда
 * отвечать (в группе — та же группа, в личке — личка, а `group` — чат,
 * выбранный человеком, см. dmTarget.ts). run → текст ответа (пусто — без ответа).
 * Админские команды проверяют права сами (у MAX).
 */
interface Ctx {
  group: number;
  reply: number;
  user: MaxUser;
  userId: number;
  dm: boolean;
  text: string;
}
interface TextCommand {
  re: RegExp;
  where?: "group" | "dm"; // по умолчанию — и в чате, и в личке
  run: (ctx: Ctx, m: RegExpMatchArray) => Promise<string | null | undefined | void>;
}

const chatOf = (r: actions.ActionResult) => r.chat;

const TEXT_COMMANDS: TextCommand[] = [
  { re: NICK_RE, run: (c, m) => nickCommand(c.userId, m[2]) },
  { re: VOTE_RE, where: "group", run: (c) => voteLogic.voteCommand(c.group, c.userId) },
  { re: draft.DRAFT_RE, where: "group", run: (c, m) => draft.draftCommand(c.group, c.userId, m[2]) },
  { re: draft.TEAMS_RE, where: "group", run: async (c) => draft.teamsCommand(c.group) },
  // В чате об удалении и так пишет сам список («➖ … убран админом») — ответ только в личке или при ошибке.
  {
    re: rosterEdit.REMOVE_RE,
    run: async (c, m) => {
      const r = await rosterEdit.removeCommand(c.group, c.userId, m[2]);
      return c.dm || !r.startsWith("✅") ? r : null;
    },
  },
  { re: rosterEdit.SWAP_RE, run: (c, m) => rosterEdit.swapCommand(c.group, c.userId, m[2], m[3]) },
  { re: rosterEdit.RENAME_RE, run: (c, m) => rosterEdit.renameCommand(c.group, c.userId, m[2], m[3]) },
  { re: DESCRIPTION_RE, run: (c, m) => handleDescription(c.group, c.userId, m[2]) },
  { re: GAMES_RE, run: (c, m) => gamesCommand(c.group, c.userId, m[2]) },
  { re: roles.LEGEND_RE, run: (c, m) => roles.roleCommand(c.group, c.reply, c.user, "legend", m[2]) },
  { re: roles.MANISKA_RE, run: (c, m) => roles.roleCommand(c.group, c.reply, c.user, "maniska", m[2]) },
  { re: DEBTORS_RE, where: "group", run: (c, m) => debtorsCommand(c.group, c.userId, m[2]) },
  { re: DEBTORS_RE, where: "dm", run: (c, m) => sendDebtorsWithReceipts(c.group, c.reply, c.userId, m[2]) },
  { re: PAID_RE, run: (c, m) => paidCommand(c.group, c.userId, m[2]) },
  { re: REMINDERS_RE, run: (c, m) => remindersCommand(c.group, c.userId, m[2]) },
  { re: LIMIT_RE, run: (c, m) => limitCommand(c.group, c.userId, m[2]) },
  { re: PAYMENT_RE, run: (c, m) => paymentCommand(c.group, c.userId, m[2]) },
  { re: SETTINGS_RE, run: (c) => settingsCommand(c.group, c.reply, c.userId) },
  { re: RECEIPTS_RE, run: (c, m) => receiptsCommand(c.group, c.userId, m[2]) },
  { re: actions.MERGE_RE, run: async (c, m) => chatOf(await actions.mergeMvp(c.group, c.userId, m[2], m[3])) },
  ...actions.MVP_RESET_RE.map(({ re, scope }): TextCommand => ({
    re,
    run: async (c) => chatOf(await actions.requestMvpReset(c.group, c.reply, c.userId, scope)),
  })),
  {
    re: actions.MENTION_ALL_RE,
    run: async (c, m) => {
      const r = await actions.mentionAll(c.group, c.userId, m[1], { allowEmpty: c.text.startsWith("@") });
      return r.chat ?? (c.dm ? "Отправлено в чат." : null);
    },
  },
  // /help: в личке инструкция приходит сама; в чате — подсказка, если личка закрыта.
  { re: actions.HELP_RE, run: async (c) => (c.dm ? void (await actions.sendHelp(c.group, c.userId)) : chatOf(await actions.sendHelp(c.group, c.userId))) },
  { re: STATUS_RE, where: "dm", run: async (c) => buildStatusText(c.group) },
  // Команды панели (в личке вместо них — панель с кнопками).
  { re: STATUS_RE, where: "group", run: async (c) => chatOf(await actions.status(c.group, c.userId)) },
  { re: /^\/(mvp|мвп)$/i, where: "group", run: async (c) => chatOf(await actions.mvp(c.group, c.userId)) },
  { re: /^\/(schedule|расписание|голосование_расписание)$/i, where: "group", run: async (c) => chatOf(await actions.schedule(c.group, c.userId)) },
  { re: /^\/(start_signup|старт)$/i, where: "group", run: async (c) => chatOf(await actions.start(c.group, c.userId)) },
  { re: /^\/(close_signup|закрыть)$/i, where: "group", run: async (c) => chatOf(await actions.close(c.group, c.userId)) },
  { re: /^\/(vote_mvp|голосование)$/i, where: "group", run: async (c) => chatOf(await actions.voteStart(c.group, c.userId)) },
  { re: /^\/(finish_vote|итоги)$/i, where: "group", run: async (c) => chatOf(await actions.voteFinish(c.group, c.userId)) },
];

/** Найти и выполнить текстовую команду; true — команда нашлась. */
async function runTextCommand(ctx: Ctx): Promise<boolean> {
  const scope = ctx.dm ? "dm" : "group";
  for (const cmd of TEXT_COMMANDS) {
    if (cmd.where && cmd.where !== scope) continue;
    const m = ctx.text.match(cmd.re);
    if (!m) continue;
    const answer = await cmd.run(ctx, m);
    if (answer) await api.sendMessageToChat(ctx.reply, { text: answer });
    return true;
  }
  return false;
}

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

  // Основной путь — message.recipient.chat_id; на случай, если chat_id лежит на верхнем уровне апдейта, — фолбэк.
  const chatId = message.recipient?.chat_id ?? (update as { chat_id?: number }).chat_id;
  const userId = message.sender?.user_id;
  const text = (message.body?.text || "").trim();
  const dm = message.recipient?.chat_type === "dialog";

  // Личка — только для участников чатов бота (dmTarget.ts).
  if (dm && chatId && userId && !(await dmAllowed(userId, message.sender?.name ?? message.sender?.first_name))) {
    await api.sendMessageToChat(chatId, { text: DM_DENIED });
    return;
  }

  // Новое сообщение в группе (и фото/стикер без текста) — дележку/голосование опустим вниз (stickyLogic.ts).
  if (chatId && !dm) noteChatActivity(chatId);

  // Чек об оплате: файл/фото боту в личку или в чат с проверкой чеков (receiptLogic.ts). Стикеры не считаем.
  const files = (message.body?.attachments ?? []).filter((a) => ["file", "image"].includes((a as { type?: string }).type ?? ""));
  if (chatId && userId && files.length && (dm || (isManagedChat(chatId) && receiptsEnabled(chatId)))) {
    if (await receipts.handleReceipt(chatId, message.sender, files, !dm, text)) return;
  }

  if (!chatId || !userId || !text) return;

  // Группа, которую бот не ведёт: не отвечаем, но пишем её chat_id в лог —
  // так его узнают, чтобы добавить чат в CHAT_IDS (в MAX он нигде не виден).
  if (!dm && !isManagedChat(chatId)) {
    console.log(`[webhook] сообщение из чата chat_id=${chatId} — его нет в CHAT_IDS (${config.chatIds.join(",")}), не отвечаю`);
    return;
  }

  if (dm) {
    // Ответы на вопросы бота (новое имя, имя в редакторе, время расписания).
    if (await handleAwaitedNick(chatId, userId, text)) return;
    if (await rosterEdit.handleAwaitedRename(chatId, userId, text)) return;
    if (await scheduleLogic.handleAwaitedTime(chatId, userId, text)) return;
    // Команды из лички действуют на чат, выбранный человеком (см. dmTarget.ts); иначе — панель.
    const ctx: Ctx = { group: await dmTarget(userId), reply: chatId, user: message.sender, userId, dm, text };
    if (!(await runTextCommand(ctx))) await adminPanel.sendPanel(chatId, userId);
    return;
  }

  // Ручной ввод времени на шаге диалога расписания.
  if (await scheduleLogic.handleAwaitedTime(chatId, userId, text)) return;
  if (await runTextCommand({ group: chatId, reply: chatId, user: message.sender, userId, dm, text })) return;

  // «+» — записать себя по профилю; «+Сергей +Владимир» — записать нескольких сразу.
  if (text.startsWith("+")) {
    const names = text.split("+").map((s) => s.trim()).filter(Boolean);
    await sessionLogic.handlePlusCommand(chatId, userId, names, message.sender);
    return;
  }

  // «-» — убрать себя; «-Рома» — убрать свою запись с этим именем (с подтверждением).
  if (text.startsWith("-")) {
    await sessionLogic.handleMinusCommand(chatId, userId, text.slice(1).trim() || undefined);
    return;
  }

  // Незнакомая команда — подсказываем похожую и /help.
  const unknown = unknownCommandReply(text);
  if (unknown) await api.sendMessageToChat(chatId, { text: unknown });
}

// Все команды бота — для подсказки, если команду написали с ошибкой.
const KNOWN_COMMANDS = [
  "статус", "голос", "имя", "mvp", "мвп", "help", "инструкция", "помощь", "составы",
  "старт", "закрыть", "описание", "расписание", "игры", "оплата", "лимит", "напоминания", "должники", "оплатил", "легенда", "манишканосец", "манишки", "голосование", "итоги", "объединить",
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

  if (message?.recipient?.chat_type !== "dialog" && !isManagedChat(chatId)) {
    await api.answerCallback(chatId, callback.callback_id, { notification: "Этот чат бот больше не ведёт" });
    return;
  }

  if (message?.recipient?.chat_type === "dialog" && !(await dmAllowed(pressedByUserId, callback.user.name ?? callback.user.first_name))) {
    await api.answerCallback(chatId, callback.callback_id, { notification: DM_DENIED });
    return;
  }

  if (!action) {
    await api.answerCallback(chatId, callback.callback_id, { notification: "Готово" });
    return;
  }

  // ⚙️ Настройки: в личке — выбранного чата, в чате — этого чата.
  if (isSettingsAction(action)) {
    const group = message?.recipient?.chat_type === "dialog" ? await dmTarget(pressedByUserId) : chatId;
    const notification = await handleSettingsAction(group, chatId, pressedByUserId, action, message?.body?.mid);
    await api.answerCallback(chatId, callback.callback_id, { notification });
    return;
  }

  // Легенда и манишкаНосец: выбор игрока (админ) и «👕 Я забрал манишки» — в чате и в личке.
  if (roles.isRoleAction(action)) {
    const group = message?.recipient?.chat_type === "dialog" ? await dmTarget(pressedByUserId) : chatId;
    const notification = await roles.handleRoleAction(group, chatId, message?.body?.mid, callback.user, action);
    await api.answerCallback(chatId, callback.callback_id, { notification });
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
        if ((await sessionLogic.handlePlusCommand(chatId, pressedByUserId, [], callback.user)) === "already") toast = "Вы уже записаны";
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
      const started = update as { chat_id?: number; user?: { user_id: number; name?: string } };
      if (started.chat_id && started.user) {
        if (await dmAllowed(started.user.user_id, started.user.name)) await adminPanel.sendPanel(started.chat_id, started.user.user_id);
        else await api.sendMessageToChat(started.chat_id, { text: DM_DENIED });
      }
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
