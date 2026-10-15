import { NOT_ADMIN } from "./format";
import { debtorLine, debtors, getRow, parseMonth, receiptsEnabled, refreshLedgerMessage, shortDate, updateRow } from "./paymentLedger";
import { applyMaxPlayers, isChatAdmin } from "./sessionLogic";
import { getChatOptions, getMaxPlayers, getPayment, hasOwnPayment, setChatOptions, setMaxPlayers, setPayment } from "./settingsStore";

/**
 * /оплата (только админ) — сумма с игрока и реквизиты этого чата для напоминаний об оплате:
 *   /оплата 350 Т-банк 89990000000 Екатерина
 * Хранится в базе, а не в репозитории (номер телефона). /оплата сброс — снова из .env.
 */
export const PAYMENT_RE = /^\/(оплата|payment)(?:\s+([\s\S]+))?$/i;

const HELP = "Формат: /оплата <сумма с игрока> <реквизиты>, например: /оплата 350 Т-банк 89990000000 Имя\n/оплата сброс — сумма и реквизиты из .env.";

/** Текст ответа админу. `groupChatId` — чат, чью оплату настраиваем (команда может прийти из лички). */
export async function paymentCommand(groupChatId: number, userId: number, arg?: string): Promise<string> {
  if (!(await isChatAdmin(groupChatId, userId))) return NOT_ADMIN;
  const text = arg?.trim();
  if (!text) {
    const p = getPayment(groupChatId);
    return `Сейчас: ${p.amount} ₽ с игрока на ${p.details}${hasOwnPayment(groupChatId) ? "" : " (по умолчанию из .env)"}.\n\n${HELP}`;
  }
  if (/^(сброс|reset)$/i.test(text)) {
    setPayment(groupChatId, null);
    const p = getPayment(groupChatId);
    return `♻️ Оплата снова по умолчанию: ${p.amount} ₽ с игрока на ${p.details}.`;
  }
  const m = text.match(/^(\d{1,6})\s*(?:₽|р\.?|руб\.?)?\s+([\s\S]+)$/i);
  if (!m) return `Не понял сумму.\n\n${HELP}`;
  const details = m[2].trim();
  if (details.length > 300) return "Слишком длинные реквизиты — не больше 300 символов.";
  setPayment(groupChatId, { amount: Number(m[1]), details });
  return `✅ Оплата этого чата: ${m[1]} ₽ с игрока на ${details}.`;
}

/**
 * /лимит (только админ) — сколько человек в основе у этого чата, дальше резерв:
 *   /лимит 15
 * Текущий список сразу пересчитывается. /лимит сброс — снова MAX_PLAYERS из .env.
 */
export const LIMIT_RE = /^\/(лимит|limit)(?:\s+([\s\S]+))?$/i;

export async function limitCommand(groupChatId: number, userId: number, arg?: string): Promise<string> {
  if (!(await isChatAdmin(groupChatId, userId))) return NOT_ADMIN;
  const text = arg?.trim();
  if (!text) return `Сейчас в основе ${getMaxPlayers(groupChatId)} человек, дальше резерв.\nИзменить: /лимит 15; /лимит сброс — из .env.`;
  if (/^(сброс|reset)$/i.test(text)) setMaxPlayers(groupChatId, null);
  else {
    const n = Number(text);
    if (!Number.isInteger(n) || n < 1 || n > 100) return "Укажите число от 1 до 100, например: /лимит 15";
    setMaxPlayers(groupChatId, n);
  }
  await applyMaxPlayers(groupChatId);
  return `✅ Основа: ${getMaxPlayers(groupChatId)}, дальше резерв. Список пересчитан.`;
}

/**
 * /напоминания (только админ) — когда этот чат напоминает об оплате:
 *   /напоминания 0 2 — до игры ни разу, после игры через 1 и 2 часа.
 * /напоминания сброс — как в .env (PAYMENT_HOURS_BEFORE / PAYMENT_HOURS_AFTER).
 */
export const REMINDERS_RE = /^\/(напоминания|reminders)(?:\s+([\s\S]+))?$/i;

function remindersText(chatId: number): string {
  const o = getChatOptions(chatId);
  const before = o.paymentBefore > 0 ? `каждый час за ${o.paymentBefore} ч до игры` : "до игры — нет";
  const n = o.paymentAfter;
  const after = n > 0 ? `после игры — ${n} ${n % 10 >= 2 && n % 10 <= 4 && (n < 12 || n > 14) ? "раза" : "раз"} (каждый час)` : "после игры — нет";
  return `Напоминания об оплате: ${before}; ${after}.`;
}

export async function remindersCommand(groupChatId: number, userId: number, arg?: string): Promise<string> {
  if (!(await isChatAdmin(groupChatId, userId))) return NOT_ADMIN;
  const text = arg?.trim();
  const help = "Изменить: /напоминания <часов до игры> <часов после игры>, например /напоминания 0 2. /напоминания сброс — как в .env.";
  if (!text) return `${remindersText(groupChatId)}\n${help}`;
  if (/^(сброс|reset)$/i.test(text)) {
    setChatOptions(groupChatId, { paymentBefore: undefined, paymentAfter: undefined });
    return `♻️ ${remindersText(groupChatId)}`;
  }
  const m = text.match(/^(\d{1,2})\s+(\d{1,2})$/);
  if (!m || Number(m[1]) > 12 || Number(m[2]) > 12) return `Не понял. ${help}`;
  setChatOptions(groupChatId, { paymentBefore: Number(m[1]), paymentAfter: Number(m[2]) });
  return `✅ ${remindersText(groupChatId)}`;
}

// ---- Учёт оплаты: /должники и /оплатил (только админ, чаты с проверкой чеков) ----

export const DEBTORS_RE = /^\/(должники|debtors)(?:\s+([\s\S]+))?$/i;
export const PAID_RE = /^\/(оплатил|paid)(?:\s+([\s\S]+))?$/i;

// Последний показанный админу список /должники — чтобы номера в /оплатил совпадали с ним.
const lastShown = new Map<string, { rows: number[]; arg?: string }>();
const shownKey = (chatId: number, userId: number) => `${chatId}:${userId}`;

export async function debtorsCommand(groupChatId: number, userId: number, arg?: string): Promise<string> {
  if (!(await isChatAdmin(groupChatId, userId))) return NOT_ADMIN;
  if (!receiptsEnabled(groupChatId)) return "В этом чате учёт оплаты (проверка чеков) не включён.";
  const period = parseMonth(arg);
  if (period === null) return "Не понял месяц. Примеры: /должники, /должники 9, /должники сентябрь, /должники все.";
  const rows = debtors(groupChatId, period);
  lastShown.set(shownKey(groupChatId, userId), { rows: rows.map((r) => r.id), arg });
  const title = period === "all" ? "все месяцы" : period.label;
  if (!rows.length) return `💰 Должников нет (${title}) 👍`;
  const sum = rows.reduce((n, r) => n + r.due - r.paid, 0);
  return [
    `💰 Должники — ${title}: ${rows.length}, на ${sum} ₽`,
    "",
    ...rows.map(debtorLine),
    "",
    "Отметить оплату: /оплатил <номер>, например /оплатил 1",
  ].join("\n");
}

export async function paidCommand(groupChatId: number, userId: number, arg?: string): Promise<string> {
  if (!(await isChatAdmin(groupChatId, userId))) return NOT_ADMIN;
  if (!receiptsEnabled(groupChatId)) return "В этом чате учёт оплаты (проверка чеков) не включён.";
  const nums = (arg ?? "").split(/[\s,]+/).filter(Boolean).map(Number);
  if (!nums.length || nums.some((n) => !Number.isInteger(n) || n < 1)) return "Укажите номер из /должники, например: /оплатил 5 (можно несколько: /оплатил 2 5)";
  const shown = lastShown.get(shownKey(groupChatId, userId));
  const ids = shown?.rows ?? debtors(groupChatId, parseMonth(undefined)).map((r) => r.id);
  const done: string[] = [];
  const games = new Set<string>();
  for (const n of nums) {
    const row = ids[n - 1] !== undefined ? getRow(ids[n - 1]) : undefined;
    if (!row || row.chat_id !== groupChatId) return `Нет номера ${n} в списке — посмотрите /должники.`;
    if (row.status === "paid" || row.status === "manual") {
      done.push(`${row.payer_name} — уже отмечен`);
      continue;
    }
    updateRow(row.id, { status: "manual", paid: row.due, note: "отметил админ" });
    games.add(row.game_date);
    done.push(`${row.payer_name} (${row.payer_profile}) — ${row.due} ₽ за ${shortDate(row.game_date)}`);
  }
  for (const g of games) await refreshLedgerMessage(groupChatId, g);
  return `✅ Отмечено как оплачено:\n${done.join("\n")}
Номера в /должники сдвинулись.`;
}
