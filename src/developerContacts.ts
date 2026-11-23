import { sendMessageToChat } from "./maxApi";

const MAX_CONTACT = "https://max.ru/u/f9LHodD0cOJgjoqpHRHyZZE14zij8LR48q1BUeF9jhrYjGHzoMaedd1kews";
const TELEGRAM_HANDLE = "Danny_KG";

export const CONTACTS_RE = /^\/(контакты|contacts)$/i;

export async function sendDeveloperContacts(chatId: number, intro?: string): Promise<void> {
  const text = [
    ...(intro ? [intro, ""] : []),
    "По вопросам разработки обращайтесь",
    `MAX — ${MAX_CONTACT}`,
    `Telegram — @${TELEGRAM_HANDLE}`,
  ].join("\n");
  await sendMessageToChat(chatId, {
    text,
    disable_link_preview: true,
    attachments: [{
      type: "inline_keyboard",
      payload: {
        buttons: [[
          { type: "link", text: "💬 Написать в MAX", url: MAX_CONTACT },
          { type: "link", text: "✈️ Написать в Telegram", url: `https://t.me/${TELEGRAM_HANDLE}` },
        ]],
      },
    }],
  });
}
