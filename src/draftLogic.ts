import * as api from "./maxApi";
import { InlineKeyboardAttachment, KeyboardButton } from "./maxApi";
import { ensurePlayerIds, isChatAdmin, playerKey } from "./sessionLogic";
import { getSession, setSession } from "./store";
import { ButtonAction, Draft, FootballSession, Player } from "./types";
import { escapeHtml, paymentDetailsLine, paymentPayerLines } from "./messageFormatter";

/**
 * Дележка на команды:
 *  1. админ пишет /дележка — бот публикует основу кнопками, админ отмечает двух
 *     капитанов (или сразу: /дележка 2 5 — номера в списке);
 *  2. капитаны по очереди, по одному (⚪ ⚫ ⚪ ⚫ …), выбирают игроков основы кнопками
 *     под сообщением; нажать может сам капитан (тот, кто записывался под этим
 *     именем) или админ — если капитана записали «за друга»;
 *  3. когда игроки кончились — бот показывает составы; /составы — показать снова.
 * Резерв в дележке не участвует. /дележка сброс — отменить.
 */

export const DRAFT_RE = /^\/(дележка|делёжка|draft)(?:\s+([\s\S]+))?$/i;
export const TEAMS_RE = /^\/(составы|состав|команды|teams)$/i;

const TEAM_ICON = ["⚪", "⚫"];

/** Очерёдность по одному: ⚪ ⚫ ⚪ ⚫ … — по номеру выбора (0, 1, 2, …) чья очередь. */
export const turnForPick = (pickIndex: number): 0 | 1 => (pickIndex % 2 === 0 ? 0 : 1);
const NOT_ADMIN = "Эта команда доступна только администраторам чата.";

const btn = (text: string, action: ButtonAction): KeyboardButton => ({ type: "callback", text, payload: JSON.stringify(action) });
const kb = (rows: KeyboardButton[][]): InlineKeyboardAttachment => ({ type: "inline_keyboard", payload: { buttons: rows } });

const mainPlayers = (s: FootballSession) => s.players.filter((p) => !p.isReserve);
const byKey = (s: FootballSession, k: string): Player | undefined => s.players.find((p) => playerKey(p) === k);
const nameOf = (s: FootballSession, k: string) => byKey(s, k)?.displayName ?? "(выбыл)";

function remaining(s: FootballSession, d: Draft): Player[] {
  const taken = new Set([...d.captains, ...d.picks.map((p) => p.k)]);
  return mainPlayers(s).filter((p) => !taken.has(playerKey(p)));
}

/**
 * Составы столбиком:
 *   ⚪ Команда 1, Кэп: Руслан
 *   1. Руслан
 *   2. Рома
 *
 *   ⚫ Команда 2, Кэп: Игорь
 *   1. Игорь
 */
function teamLines(s: FootballSession, d: Draft): string[] {
  const lines: string[] = [];
  for (const t of [0, 1] as const) {
    const members = [d.captains[t], ...d.picks.filter((p) => p.team === t).map((p) => p.k)].filter((k) => byKey(s, k));
    if (t === 1) lines.push("");
    lines.push(`${TEAM_ICON[t]} Команда ${t + 1}, Кэп: ${nameOf(s, d.captains[t])}`);
    members.forEach((k, i) => lines.push(`${i + 1}. ${nameOf(s, k)}`));
  }
  return lines;
}

/** Текст составов (для /составы и /статус); null — дележки ещё не было. */
export function teamsText(s: FootballSession): string | null {
  const d = s.draft;
  if (!d || d.stage === "captains") return null;
  return [d.stage === "done" ? "⚽ Составы:" : "⚽ Идёт дележка:", "", ...teamLines(s, d)].join("\n");
}

function render(s: FootballSession): { text: string; format?: "html"; attachments: InlineKeyboardAttachment[] } {
  const d = s.draft!;
  const cancel = [btn("✖️ Отменить дележку (админ)", { a: "dr_cancel" })];
  if (d.stage === "captains") {
    const chosen = d.captains.map((k) => nameOf(s, k));
    const options = mainPlayers(s).filter((p) => !d.captains.includes(playerKey(p)));
    return {
      text: [
        "⚽ Дележка на команды",
        `Админ, выберите двух капитанов из основы${chosen.length ? ` (выбран: ${chosen.join(", ")})` : ""}.`,
      ].join("\n"),
      attachments: [kb([...options.map((p) => [btn(`👑 ${p.displayName}`, { a: "dr_cap", k: playerKey(p) })]), cancel])],
    };
  }
  if (d.stage === "picking") {
    const left = remaining(s, d);
    return {
      text: [
        "⚽ Дележка на команды",
        "",
        ...teamLines(s, d),
        "",
        `Выбирает ${TEAM_ICON[d.turn]} Команда ${d.turn + 1} (кэп ${nameOf(s, d.captains[d.turn])}) — нажмите на игрока.`,
      ].join("\n"),
      attachments: [kb([...left.map((p) => [btn(p.displayName, { a: "dr_pick", k: playerKey(p) })]), cancel])],
    };
  }
  // Составы готовы: ниже — напоминание об оплате с упоминанием игроков (кто записывал — тот и платит).
  return {
    text: [
      "⚽ Составы готовы!",
      "",
      ...teamLines(s, d).map(escapeHtml),
      "",
      `💰 ${paymentDetailsLine(s.chatId)}`,
      ...paymentPayerLines(s),
    ].join("\n"),
    format: "html",
    attachments: [],
  };
}

/** Опустить сообщение дележки вниз чата: новое внизу, старое удаляется (stickyLogic.ts). */
export async function repostDraftMessage(chatId: number): Promise<void> {
  const s = getSession(chatId);
  if (!s?.draft) return;
  const old = s.draft.messageId;
  const res = await api.sendMessageToChat(chatId, render(s));
  s.draft.messageId = res.message.body.mid;
  setSession(s);
  if (old) await api.deleteMessage(chatId, old).catch(() => api.editMessage(chatId, old, { text: "⚽ Дележка — актуальное сообщение ниже ⬇️", attachments: [] }).catch(() => undefined));
}

async function show(s: FootballSession): Promise<void> {
  const d = s.draft!;
  const view = render(s);
  if (d.messageId) {
    try {
      await api.editMessage(s.chatId, d.messageId, view);
      setSession(s);
      return;
    } catch {
      // сообщение дележки удалили — опубликуем заново
    }
  }
  const res = await api.sendMessageToChat(s.chatId, view);
  d.messageId = res.message.body.mid;
  setSession(s);
}

/** Капитаны выбраны — начинаем выбор; если выбирать некого, сразу готово. */
function beginPicking(s: FootballSession, d: Draft): void {
  d.stage = remaining(s, d).length ? "picking" : "done";
  d.turn = turnForPick(d.picks.length);
}

/** /дележка, /дележка 2 5, /дележка сброс → текст ответа (пусто — бот уже показал сообщение дележки). */
export async function draftCommand(chatId: number, userId: number, arg?: string): Promise<string> {
  if (!(await isChatAdmin(chatId, userId))) return NOT_ADMIN;
  const s = getSession(chatId);
  if (!s) return "Сейчас записи нет — делить некого.";
  ensurePlayerIds(s);
  const a = arg?.trim() ?? "";

  if (/^(сброс|отмена|reset)$/i.test(a)) {
    if (!s.draft) return "Дележки нет.";
    if (s.draft.messageId) await api.deleteMessage(chatId, s.draft.messageId).catch(() => undefined);
    delete s.draft;
    setSession(s);
    return "Дележка отменена.";
  }

  const main = mainPlayers(s);
  if (main.length < 4) return `Для дележки нужно хотя бы 4 игрока в основе, сейчас ${main.length}.`;
  if (s.draft?.messageId) await api.deleteMessage(chatId, s.draft.messageId).catch(() => undefined);

  const draft: Draft = { stage: "captains", captains: [], picks: [], turn: 0, messageId: null };
  const nums = a.match(/^(\d+)\s+(\d+)$/);
  if (nums) {
    const [i, j] = [Number(nums[1]) - 1, Number(nums[2]) - 1];
    if (i === j || !main[i] || !main[j]) return `Укажите два разных номера игроков основы (1–${main.length}), например: /дележка 2 5`;
    draft.captains = [playerKey(main[i]), playerKey(main[j])];
    beginPicking(s, draft);
  } else if (a) {
    return "Пример: /дележка — выбрать капитанов кнопками, /дележка 2 5 — капитаны по номерам в списке, /дележка сброс — отменить.";
  }
  s.draft = draft;
  await show(s);
  return "";
}

/** /составы — для всех. */
export function teamsCommand(chatId: number): string {
  const s = getSession(chatId);
  return (s && teamsText(s)) ?? "Дележки ещё не было — её запускает админ командой /дележка.";
}

export function isDraftAction(action: ButtonAction): boolean {
  return action.a === "dr_cap" || action.a === "dr_pick" || action.a === "dr_cancel" || action.a === "adm_draft";
}

/** Нажатия кнопок дележки в общем чате → текст всплывающего уведомления. */
export async function handleDraftAction(chatId: number, userId: number, action: ButtonAction): Promise<string> {
  const s = getSession(chatId);
  const d = s?.draft;
  if (!s || !d) return "Дележка уже закончилась или отменена";
  ensurePlayerIds(s);

  if (action.a === "dr_cancel") {
    if (!(await isChatAdmin(chatId, userId))) return "Отменить может только админ";
    await draftCommand(chatId, userId, "сброс");
    return "Дележка отменена";
  }

  if (action.a === "dr_cap") {
    if (d.stage !== "captains") return "Капитаны уже выбраны";
    if (!(await isChatAdmin(chatId, userId))) return "Капитанов назначает админ";
    if (!byKey(s, action.k) || d.captains.includes(action.k)) return "Этого игрока нельзя выбрать";
    d.captains.push(action.k);
    if (d.captains.length === 2) beginPicking(s, d);
    await show(s);
    return d.captains.length === 2 ? "Капитаны назначены — первым выбирает ⚪" : "Выберите второго капитана";
  }

  if (action.a === "dr_pick") {
    if (d.stage !== "picking") return d.stage === "done" ? "Составы уже готовы" : "Сначала админ назначает капитанов";
    const captain = byKey(s, d.captains[d.turn]);
    const isCaptain = captain?.userId === userId;
    if (!isCaptain && !(await isChatAdmin(chatId, userId))) {
      return `Сейчас выбирает ${TEAM_ICON[d.turn]} кэп ${captain?.displayName ?? "второй команды"}`;
    }
    if (!remaining(s, d).some((p) => playerKey(p) === action.k)) return "Этот игрок уже выбран";
    d.picks.push({ k: action.k, team: d.turn });
    d.turn = turnForPick(d.picks.length);
    if (remaining(s, d).length === 0) d.stage = "done";
    await show(s);
    return d.stage === "done" ? "Составы готовы!" : `${nameOf(s, action.k)} — в команде`;
  }
  return "Готово";
}
