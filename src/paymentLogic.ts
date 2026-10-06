import { isChatAdmin } from "./sessionLogic";
import { getPayment, hasOwnPayment, setPayment } from "./settingsStore";

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
