import { createHash } from "crypto";
import { config } from "./config";
import { db } from "./db";
import * as api from "./maxApi";
import { KeyboardButton } from "./maxApi";
import {
  PaymentRow,
  getRow,
  isSettled,
  ledgerRows,
  receiptsEnabled,
  refreshLedgerMessage,
  shortDate,
  updateRow,
} from "./paymentLedger";
import { getChatOptions, getPayment } from "./settingsStore";
import { ButtonAction, MaxUser } from "./types";

/**
 * PDF-чек об оплате в личке с ботом. Бот находит неоплаченную игру этого
 * человека, читает текст PDF и проверяет:
 *  - получатель — телефон или имя из настроек чата (getChatOptions().receipts);
 *  - сумма кратна цене игры (350, 700, 1050 … ₽) — тогда оплачено сразу;
 *    заплатил больше, чем за своих, — бот предложит отметить, за кого ещё.
 * Иначе (другая сумма, другой получатель, не нашлась сумма, повторный чек) —
 * на ручную проверку админам. Не PDF — просьба прислать PDF. В обоих случаях
 * человека больше не упоминают в напоминаниях; в /должниках он остаётся.
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
  const text = `🧾 Чек на ручную проверку: ${row.payer_name} (${row.payer_profile}) — игра ${shortDate(row.game_date)}, должен ${row.due} ₽.\nПричина: ${reason}.\nЕсли оплата в порядке — отметьте: /должники, затем /оплатил <номер>.`;
  for (const id of admins.filter((a) => a !== row.payer_id)) {
    await api.sendMessageToUser(id, { text }).catch(() => undefined);
    if (file?.payload?.token) {
      await api
        .sendMessageToUser(id, { attachments: [{ type: "file", payload: { token: file.payload.token } } as never] })
        .catch(() => undefined);
    }
  }
}

const creditKey = (userId: number) => `rcpt_credit:${userId}`;

function creditButtons(row: PaymentRow, left: number): KeyboardButton[][] {
  const others = ledgerRows(row.chat_id, row.game_date).filter((r) => r.id !== row.id && !isSettled(r) && r.due - r.paid <= left);
  const btn = (text: string, action: ButtonAction): KeyboardButton => ({ type: "callback", text, payload: JSON.stringify(action) });
  return [...others.map((r) => [btn(`${r.payer_name} — ${r.due - r.paid} ₽`, { a: "rcpt_for", r: r.id })]), [btn("Готово", { a: "rcpt_done" })]];
}

/** Личка: пришли вложения (файл, фото…). true — обработано как чек. */
export async function handleDmAttachments(dmChatId: number, user: MaxUser, attachments: unknown[]): Promise<boolean> {
  const row = openRowFor(user.user_id);
  const reply = (text: string, buttons?: KeyboardButton[][]) =>
    api.sendMessageToChat(dmChatId, { text, attachments: buttons ? [{ type: "inline_keyboard", payload: { buttons } }] : undefined });
  if (!row) {
    await reply("Неоплаченных игр за вами не нашёл — всё в порядке 👍");
    return true;
  }
  const files = attachments as Attachment[];
  console.log(`[receipts] ${user.user_id}: вложения ${JSON.stringify(files.map((f) => ({ type: f.type, filename: f.filename, keys: Object.keys(f.payload ?? {}) })))}`);
  const pdf = files.find((a) => a.type === "file" && /\.pdf$/i.test(a.filename ?? ""));
  if (!pdf) {
    if (row.status === "unpaid") {
      updateRow(row.id, { status: "wrong_file" });
      await refreshLedgerMessage(row.chat_id, row.game_date);
    }
    await reply("Нужен PDF-файл с чеком об оплате. В приложении банка откройте перевод → «Квитанция»/«Чек» → «Поделиться» → сохраните или отправьте PDF сюда.");
    console.log(`[receipts] ${user.user_id}: прислал не PDF (${files.map((a) => a.type).join(",")})`);
    return true;
  }

  const expected = getChatOptions(row.chat_id).receipts!;
  const unit = getPayment(row.chat_id).amount;
  const toReview = async (reason: string) => {
    updateRow(row.id, { status: "review", note: reason });
    await refreshLedgerMessage(row.chat_id, row.game_date);
    await notifyAdmins(row, reason, pdf);
    await reply(`🧾 Чек получил, но проверить автоматически не вышло (${reason}). Передал админу на ручную проверку — больше напоминать не буду.`);
    console.log(`[receipts] ${user.user_id}: на проверку — ${reason}`);
  };

  let bytes: Uint8Array;
  try {
    const url = pdf.payload?.url ?? "";
    let res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    // Если ссылка MAX требует авторизации — повторяем с токеном бота.
    if (res.status === 401 || res.status === 403) res = await fetch(url, { headers: { Authorization: config.botToken }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_PDF_BYTES) throw new Error("файл больше 10 МБ");
  } catch (err) {
    console.warn("[receipts] не удалось скачать PDF:", err instanceof Error ? err.message : err);
    await reply("Не удалось скачать файл — пришлите PDF-чек ещё раз, пожалуйста.");
    return true;
  }

  const hash = createHash("sha256").update(bytes).digest("hex");
  if (db().prepare("SELECT 1 FROM receipts WHERE hash = ?").get(hash)) {
    await toReview("этот чек уже присылали");
    return true;
  }
  let text = "";
  try {
    text = await pdfText(bytes);
  } catch (err) {
    console.warn("[receipts] не удалось прочитать PDF:", err instanceof Error ? err.message : err);
  }
  if (!text.trim()) return (await toReview("в PDF нет текста"), true);
  db().prepare("INSERT OR IGNORE INTO receipts (hash, chat_id, payer_id, at) VALUES (?, ?, ?, ?)").run(hash, row.chat_id, user.user_id, Date.now());

  if (!recipientMatches(text, expected)) return (await toReview("получатель не совпадает"), true);
  const amount = findAmount(text);
  if (amount === null) return (await toReview("не нашёл сумму"), true);
  if (amount <= 0 || amount % unit !== 0) return (await toReview(`сумма ${amount} ₽, а за игру ${unit} ₽ с игрока`), true);

  // Сумма кратна цене игры — засчитываем: сначала свой долг, остаток — за других.
  const paid = Math.min(row.due, row.paid + amount);
  let left = row.paid + amount - paid;
  updateRow(row.id, { status: paid >= row.due ? "paid" : "unpaid", paid, note: null });
  await refreshLedgerMessage(row.chat_id, row.game_date);
  console.log(`[receipts] ${user.user_id}: чек на ${amount} ₽ принят (игра ${row.game_date})`);
  if (paid < row.due) {
    await reply(`✅ Чек на ${amount} ₽ принят. Осталось оплатить ${row.due - paid} ₽ — пришлите ещё чек.`);
    return true;
  }
  if (left > 0) {
    db().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(creditKey(user.user_id), JSON.stringify({ rowId: row.id, left }));
    const buttons = creditButtons(row, left);
    if (buttons.length > 1) {
      await reply(`✅ Оплата принята: ${amount} ₽, из них ${row.due} ₽ — за вас. Осталось ${left} ₽ — за кого ещё вы заплатили? Нажмите на игроков:`, buttons);
      return true;
    }
    left = 0;
  }
  await reply(`✅ Оплата ${amount} ₽ за игру ${shortDate(row.game_date)} принята — спасибо! В списке вы отмечены.`);
  return true;
}

export function isReceiptAction(action: ButtonAction): boolean {
  return action.a === "rcpt_for" || action.a === "rcpt_done";
}

/** Кнопки «за кого ещё оплатил» в личке. */
export async function handleReceiptAction(dmChatId: number, userId: number, action: ButtonAction, messageId?: string): Promise<string> {
  const raw = db().prepare("SELECT value FROM meta WHERE key = ?").get(creditKey(userId)) as { value: string } | undefined;
  const credit = raw ? (JSON.parse(raw.value) as { rowId: number; left: number }) : null;
  const own = credit ? getRow(credit.rowId) : undefined;
  const finish = async (text: string) => {
    db().prepare("DELETE FROM meta WHERE key = ?").run(creditKey(userId));
    if (messageId) await api.editMessage(dmChatId, messageId, { text, attachments: [] }).catch(() => undefined);
  };
  if (!credit || !own) return "Уже готово";
  if (action.a === "rcpt_done") {
    await finish(`✅ Готово. Оплата отмечена${credit.left > 0 ? ` (не распределено ${credit.left} ₽)` : ""}.`);
    return "Готово";
  }
  if (action.a !== "rcpt_for") return "Готово";
  const other = getRow(action.r);
  if (!other || other.chat_id !== own.chat_id || other.game_date !== own.game_date || isSettled(other)) return "Этот игрок уже отмечен";
  const need = other.due - other.paid;
  if (need > credit.left) return `Не хватает: за ${other.payer_name} нужно ${need} ₽, осталось ${credit.left} ₽`;
  updateRow(other.id, { status: "paid", paid: other.due, note: `оплатил ${own.payer_name}` });
  credit.left -= need;
  await refreshLedgerMessage(own.chat_id, own.game_date);
  if (credit.left <= 0) {
    await finish(`✅ Готово: отмечены вы и ${other.payer_name}.`);
    return `${other.payer_name} — оплачено`;
  }
  db().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(creditKey(userId), JSON.stringify(credit));
  if (messageId) {
    await api
      .editMessage(dmChatId, messageId, {
        text: `Отмечен ${other.payer_name}. Осталось ${credit.left} ₽ — за кого ещё?`,
        attachments: [{ type: "inline_keyboard", payload: { buttons: creditButtons(own, credit.left) } }],
      })
      .catch(() => undefined);
  }
  return `${other.payer_name} — оплачено`;
}
