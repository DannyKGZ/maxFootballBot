import { config } from "./config";
import { throttled } from "./rateLimiter";
import { trackSentMessage, untrackSentMessage } from "./store";
import { MaxChatAdminsResponse, MaxChatMember, MaxUpdate } from "./types";

// Тонкий клиент к REST API MAX (https://dev.max.ru/docs-api).
// Сделан на встроенном fetch (Node.js 18+), без сторонних SDK, чтобы
// поведение было полностью прозрачным и не зависело от версии SDK.
//
// ВАЖНО: перед боевым запуском сверьте эндпоинты и формы ответов с
// актуальной документацией на dev.max.ru — API молодой и может меняться.

export interface KeyboardButton {
  type: "callback" | "link" | "request_contact" | "request_geo_location" | "chat";
  text: string;
  payload?: string; // для type: "callback"
  url?: string; // для type: "link"
}

export interface InlineKeyboardAttachment {
  type: "inline_keyboard";
  payload: {
    buttons: KeyboardButton[][];
  };
}

export interface NewMessageBody {
  text?: string;
  format?: "markdown" | "html";
  notify?: boolean;
  disable_link_preview?: boolean;
  attachments?: InlineKeyboardAttachment[];
}

async function request<T>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  pathname: string,
  query: Record<string, string | number | boolean | undefined>,
  body?: unknown,
): Promise<T> {
  const url = new URL(config.apiBaseUrl + pathname);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  const res = await fetch(url.toString(), {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: config.botToken,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json: unknown = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    // не-JSON ответ — оставим как есть, ниже бросим ошибку с текстом
  }

  if (!res.ok) {
    throw new Error(
      `MAX API ${method} ${pathname} -> HTTP ${res.status}: ${text || res.statusText}`,
    );
  }

  return json as T;
}

export interface SendMessageResult {
  message: {
    body: { mid: string; seq: number };
    [key: string]: unknown;
  };
}

/**
 * POST /messages — отправить новое сообщение в чат.
 * Заодно запоминает id сообщения в сторе (см. store.trackSentMessage) — это
 * единая точка отправки, поэтому именно здесь удобнее всего собирать список
 * "мусорных" сообщений для очистки чата после голосования за MVP.
 */
export async function sendMessageToChat(
  chatId: number,
  body: NewMessageBody,
): Promise<SendMessageResult> {
  const res = await throttled(chatId, () =>
    request<SendMessageResult>("POST", "/messages", { chat_id: chatId }, body),
  );
  trackSentMessage(chatId, res.message.body.mid);
  return res;
}

/**
 * POST /messages?user_id=... — личное сообщение пользователю. MAX может
 * отказать, если человек ещё не открывал чат с ботом, — вызывающий код
 * должен быть к этому готов. Такие сообщения не участвуют в очистке чата.
 */
export function sendMessageToUser(userId: number, body: NewMessageBody): Promise<SendMessageResult> {
  return throttled(undefined, () =>
    request<SendMessageResult>("POST", "/messages", { user_id: userId }, body),
  );
}

/** PUT /messages?message_id=... — отредактировать существующее сообщение. */
export function editMessage(
  chatId: number,
  messageId: string,
  body: NewMessageBody,
): Promise<{ success: boolean; message?: string }> {
  return throttled(chatId, () =>
    request("PUT", "/messages", { message_id: messageId }, body),
  );
}

/**
 * POST /answers?callback_id=... — обязательный ответ на нажатие кнопки.
 * `notification` — текст всплывающего уведомления, которое видит только нажавший
 *   (поле указано по ТЗ; сверьте точное имя поля с актуальной схемой на
 *   dev.max.ru/docs-api/methods/POST/answers перед продакшеном).
 * `message` — опционально: чем заменить/обновить исходное сообщение (как PUT /messages).
 */
export function answerCallback(
  chatId: number,
  callbackId: string,
  options: { notification?: string; message?: NewMessageBody } = {},
): Promise<{ success: boolean; message?: string }> {
  return throttled(chatId, () =>
    request(
      "POST",
      "/answers",
      { callback_id: callbackId },
      {
        notification: options.notification,
        message: options.message,
      },
    ),
  );
}

/** GET /chats/{chatId}/members/admins — список администраторов чата (для проверки прав). */
export function getChatAdmins(chatId: number): Promise<MaxChatAdminsResponse> {
  return throttled(chatId, () =>
    request<MaxChatAdminsResponse>("GET", `/chats/${chatId}/members/admins`, {}),
  );
}

/**
 * GET /chats/{chatId}/members — участники чата постранично (до 100 за раз).
 * Нужно для команды /Всем, которая упоминает всех участников.
 */
export function getChatMembers(
  chatId: number,
  marker?: number,
): Promise<{ members: MaxChatMember[]; marker?: number | null }> {
  return throttled(chatId, () =>
    request("GET", `/chats/${chatId}/members`, { count: 100, marker }),
  );
}

/**
 * DELETE /messages?message_id=... — удалить сообщение (бот должен иметь право
 * удалять сообщения в чате; MAX позволяет удалять только сообщения младше 24 часов).
 * Используется при очистке чата после голосования за MVP.
 */
export async function deleteMessage(
  chatId: number,
  messageId: string,
): Promise<{ success: boolean; message?: string }> {
  const res = await throttled(chatId, () =>
    request<{ success: boolean; message?: string }>("DELETE", "/messages", { message_id: messageId }),
  );
  untrackSentMessage(chatId, messageId);
  return res;
}

/** POST /subscriptions — регистрация вебхука (см. README про TLS-сертификат). */
export function registerWebhook(
  url: string,
  updateTypes: string[],
  secret?: string,
): Promise<{ success: boolean; message?: string }> {
  return request("POST", "/subscriptions", {}, { url, update_types: updateTypes, secret });
}

/** GET /subscriptions — на какие адреса MAX сейчас шлёт вебхуки. */
export function getSubscriptions(): Promise<{ subscriptions: Array<{ url: string; time: number }> }> {
  return request("GET", "/subscriptions", {});
}

/** DELETE /subscriptions?url=... — отписать адрес (старый туннель). */
export function deleteSubscription(url: string): Promise<{ success: boolean; message?: string }> {
  return request("DELETE", "/subscriptions", { url });
}

/** PATCH /me/commands — меню команд бота (подсказки при вводе «/»; общее для всех). */
export function setBotCommands(commands: Array<{ name: string; description: string }>): Promise<unknown> {
  return request("PATCH", "/me/commands", {}, { commands });
}

export interface UpdatesResponse {
  updates: MaxUpdate[];
  marker?: number | null;
}

/**
 * GET /updates — long polling: ждёт новые события до `timeout` секунд (до 90).
 * `marker` — с какого события продолжать (из прошлого ответа); без него MAX
 * отдаёт только последнее событие. Работает, только пока у бота нет подписки на вебхук.
 */
export function getUpdates(marker: number | undefined, timeoutSec: number, types: string[]): Promise<UpdatesResponse> {
  // Без очереди лимитов: запрос висит до timeout секунд и не должен задерживать отправку сообщений.
  return request<UpdatesResponse>("GET", "/updates", { limit: 100, timeout: timeoutSec, marker, types: types.join(",") });
}
