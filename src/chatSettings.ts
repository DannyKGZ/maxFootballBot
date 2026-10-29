import { NOT_ADMIN } from "./format";
import * as api from "./maxApi";
import { InlineKeyboardAttachment, KeyboardButton } from "./maxApi";
import { chatTitle } from "./dmTarget";
import { toggleRole } from "./rolesLogic";
import { isChatAdmin } from "./sessionLogic";
import { ChatOptions, getChatOptions, getMaxPlayers, getPayment, hasOwnPayment, setChatOptions } from "./settingsStore";
import { ButtonAction } from "./types";

/**
 * ⚙️ Настройки чата (только админ): /настройки или кнопка в личке. Кнопки
 * включают/выключают функции чата и перебирают значения напоминаний и голосования.
 * Всё хранится в базе у каждого чата (settingsStore.ts → ChatOptions).
 */

export const SETTINGS_RE = /^\/(настройки|settings)$/i;
export const RECEIPTS_RE = /^\/(чеки|receipts)(?:\s+([\s\S]+))?$/i;

type Toggle = "legend" | "maniska" | "payment" | "receipts" | "mvpCongrats" | "sticky";
type Cycle = "reminderBefore" | "voteAutoStart" | "voteAutoClose";
type SettingsAction = Extract<ButtonAction, { a: "cfg" }>;

// Значения, которые перебирает кнопка (по кругу).
const CYCLES: Record<Cycle, number[]> = {
  reminderBefore: [0, 1, 2, 3, 4, 5, 6],
  voteAutoStart: [0, 30, 60, 90, 120],
  voteAutoClose: [0, 6, 12, 24, 48],
};

const btn = (text: string, action: SettingsAction): KeyboardButton => ({ type: "callback", text, payload: JSON.stringify(action) });
const mark = (on: boolean) => (on ? "✅" : "❌");
const minutes = (m: number) => (m % 60 === 0 ? `${m / 60} ч` : `${m} мин`);

function isOn(o: ChatOptions, key: Toggle): boolean {
  return key === "receipts" ? Boolean(o.receipts) : o[key];
}

function settingsText(chatId: number, title: string): string {
  const o = getChatOptions(chatId);
  const p = getPayment(chatId);
  const payment = o.payment
    ? `${p.amount} ₽ с игрока, ${p.details}; напоминания: ${o.paymentBefore ? `за ${o.paymentBefore} ч до игры` : "до игры нет"}, ${o.paymentAfter ? `${o.paymentAfter} ч после` : "после нет"}`
    : "выкл";
  return [
    `⚙️ Настройки — ${title}`,
    "",
    `🏆 Легенда (1-й в записи, легенда года): ${o.legend ? "вкл" : "выкл"}`,
    `👕 Манишки (манишкаНосец 2-й в записи): ${o.maniska ? "вкл" : "выкл"}`,
    `💰 Оплата: ${payment}`,
    `📄 Проверка PDF-чеков: ${o.receipts ? `${o.receipts.phone}, ${o.receipts.recipient}` : "выкл"}`,
    `🎉 Поздравления MVP: ${o.mvpCongrats ? "вкл" : "выкл"}`,
    `📌 Дележка и голосование внизу чата: ${o.sticky ? "вкл" : "выкл"}`,
    `⏰ Напоминание о составе: ${o.reminderBefore ? `за ${o.reminderBefore} ч до игры` : "нет"}`,
    `🗳 Голосование MVP открывается: ${o.voteAutoStart ? `через ${minutes(o.voteAutoStart)} после начала игры` : "вручную"}`,
    `⏱ Голосование закрывается: ${o.voteAutoClose ? `через ${o.voteAutoClose} ч` : "когда проголосуют все или вручную"}`,
    `👥 Основа: ${getMaxPlayers(chatId)} чел.`,
    "",
    "Кнопки ниже включают и выключают. Команды: /оплата 350 Банк телефон Имя, /напоминания 0 2, /чеки +7… Имя, /лимит 15, /игры, /расписание.",
  ].join("\n");
}

function settingsKeyboard(chatId: number): InlineKeyboardAttachment {
  const o = getChatOptions(chatId);
  const t = (key: Toggle, label: string) => btn(`${mark(isOn(o, key))} ${label}`, { a: "cfg", k: key });
  return {
    type: "inline_keyboard",
    payload: {
      buttons: [
        [t("legend", "🏆 Легенда"), t("maniska", "👕 Манишки")],
        [t("payment", "💰 Оплата"), t("receipts", "📄 Чеки")],
        [t("mvpCongrats", "🎉 Поздравления"), t("sticky", "📌 Внизу")],
        [
          btn(`⏰ ${o.reminderBefore ? `${o.reminderBefore} ч` : "нет"}`, { a: "cfg", k: "reminderBefore" }),
          btn(`🗳 ${o.voteAutoStart ? minutes(o.voteAutoStart) : "вручную"}`, { a: "cfg", k: "voteAutoStart" }),
          btn(`⏱ ${o.voteAutoClose ? `${o.voteAutoClose} ч` : "вручную"}`, { a: "cfg", k: "voteAutoClose" }),
        ],
      ],
    },
  };
}

/** /настройки — экран настроек с кнопками туда, откуда спросили. */
export async function settingsCommand(groupChatId: number, replyChatId: number, userId: number): Promise<string> {
  if (!(await isChatAdmin(groupChatId, userId))) return NOT_ADMIN;
  await api.sendMessageToChat(replyChatId, { text: settingsText(groupChatId, await chatTitle(groupChatId)), attachments: [settingsKeyboard(groupChatId)] });
  return "";
}

export function isSettingsAction(action: ButtonAction): action is SettingsAction {
  return action.a === "cfg";
}

/** Нажатие кнопки настроек: меняем и перерисовываем экран. Возвращает текст уведомления. */
export async function handleSettingsAction(groupChatId: number, replyChatId: number, userId: number, action: SettingsAction, messageId?: string): Promise<string> {
  if (!(await isChatAdmin(groupChatId, userId))) return NOT_ADMIN;
  const o = getChatOptions(groupChatId);
  const key = action.k;
  let toast: string;
  if (key === "legend" || key === "maniska") {
    toast = await toggleRole(groupChatId, key, !o[key]);
  } else if (key === "payment") {
    if (!o.payment && !hasOwnPayment(groupChatId) && !process.env.PAYMENT_DETAILS) return "Сначала задайте сумму и реквизиты: /оплата 350 Банк телефон Имя";
    setChatOptions(groupChatId, { payment: !o.payment });
    toast = o.payment ? "💰 Оплата выключена" : "💰 Оплата включена";
  } else if (key === "receipts") {
    if (!o.receipts) return "Включить: /чеки +7 (900) 111-22-33 Имя Ф. — телефон и получатель из чека";
    setChatOptions(groupChatId, { receipts: undefined });
    toast = "📄 Проверка чеков выключена";
  } else if (key === "mvpCongrats" || key === "sticky") {
    setChatOptions(groupChatId, { [key]: !o[key] });
    toast = o[key] ? "Выключено" : "Включено";
  } else if (key in CYCLES) {
    const values = CYCLES[key as Cycle];
    const next = values[(values.indexOf(o[key as Cycle]) + 1) % values.length];
    setChatOptions(groupChatId, { [key]: next });
    toast = "Сохранено";
  } else {
    return "Неизвестная настройка";
  }
  if (messageId) {
    await api.editMessage(replyChatId, messageId, { text: settingsText(groupChatId, await chatTitle(groupChatId)), attachments: [settingsKeyboard(groupChatId)] });
  }
  return toast;
}

/**
 * /чеки (только админ) — проверка PDF-чеков об оплате: куда должны переводить.
 *   /чеки +7 (900) 111-22-33 Мария П. — включить; /чеки выкл — выключить.
 */
export async function receiptsCommand(groupChatId: number, userId: number, arg?: string): Promise<string> {
  if (!(await isChatAdmin(groupChatId, userId))) return NOT_ADMIN;
  const text = arg?.trim() ?? "";
  const help = "Включить: /чеки +7 (900) 111-22-33 Мария П. — телефон и получатель, как в чеке. Выключить: /чеки выкл";
  const current = getChatOptions(groupChatId).receipts;
  if (!text) return `${current ? `📄 Чеки проверяются: ${current.phone}, ${current.recipient}.` : "📄 Проверка чеков выключена."}\n${help}`;
  if (/^(выкл|выключить|off)$/i.test(text)) {
    setChatOptions(groupChatId, { receipts: undefined });
    return "📄 Проверка чеков выключена.";
  }
  const m = text.match(/^(\+?[\d\s()-]{10,20}?)\s+(\p{L}[\s\S]{0,60})$/u);
  if (!m || m[1].replace(/\D/g, "").length < 10) return `Не понял. ${help}`;
  setChatOptions(groupChatId, { receipts: { phone: m[1].trim(), recipient: m[2].trim() } });
  return `✅ Чеки проверяются: перевод на ${m[1].trim()}, получатель ${m[2].trim()}. Сумма — записанные × ${getPayment(groupChatId).amount} ₽.`;
}
