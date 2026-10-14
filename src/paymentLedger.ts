import { db } from "./db";
import * as api from "./maxApi";
import { escapeHtml, gameTimeOf, mention, paymentDetailsLine } from "./messageFormatter";
import { getChatOptions, getPayment } from "./settingsStore";
import { FootballSession } from "./types";

/**
 * Учёт оплаты игры (для чатов с проверкой чеков — getChatOptions().receipts):
 * после игры у каждого, кто записывал игроков основы, строка «сколько должен и
 * оплатил ли». Оплату отмечает проверка PDF-чека (receiptLogic.ts) или админ
 * (/оплатил N). Сообщение «💰 Оплата» в чате — живой список: обновляется при каждой
 * оплате, упоминает только тех, кто ещё ничего не прислал. /должники — помесячно.
 */

export type PayStatus = "unpaid" | "paid" | "review" | "wrong_file" | "manual";

export interface PaymentRow {
  id: number;
  chat_id: number;
  game_date: string;
  payer_id: number;
  payer_name: string;
  payer_profile: string;
  players: string; // JSON string[]
  due: number;
  paid: number;
  status: PayStatus;
  note: string | null;
}

export const receiptsEnabled = (chatId: number) => Boolean(getChatOptions(chatId).receipts);
export const isSettled = (r: PaymentRow) => r.status === "paid" || r.status === "manual";
const WEEKDAYS = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
const pad = (n: number) => String(n).padStart(2, "0");
export const shortDate = (iso: string) => {
  const d = new Date(iso);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
};

export function ledgerRows(chatId: number, gameDate: string): PaymentRow[] {
  return db().prepare("SELECT * FROM payments WHERE chat_id = ? AND game_date = ? ORDER BY id").all(chatId, gameDate) as PaymentRow[];
}

export function getRow(id: number): PaymentRow | undefined {
  return db().prepare("SELECT * FROM payments WHERE id = ?").get(id) as PaymentRow | undefined;
}

/** Строки учёта игры (создаются один раз — по основе на момент первого напоминания об оплате). */
export function ensureLedger(session: FootballSession): PaymentRow[] {
  const existing = ledgerRows(session.chatId, session.date);
  if (existing.length) return existing;
  const unit = getPayment(session.chatId).amount;
  const main = session.players.filter((p) => !p.isReserve);
  const byUser = new Map<number, typeof main>();
  for (const p of main) byUser.set(p.userId, [...(byUser.get(p.userId) ?? []), p]);
  const insert = db().prepare(
    "INSERT OR IGNORE INTO payments (chat_id, game_date, payer_id, payer_name, payer_profile, players, due, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  db().transaction(() => {
    for (const [userId, players] of byUser) {
      const self = players.find((p) => p.profileName) ?? players[0];
      const name = self.profileName ? self.displayName : (self.addedByName ?? self.displayName);
      const profile = self.profileName ?? self.addedByFullName ?? self.addedByName ?? self.displayName;
      insert.run(session.chatId, session.date, userId, name, profile, JSON.stringify(players.map((p) => p.displayName)), players.length * unit, Date.now());
    }
  })();
  return ledgerRows(session.chatId, session.date);
}

export function updateRow(id: number, patch: Partial<Pick<PaymentRow, "status" | "paid" | "note">>): void {
  const row = getRow(id);
  if (!row) return;
  const next = { ...row, ...patch };
  db()
    .prepare("UPDATE payments SET status = ?, paid = ?, note = ?, updated_at = ? WHERE id = ?")
    .run(next.status, next.paid, next.note, Date.now(), id);
}

/** Строка участника в списке оплаты. Упоминаем только тех, от кого ещё ничего нет. */
function rowLine(r: PaymentRow): string {
  const players = JSON.parse(r.players) as string[];
  const who = players.length > 1 || players[0] !== r.payer_name ? ` (${players.map(escapeHtml).join(", ")})` : "";
  const name = escapeHtml(r.payer_name);
  switch (r.status) {
    case "paid":
    case "manual":
      return `✅ ${name} — ${r.due} ₽${who}`;
    case "review":
      return `⏳ ${name} — ${r.due} ₽${who} — чек на проверке`;
    case "wrong_file":
      return `📎 ${name} — ${r.due} ₽${who} — ждём PDF-чек`;
    default:
      return `❌ ${mention(r.payer_id, r.payer_profile)} — ${r.due} ₽${who}${r.paid ? ` (оплачено ${r.paid})` : ""}`;
  }
}

/** Сообщение «💰 Оплата» со списком (format: html). */
export function buildLedgerText(chatId: number, gameDate: string, after: boolean): string {
  const rows = ledgerRows(chatId, gameDate);
  const date = new Date(gameDate);
  const fakeSession = { chatId, date: gameDate } as FootballSession;
  const done = rows.filter(isSettled).length;
  return [
    `💰 Оплата за игру ${WEEKDAYS[date.getDay()]} ${shortDate(gameDate)}.${date.getFullYear()}, ${gameTimeOf(fakeSession)}${after ? " — игра прошла, не забудьте оплатить" : ""}`,
    paymentDetailsLine(chatId),
    "📄 После оплаты пришлите боту в личку <b>PDF-чек</b> из банка (откройте личный чат с ботом и прикрепите файл) — бот проверит и отметит вас.",
    "",
    `Оплатили: ${done} из ${rows.length}`,
    ...rows.map(rowLine),
  ].join("\n");
}

const msgKey = (chatId: number, gameDate: string) => `pay_msg:${chatId}:${gameDate}`;

export function setLedgerMessage(chatId: number, gameDate: string, mid: string, after: boolean): void {
  db().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(msgKey(chatId, gameDate), JSON.stringify({ mid, after }));
}

/** Перерисовать сообщение «💰 Оплата» этой игры (после оплаты/отметки админом). */
export async function refreshLedgerMessage(chatId: number, gameDate: string): Promise<void> {
  const row = db().prepare("SELECT value FROM meta WHERE key = ?").get(msgKey(chatId, gameDate)) as { value: string } | undefined;
  if (!row) return;
  const { mid, after } = JSON.parse(row.value) as { mid: string; after: boolean };
  await api
    .editMessage(chatId, mid, { text: buildLedgerText(chatId, gameDate, after), format: "html" })
    .catch((err) => console.warn("[payments] не удалось обновить список оплаты:", err instanceof Error ? err.message : err));
}

// ---- /должники и /оплатил ----

const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];

/** Месяц для /должники: «» — текущий, «9» / «сентябрь» — этот месяц (последний прошедший такой), «все» — все. */
export function parseMonth(arg: string | undefined, now = new Date()): { from: Date; to: Date; label: string } | "all" | null {
  const a = (arg ?? "").trim().toLowerCase();
  if (a === "все" || a === "all") return "all";
  let month = now.getMonth();
  if (a) {
    const n = Number(a);
    const byName = MONTHS.findIndex((m) => m.startsWith(a.slice(0, 3)));
    if (Number.isInteger(n) && n >= 1 && n <= 12) month = n - 1;
    else if (byName >= 0 && a.length >= 3) month = byName;
    else return null;
  }
  const year = month > now.getMonth() ? now.getFullYear() - 1 : now.getFullYear();
  return { from: new Date(year, month, 1), to: new Date(year, month + 1, 1), label: `${MONTHS[month]} ${year}` };
}

/** Должники: кто не оплатил (в т.ч. чек на проверке или не PDF), по дате игры. */
export function debtors(chatId: number, period: ReturnType<typeof parseMonth>): PaymentRow[] {
  const rows = db()
    .prepare("SELECT * FROM payments WHERE chat_id = ? AND status NOT IN ('paid', 'manual') ORDER BY game_date, id")
    .all(chatId) as PaymentRow[];
  if (!period || period === "all") return rows;
  return rows.filter((r) => {
    const t = new Date(r.game_date).getTime();
    return t >= period.from.getTime() && t < period.to.getTime();
  });
}

/** «3. Денис (Денис Шатров) — 350 ₽ — 18.10 · чек на проверке» */
export function debtorLine(r: PaymentRow, i: number): string {
  const players = JSON.parse(r.players) as string[];
  const forWhom = players.length > 1 || players[0] !== r.payer_name ? `, за: ${players.join(", ")}` : "";
  const note =
    r.status === "review" ? ` · ⏳ чек на проверке${r.note ? `: ${r.note}` : ""}` : r.status === "wrong_file" ? " · 📎 прислал не PDF" : r.paid ? ` · оплачено ${r.paid} из ${r.due}` : "";
  return `${i + 1}. ${r.payer_name} (${r.payer_profile}) — ${r.due} ₽${forWhom} — ${shortDate(r.game_date)}${note}`;
}
