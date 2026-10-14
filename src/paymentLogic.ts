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
  if (!(await isChatAdmin(groupChatId, userId))) return "Эта команда доступна только администраторам чата.";
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
  return `✅ Оплата этого чата: ${m[1]} ₽ с игрока на ${details}. Так будет в напоминаниях об оплате.`;
}

/**
 * /лимит (только админ) — сколько человек в основе у этого чата, дальше резерв:
 *   /лимит 15
 * Текущий список сразу пересчитывается. /лимит сброс — снова MAX_PLAYERS из .env.
 */
export const LIMIT_RE = /^\/(лимит|limit)(?:\s+([\s\S]+))?$/i;

export async function limitCommand(groupChatId: number, userId: number, arg?: string): Promise<string> {
  if (!(await isChatAdmin(groupChatId, userId))) return "Эта команда доступна только администраторам чата.";
  const text = arg?.trim();
  if (!text) return `Сейчас в основе ${getMaxPlayers(groupChatId)} человек, дальше резерв.\nИзменить: /лимит 15; /лимит сброс — из .env.`;
  if (/^(сброс|reset)$/i.test(text)) setMaxPlayers(groupChatId, null);
  else {
    const n = Number(text);
    if (!Number.isInteger(n) || n < 1 || n > 100) return "Укажите число от 1 до 100, например: /лимит 15";
    setMaxPlayers(groupChatId, n);
  }
  await applyMaxPlayers(groupChatId);
  return `✅ В основе теперь ${getMaxPlayers(groupChatId)} человек, дальше — резерв. Текущий список пересчитан.`;
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
  if (!(await isChatAdmin(groupChatId, userId))) return "Эта команда доступна только администраторам чата.";
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
