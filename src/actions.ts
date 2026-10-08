import { config } from "./config";
import * as scheduleLogic from "./scheduleLogic";
import * as sessionLogic from "./sessionLogic";
import * as voteLogic from "./voteLogic";
import { showStatus } from "./statusInfo";
import { buildAdminHelpParts, buildUserHelpParts } from "./helpInfo";
import { isChatAdmin } from "./sessionLogic";
import { MvpResetScope, mergeMvpNames, resetMvp } from "./settingsStore";
import { mvpResetKeyboard } from "./keyboard";
import { MAX_MESSAGE_CHARS } from "./messageParts";

/** Сколько человек упоминать в одном сообщении /всем (больше MAX молча не отмечает). */
const MENTIONS_PER_MESSAGE = 40;

/** Сброс рейтинга MVP: /мвпСезонныйСброс — только сезон, /мвпОбщийСброс — весь рейтинг. */
export const MVP_RESET_RE: Array<{ re: RegExp; scope: MvpResetScope }> = [
  { re: /^\/(мвп_?сезонный_?сброс|mvp_reset_season)$/i, scope: "season" },
  { re: /^\/(мвп_?общий_?сброс|mvp_reset_all)$/i, scope: "all" },
];
import * as api from "./maxApi";
import { escapeHtml, fullName, mention } from "./messageFormatter";

/**
 * Объявление всем: «/Всем Сбор в 21:00!», «/all …» или как в Telegram —
 * «@all …», «@всем …», «@все …» (только админ). Группа 2 — текст объявления.
 */
export const MENTION_ALL_RE = /^(?:\/(?:всем|all)|@(?:all|всем|все))(?:\s+([\s\S]+))?$/i;

/** «/объединить Рус = Ruslan» — имя слева вливается в имя справа. */
export const MERGE_RE = /^\/(объединить|merge)\s+(.+?)\s*(?:=|->|→)\s*(.+)$/i;

/**
 * Панельные действия — одни и те же и для текстовых команд (/старт, /итоги…),
 * и для кнопок под сообщениями бота. Результат:
 *  - chat  — что написать в чат при вызове командой (отказ, пояснение);
 *  - toast — что показать всплывающим уведомлением при нажатии кнопки.
 * Пустой результат = действие выполнено, бот уже сам всё показал в чате.
 */
export interface ActionResult {
  chat?: string;
  toast?: string;
}

const NOT_ADMIN = "Эта команда доступна только администраторам чата.";
const deny = (text: string): ActionResult => ({ chat: text, toast: text });

export async function start(chatId: number, userId: number): Promise<ActionResult> {
  const outcome = await sessionLogic.requestAdminStart(chatId, userId);
  if (outcome === "not_admin") return deny(NOT_ADMIN);
  if (outcome === "asked_confirmation") return { toast: "Уточните в чате — уже есть активная запись" };
  return {};
}

export async function close(chatId: number, userId: number): Promise<ActionResult> {
  const outcome = await sessionLogic.requestAdminClose(chatId, userId);
  if (outcome === "not_admin") return deny(NOT_ADMIN);
  if (outcome === "no_session") return deny("Сейчас нет активной записи.");
  if (outcome === "closed") return deny("Запись закрыта.");
  return { toast: "Подтвердите закрытие в чате" };
}

export async function voteStart(chatId: number, userId: number): Promise<ActionResult> {
  const outcome = await voteLogic.startVote(chatId, userId);
  if (outcome === "not_admin") return deny(NOT_ADMIN);
  if (outcome === "no_session") return deny("Нет записи с игроками, за которую можно голосовать.");
  if (outcome === "already_active") {
    return deny("Голосование уже идёт — сначала завершите его (/итоги или кнопка «Итоги»).");
  }
  return {};
}

export async function voteFinish(chatId: number, userId: number): Promise<ActionResult> {
  const outcome = await voteLogic.finishVote(chatId, userId);
  if (outcome === "not_admin") return deny(NOT_ADMIN);
  if (outcome === "no_vote") return deny("Сейчас нет активного голосования.");
  return {};
}

/** /статус (для всех): актуальность записи; новое сообщение заменяет прошлое. */
export async function status(chatId: number, _userId: number): Promise<ActionResult> {
  await showStatus(chatId);
  return {};
}

export async function schedule(chatId: number, userId: number): Promise<ActionResult> {
  const outcome = await scheduleLogic.startScheduleDialog(chatId, userId);
  if (outcome === "not_admin") return deny(NOT_ADMIN);
  return { toast: "Настройка расписания открыта в чате" };
}

export async function mvp(chatId: number, _userId: number): Promise<ActionResult> {
  await voteLogic.showMvpRating(chatId);
  return {};
}

/** Объединение игроков в рейтинге MVP (только админ группы `groupChatId`). */
export async function mergeMvp(
  groupChatId: number,
  userId: number,
  from: string,
  to: string,
): Promise<ActionResult> {
  if (!(await isChatAdmin(groupChatId, userId))) return deny(NOT_ADMIN);
  const res = mergeMvpNames(groupChatId, from, to);
  if (!res.ok) return deny(res.error);
  return deny(`Готово: «${res.from}» объединён с «${res.to}». Теперь у ${res.to} — ${res.count} MVP.`);
}

/**
 * Упоминает всех участников группы `groupChatId` (кроме ботов) с текстом
 * админа. Упоминание — ссылка max://user/ID, по ней человеку приходит
 * уведомление. Если участников много, упоминания делятся на несколько сообщений.
 */
export async function mentionAll(
  groupChatId: number,
  userId: number,
  text: string | undefined,
  { allowEmpty = false }: { allowEmpty?: boolean } = {},
): Promise<ActionResult> {
  if (!(await isChatAdmin(groupChatId, userId))) return deny(NOT_ADMIN);
  const body = text?.trim() || (allowEmpty ? "Внимание всем!" : "");
  if (!body) return deny("Напишите текст после команды, например: /Всем Сбор сегодня в 21:00");

  // Без ботов и удалённых аккаунтов («DELETED USER»).
  // Полное имя обязательно: с одним first_name MAX не упоминает людей с фамилией.
  const members = (await api.listChatMembers(groupChatId)).map((m) => ({ user_id: m.user_id, name: fullName(m) || "участник" }));
  if (members.length === 0) return deny("Не удалось получить список участников чата.");

  // MAX упоминает не больше нескольких десятков человек в одном сообщении — делим
  // по MENTIONS_PER_MESSAGE (и по длине): 80 участников → два сообщения.
  const chunks: string[] = [];
  let current = `📢 ${escapeHtml(body)}\n\n`;
  let inCurrent = 0;
  for (const m of members) {
    const piece = mention(m.user_id, m.name);
    if (inCurrent >= MENTIONS_PER_MESSAGE || current.length + piece.length + 2 > MAX_MESSAGE_CHARS) {
      chunks.push(current);
      current = "";
      inCurrent = 0;
    }
    current += (current && !current.endsWith("\n") ? ", " : "") + piece;
    inCurrent++;
  }
  chunks.push(current);
  for (const chunk of chunks) await api.sendMessageToChat(groupChatId, { text: chunk, format: "html" });

  if (config.announceDm) await duplicateToDms(members, userId, body);
  return {};
}

/**
 * Копия объявления каждому участнику в личку (кроме автора). MAX не даёт боту
 * написать первым тому, кто ни разу не открывал бота, — такие пропускаются.
 * Итог («доставлено N из M», кто не получил) бот присылает автору в личку.
 */
async function duplicateToDms(members: Array<{ user_id: number; name: string }>, authorId: number, body: string) {
  const author = members.find((m) => m.user_id === authorId)?.name ?? "администратор";
  const recipients = members.filter((m) => m.user_id !== authorId);
  const failed: string[] = [];
  for (const m of recipients) {
    try {
      await api.sendMessageToUser(m.user_id, { text: `📢 Объявление из чата футбола от ${author}:\n\n${body}` });
    } catch {
      failed.push(m.name);
    }
  }
  const delivered = recipients.length - failed.length;
  const lines = [`📬 Объявление продублировано в личку: доставлено ${delivered} из ${recipients.length}.`];
  if (failed.length) {
    const shown = failed.slice(0, 30).join(", ") + (failed.length > 30 ? ` и ещё ${failed.length - 30}` : "");
    lines.push(`Не получили (ни разу не открывали бота): ${shown}.`, "Чтобы получать объявления в личку, им нужно открыть бота и нажать «Начать».");
  }
  try {
    await api.sendMessageToUser(authorId, { text: lines.join("\n") });
  } catch (err) {
    console.error("[actions] не удалось отправить автору итог рассылки в личку:", err);
  }
}

/**
 * Шаг 1 сброса MVP: админ получает вопрос с кнопками «Да/Нет» в `replyChatId`
 * (общий чат или личка), сам сброс — после подтверждения (confirmMvpReset).
 */
export async function requestMvpReset(
  groupChatId: number,
  replyChatId: number,
  userId: number,
  scope: MvpResetScope,
): Promise<ActionResult> {
  if (!(await isChatAdmin(groupChatId, userId))) return deny(NOT_ADMIN);
  const text =
    scope === "season"
      ? "Обнулить сезонный рейтинг MVP? Общий счёт за всё время сохранится."
      : "Обнулить ВЕСЬ рейтинг MVP — и общий, и сезонный? Вернуть счёт будет нельзя.";
  await api.sendMessageToChat(replyChatId, { text, attachments: [mvpResetKeyboard(userId, scope)] });
  return { toast: "Подтвердите ниже" };
}

/** Шаг 2: сброс и объявление в общем чате. Права проверяются ещё раз. */
export async function confirmMvpReset(groupChatId: number, userId: number, scope: MvpResetScope): Promise<ActionResult> {
  if (!(await isChatAdmin(groupChatId, userId))) return deny(NOT_ADMIN);
  const affected = resetMvp(groupChatId, scope);
  const text =
    scope === "season"
      ? `🧹 Сезонный рейтинг MVP обнулён — начинается новый сезон. Общий счёт сохранён (игроков: ${affected}).`
      : `🗑 Рейтинг MVP полностью обнулён — и общий, и сезонный (игроков: ${affected}).`;
  await api.sendMessageToChat(groupChatId, { text });
  return { toast: scope === "season" ? "Сезон обнулён" : "Рейтинг обнулён" };
}

/** /help, /инструкция — для всех. */
export const HELP_RE = /^\/(help|инструкция|помощь)$/i;

/**
 * Инструкция нажавшему/написавшему — в личку (в группе её увидели бы все):
 * админу — полная с админскими командами, участнику — только его команды.
 */
export async function sendHelp(groupChatId: number, userId: number): Promise<ActionResult> {
  const isAdmin = await isChatAdmin(groupChatId, userId);
  // Инструкция админа длиннее лимита MAX (4000 символов), поэтому идёт
  // несколькими сообщениями, разбитыми по целым разделам (см. messageParts.ts).
  const parts = isAdmin ? buildAdminHelpParts(groupChatId, userId) : buildUserHelpParts(groupChatId, userId);
  let sent = 0;
  try {
    for (const text of parts) {
      await api.sendMessageToUser(userId, { text });
      sent++;
    }
    return { toast: "Инструкция отправлена вам в личный чат с ботом" };
  } catch (err) {
    console.error(`[actions] инструкция в личку: отправлено ${sent} из ${parts.length} частей —`, err);
    if (sent > 0) {
      // Личка открыта (первая часть дошла) — подсказка про «Начать» была бы неверной.
      const partial = `Инструкция пришла не полностью (${sent} из ${parts.length}) — попробуйте ещё раз.`;
      return { toast: partial };
    }
    const hint = "Чтобы получить инструкцию, откройте бота в личных сообщениях, нажмите «Начать» и повторите.";
    return { toast: hint, chat: hint };
  }
}

/** Меню команд MAX (подсказки при вводе «/») — общее для всех, поэтому только команды участников. */
export const USER_MENU_COMMANDS = [
  { name: "status", description: "Актуальна ли запись, сколько свободных мест" },
  { name: "mvp", description: "Рейтинг MVP за сезон и за всё время" },
  { name: "help", description: "Инструкция — придёт в личку" },
];
