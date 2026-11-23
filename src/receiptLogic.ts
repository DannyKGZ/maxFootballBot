import { createHash } from "crypto";
import { config } from "./config";
import { db } from "./db";
import * as api from "./maxApi";
import {
  getRow,
  isSettled,
  PaymentRow,
  receiptsEnabled,
  refreshLedgerMessage,
  shortDate,
  updateRow,
} from "./paymentLedger";
import { getChatOptions, getPayment } from "./settingsStore";
import { MaxUser } from "./types";

/**
 * Чек об оплате — в чат (с проверкой чеков) или боту в личку:
 *  - PDF: бот читает текст, проверяет получателя (телефон или имя из настроек
 *    чата) и сумму. При совпадении отмечает оплату, остальные чеки идут на проверку;
 *  - фото (или другой файл) — сразу ручная проверка;
 * ручная проверка: в списке «⏳ на проверке», человека больше не упоминают;
 * админ смотрит чеки кнопкой «💰 Должники и чеки» в личке и отмечает /оплатил N.
 * В общем чате фото считается чеком, только если в подписи есть «чек/оплат/перев».
 */

interface Attachment {
  type?: string;
  filename?: string;
  payload?: { url?: string; token?: string };
}

const MAX_PDF_BYTES = 10 * 1024 * 1024;

/** Неоплаченная строка учёта этого человека — самая свежая игра (в чатах с проверкой чеков). */
function openRowFor(userId: number): PaymentRow | undefined {
  const rows = db()
    .prepare("SELECT * FROM payments WHERE payer_id = ? AND status NOT IN ('paid', 'manual') ORDER BY game_date DESC, id DESC")
    .all(userId) as PaymentRow[];
  return rows.find((r) => config.chatIds.includes(r.chat_id) && receiptsEnabled(r.chat_id));
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  // unpdf — ESM-модуль; import() через Function, чтобы TypeScript (commonjs) не превратил его в require.
  const { extractText, getDocumentProxy } = (await new Function("m", "return import(m)")("unpdf")) as typeof import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

const num = (s: string) => Number(s.replace(/[\s  ]/g, "").replace(",", "."));

/** Сумма перевода из текста чека: «Сумма 1 050 ₽», иначе «Итого …», иначе первая сумма с ₽. */
export function findAmount(text: string): number | null {
  const money = String.raw`((?:\d{1,3}(?:[\s  ]\d{3})+|\d+)(?:[.,]\d{1,2})?)\s*(?:₽|руб|RUB|р\.)`;
  for (const label of ["Сумма перевода", "Сумма", "Итого"]) {
    const m = text.match(new RegExp(`${label}[^\\d\\n]{0,20}${money}`, "i")) ?? text.match(new RegExp(`${label}\\s*\\n\\s*${money}`, "i"));
    if (m) return num(m[1]);
  }
  const any = text.match(new RegExp(money, "i"));
  return any ? num(any[1]) : null;
}

/** Получатель совпадает: есть телефон (последние 10 цифр) или имя получателя. */
export function recipientMatches(text: string, expected: { phone: string; recipient: string }): boolean {
  const phone = expected.phone.replace(/\D/g, "").slice(-10);
  const digits = text.replace(/\D/g, "");
  if (phone && digits.includes(phone)) return true;
  const norm = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
  return Boolean(expected.recipient) && norm(text).includes(norm(expected.recipient));
}

/** Неоплаченная строка этого человека в конкретном чате (самая свежая игра). */
function openRowIn(chatId: number, userId: number): PaymentRow | undefined {
  return db()
    .prepare("SELECT * FROM payments WHERE chat_id = ? AND payer_id = ? AND status NOT IN ('paid', 'manual') ORDER BY game_date DESC LIMIT 1")
    .get(chatId, userId) as PaymentRow | undefined;
}

export async function downloadPdf(rawUrl: string): Promise<Uint8Array> {
  const url = new URL(rawUrl);
  const apiOrigin = new URL(config.apiBaseUrl).origin;
  const isApi = url.origin === apiOrigin;
  const mockApi = isApi && url.protocol === "http:" && url.hostname === "127.0.0.1";
  const trusted = isApi || config.receiptDownloadOrigins.includes(url.origin);
  if ((url.protocol !== "https:" && !mockApi) || !trusted || url.username || url.password) {
    throw new Error("источник файла не входит в список доверенных");
  }

  const options = { signal: AbortSignal.timeout(30_000), redirect: "error" } as const;
  let response = await fetch(url, options);
  if (isApi && url.protocol === "https:" && (response.status === 401 || response.status === 403)) {
    await response.body?.cancel();
    response = await fetch(url, { ...options, headers: { Authorization: config.botToken } });
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`скачивание не удалось (HTTP ${response.status})`);
  }
  if (Number(response.headers.get("content-length")) > MAX_PDF_BYTES) {
    await response.body.cancel();
    throw new Error("файл больше 10 МБ");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_PDF_BYTES) {
        await reader.cancel();
        throw new Error("файл больше 10 МБ");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Uint8Array.from(Buffer.concat(chunks, length));
}

type ReceiptCheck = { reason: string | null; hash?: string };

async function checkPdf(row: PaymentRow, pdf: Attachment): Promise<ReceiptCheck | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = await downloadPdf(pdf.payload?.url ?? "");
  } catch (err) {
    console.warn("[receipts] не удалось скачать PDF:", err instanceof Error ? err.message : err);
    return undefined;
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  let text = "";
  try {
    text = await pdfText(bytes);
  } catch (err) {
    console.warn("[receipts] не удалось прочитать PDF:", err instanceof Error ? err.message : err);
  }
  if (!text.trim()) return { reason: "в PDF нет текста (скан?)" };
  const expected = getChatOptions(row.chat_id).receipts;
  if (!expected || !recipientMatches(text, expected)) return { hash, reason: "получатель не совпадает" };
  const amount = findAmount(text);
  if (amount === null) return { hash, reason: "не нашёл сумму" };
  const players = (JSON.parse(row.players) as string[]).length;
  if (amount !== row.due) return { hash, reason: `сумма ${amount} ₽, нужно ${row.due} ₽ (${players} × ${getPayment(row.chat_id).amount} ₽)` };
  return { hash, reason: null };
}

/**
 * Вложения от человека: в личке (`inGroup` = false) или в общем чате. true — это
 * был чек и бот ответил; false — не чек (в общем чате бот молчит).
 */
export async function handleReceipt(chatId: number, user: MaxUser, attachments: unknown[], inGroup: boolean, caption = ""): Promise<boolean> {
  const files = attachments as Attachment[];
  const pdf = files.find((a) => a.type === "file" && /\.pdf$/i.test(a.filename ?? ""));
  // В общем чате фото — не обязательно чек: считаем чеком только с подписью про оплату.
  if (inGroup && !pdf && !/чек|оплат|перев/i.test(caption)) return false;
  const row = inGroup ? openRowIn(chatId, user.user_id) : openRowFor(user.user_id);
  const reply = (text: string) => api.sendMessageToChat(chatId, { text });
  const who = inGroup ? `${user.first_name.trim()}: ` : "";
  if (!row) {
    if (inGroup) return false;
    await reply("Неоплаченных игр нет 👍");
    return true;
  }
  const check = pdf ? await checkPdf(row, pdf) : { reason: "фото/файл вместо PDF — проверьте вручную" };
  if (!check) {
    await reply(`${who}не удалось скачать файл — пришлите PDF ещё раз.`);
    return true;
  }

  const file = pdf ?? files[0];
  const reason = db().transaction(() => {
    const current = getRow(row.id);
    if (!current || isSettled(current)) return undefined;
    let note = check.reason;
    if (check.hash && !db().prepare("INSERT OR IGNORE INTO receipts (hash, chat_id, payer_id, at) VALUES (?, ?, ?, ?)")
      .run(check.hash, row.chat_id, user.user_id, Date.now()).changes) note = "этот чек уже присылали";
    if (note === null) {
      updateRow(row.id, { status: "paid", paid: row.due, note: null });
    } else {
      updateRow(row.id, { status: "review", note, file_type: file?.type ?? null, file_token: file?.payload?.token ?? null });
    }
    return note;
  })();
  if (reason === undefined) return true;
  await refreshLedgerMessage(row.chat_id, row.game_date);
  await reply(reason === null
    ? `✅ ${who}оплата ${row.due} ₽ за игру ${shortDate(row.game_date)} принята.`
    : `🧾 ${who}чек на ручной проверке (${reason}).`)
    .catch((err) => console.warn("[receipts] результат сохранён, ответ пользователю не отправлен:", err));
  return true;
}
