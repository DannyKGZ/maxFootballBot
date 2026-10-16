import { createHash } from "crypto";
import { config } from "./config";
import { db } from "./db";
import * as api from "./maxApi";
import {
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
 *    чата) и сумму: она должна быть равна «сколько человек записал в основу × цена»
 *    (1 — 350 ₽, 2 — 700 ₽ …). Сошлось — оплачено (✅), иначе — ручная проверка;
 *  - фото (или другой файл) — сразу ручная проверка;
 * ручная проверка: админам в личку причина и файл, в списке «⏳ на проверке»,
 * человека больше не упоминают. Наличные админ отмечает: /оплатил N.
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

const num = (s: string) => Number(s.replace(/[\s  ]/g, ""));

/** Сумма перевода из текста чека: «Сумма 1 050 ₽», иначе «Итого …», иначе первая сумма с ₽. */
export function findAmount(text: string): number | null {
  const money = String.raw`(\d{1,3}(?:[\s  ]?\d{3})*|\d+)(?:[.,]\d{1,2})?\s*(?:₽|руб|RUB|р\.)`;
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

async function notifyAdmins(row: PaymentRow, reason: string, file?: Attachment): Promise<void> {
  let admins: number[] = [];
  try {
    admins = (await api.getChatAdmins(row.chat_id)).members.filter((m) => !m.is_bot).map((m) => m.user_id);
  } catch {
    return;
  }
  const text = `🧾 На проверку: ${row.payer_name} (${row.payer_profile}), игра ${shortDate(row.game_date)}, долг ${row.due} ₽.\nПричина: ${reason}.\nОплата верна — /должники, затем /оплатил <номер>.`;
  for (const id of admins.filter((a) => a !== row.payer_id)) {
    await api.sendMessageToUser(id, { text }).catch(() => undefined);
    if (file?.payload?.token) {
      await api
        .sendMessageToUser(id, { attachments: [{ type: file.type ?? "file", payload: { token: file.payload.token } } as never] })
        .catch(() => undefined);
    }
  }
}

/** Неоплаченная строка этого человека в конкретном чате (самая свежая игра). */
function openRowIn(chatId: number, userId: number): PaymentRow | undefined {
  return db()
    .prepare("SELECT * FROM payments WHERE chat_id = ? AND payer_id = ? AND status NOT IN ('paid', 'manual') ORDER BY game_date DESC LIMIT 1")
    .get(chatId, userId) as PaymentRow | undefined;
}

async function downloadPdf(url: string): Promise<Uint8Array> {
  let res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  // Если ссылка MAX требует авторизации — повторяем с токеном бота.
  if (res.status === 401 || res.status === 403) res = await fetch(url, { headers: { Authorization: config.botToken }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_PDF_BYTES) throw new Error("файл больше 10 МБ");
  return bytes;
}

/** Проверка PDF → null (оплачено) или причина для ручной проверки. */
async function checkPdf(row: PaymentRow, pdf: Attachment, userId: number): Promise<string | null | "download_failed"> {
  let bytes: Uint8Array;
  try {
    bytes = await downloadPdf(pdf.payload?.url ?? "");
  } catch (err) {
    console.warn("[receipts] не удалось скачать PDF:", err instanceof Error ? err.message : err);
    return "download_failed";
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (db().prepare("SELECT 1 FROM receipts WHERE hash = ?").get(hash)) return "этот чек уже присылали";
  let text = "";
  try {
    text = await pdfText(bytes);
  } catch (err) {
    console.warn("[receipts] не удалось прочитать PDF:", err instanceof Error ? err.message : err);
  }
  if (!text.trim()) return "в PDF нет текста (скан?)";
  db().prepare("INSERT OR IGNORE INTO receipts (hash, chat_id, payer_id, at) VALUES (?, ?, ?, ?)").run(hash, row.chat_id, userId, Date.now());
  if (!recipientMatches(text, getChatOptions(row.chat_id).receipts!)) return "получатель не совпадает";
  const amount = findAmount(text);
  if (amount === null) return "не нашёл сумму";
  const players = (JSON.parse(row.players) as string[]).length;
  if (amount !== row.due) return `сумма ${amount} ₽, нужно ${row.due} ₽ (${players} × ${getPayment(row.chat_id).amount} ₽)`;
  return null;
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
  console.log(`[receipts] ${user.user_id}: вложения ${JSON.stringify(files.map((f) => ({ type: f.type, filename: f.filename })))}`);

  const reason = pdf ? await checkPdf(row, pdf, user.user_id) : "фото/файл вместо PDF — проверьте вручную";
  if (reason === "download_failed") {
    await reply(`${who}не удалось скачать файл — пришлите PDF ещё раз.`);
    return true;
  }
  if (reason) {
    updateRow(row.id, { status: "review", note: reason });
    await refreshLedgerMessage(row.chat_id, row.game_date);
    await notifyAdmins(row, reason, pdf ?? files[0]);
    await reply(`🧾 ${who}чек на ручной проверке (${reason}). Напоминаний больше не будет.`);
    console.log(`[receipts] ${user.user_id}: на проверку — ${reason}`);
    return true;
  }
  updateRow(row.id, { status: "paid", paid: row.due, note: null });
  await refreshLedgerMessage(row.chat_id, row.game_date);
  await reply(`✅ ${who}оплата ${row.due} ₽ за игру ${shortDate(row.game_date)} принята.`);
  console.log(`[receipts] ${user.user_id}: чек на ${row.due} ₽ принят (игра ${row.game_date})`);
  return true;
}
