import { config } from "./config";
import * as api from "./maxApi";
import { DEFAULT_ROSTER_TEMPLATE, gameTimeOf, renderRosterTemplate, rosterTitle } from "./messageFormatter";
import { isChatAdmin, refreshRoster } from "./sessionLogic";
import { getRosterTemplate, setGameTime, setRosterTemplate } from "./settingsStore";
import { getSession } from "./store";

/**
 * /описание (только админ) — шапка записи вместо «Футбол в Среда … / В 21:30».
 * Админ пишет пример как есть («Футбол в Среда 30.09.2026 года\nВ 20:30 - 21:30»),
 * а бот превращает его в шаблон: день недели и дата подставляются заново для
 * каждой записи, остальной текст остаётся как написан. Первое время ЧЧ:ММ в
 * тексте — начало игры: от него считаются напоминание, оплата и /статус.
 */

export const DESCRIPTION_RE = /^\/(описание|description)(?:\s+([\s\S]+))?$/i;

const WEEKDAY_NAMES = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
const WEEKDAY_RE = new RegExp(`(?<![а-яё])(${WEEKDAY_NAMES.join("|")})(?![а-яё])`, "i");
const DATE_FULL_RE = /(?<![\d.])\d{1,2}\.\d{1,2}\.\d{4}(?![\d.])/;
const DATE_SHORT_RE = /(?<![\d.])\d{1,2}\.\d{1,2}(?![\d.])/;
const TIME_RE = /(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/;

/** Текст админа → шаблон: день недели → {День}/{день}, дата → {дата}/{дата_кратко}. */
export function toTemplate(text: string): { template: string; dynamic: string[]; startTime: string | null } {
  let template = text;
  const dynamic: string[] = [];
  const wd = WEEKDAY_RE.exec(template);
  if (wd) {
    const capital = wd[1][0] === wd[1][0].toUpperCase();
    template = template.replace(WEEKDAY_RE, capital ? "{День}" : "{день}");
    dynamic.push("день недели");
  }
  if (DATE_FULL_RE.test(template)) {
    template = template.replace(DATE_FULL_RE, "{дата}");
    dynamic.push("дата");
  } else if (DATE_SHORT_RE.test(template)) {
    template = template.replace(DATE_SHORT_RE, "{дата_кратко}");
    dynamic.push("дата");
  }
  const t = TIME_RE.exec(text);
  return { template, dynamic, startTime: t ? `${t[1].padStart(2, "0")}:${t[2]}` : null };
}

const HELP = [
  "Напишите шапку так, как она должна выглядеть, например:",
  "/описание Футбол в Среда 30.09.2026 года",
  "В 20:30 - 21:30",
  "",
  "День недели и дата будут подставляться сами для каждой записи, остальное — как написано.",
  "Первое время (20:30) — начало игры для напоминаний и оплаты.",
  "/описание сброс — вернуть стандартную шапку.",
].join("\n");

/** Возвращает текст ответа админу. Шаблон общий — действует на текущую и все следующие записи. */
export async function handleDescription(groupChatId: number, userId: number, arg?: string): Promise<string> {
  if (!(await isChatAdmin(groupChatId, userId))) return "Эта команда доступна только администраторам чата.";
  const session = getSession(groupChatId);
  const text = arg?.trim();

  if (!text) {
    const current = session ? rosterTitle(session) : getRosterTemplate() ?? DEFAULT_ROSTER_TEMPLATE;
    return `Сейчас шапка записи:\n\n${current}\n\n${HELP}`;
  }

  if (/^(сброс|reset)$/i.test(text)) {
    setRosterTemplate(null);
    if (session) await refreshRoster(session);
    return "♻️ Шапка записи снова стандартная: «Футбол в {день недели} {дата} года / В {время}».";
  }

  if (text.length > 500) return "Слишком длинное описание — не больше 500 символов.";
  const { template, dynamic, startTime } = toTemplate(text);
  setRosterTemplate(template);

  const lines = ["✅ Шапка записи обновлена."];
  lines.push(
    dynamic.length
      ? `Меняется автоматически для каждой записи: ${dynamic.join(" и ")}.`
      : "В тексте нет дня недели и даты — шапка будет одинаковой у всех записей.",
  );

  if (startTime) {
    setGameTime(startTime);
    if (session && gameTimeOf(session) !== startTime) {
      const d = new Date(session.date);
      const [h, m] = startTime.split(":").map(Number);
      d.setHours(h, m, 0, 0);
      session.date = d.toISOString();
      session.notified = []; // время сдвинулось — уведомления считаются заново
      session.reminderSent = false;
    }
    lines.push(`Начало игры: ${startTime} — от него считаются напоминание (за ${config.reminderHoursBefore} ч), оплата и /статус.`);
  }

  if (session) {
    await refreshRoster(session);
    lines.push("", "Сейчас запись выглядит так:", renderRosterTemplate(template, session));
  }
  return lines.join("\n");
}

/** Ответ админу — в тот чат, где он написал; меняется запись общего чата. */
export async function handleDescriptionAndReply(
  groupChatId: number,
  replyChatId: number,
  userId: number,
  arg?: string,
): Promise<void> {
  const reply = await handleDescription(groupChatId, userId, arg);
  await api.sendMessageToChat(replyChatId, { text: reply });
}
