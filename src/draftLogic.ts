import { getChatOptions } from "./settingsStore";
import { NOT_ADMIN } from "./format";
import * as api from "./maxApi";
import { InlineKeyboardAttachment, KeyboardButton } from "./maxApi";
import { ensurePlayerIds, isChatAdmin, playerKey } from "./sessionLogic";
import { getSession, setSession } from "./store";
import { ButtonAction, Draft, FootballSession, Player } from "./types";
import { escapeHtml, paymentDetailsLine, paymentHeader, paymentPayerLines } from "./messageFormatter";
import { ensureLedger, receiptsEnabled } from "./paymentLedger";
import { completeTeams, hasEnoughPlayers, MIN_GAME_PLAYERS, PLAYERS_PER_TEAM, usesTeamFormat } from "./gameAttendance";

/**
 * Дележка на команды:
 *  1. бот определяет число команд по пять, админ отмечает капитанов
 *     (или вводит их номера: /дележка 2 5);
 *  2. капитаны по очереди выбирают игроков основы кнопками
 *     под сообщением; нажать может сам капитан (тот, кто записывался под этим
 *     именем) или админ — если капитана записали «за друга»;
 *  3. когда места заполнены — бот показывает составы и замены.
 * Резерв в дележке не участвует. /дележка сброс — отменить.
 */

export const DRAFT_RE = /^\/(дележка|делёжка|draft)(?:\s+([\s\S]+))?$/i;
export const TEAMS_RE = /^\/(составы|состав|команды|teams)$/i;

const TEAM_ICON = ["⚪", "⚫", "🔵"];

const teamCount = (draft: Draft) => draft.teamCount ?? 2;

const btn = (text: string, action: ButtonAction): KeyboardButton => ({ type: "callback", text, payload: JSON.stringify(action) });
const kb = (rows: KeyboardButton[][]): InlineKeyboardAttachment => ({ type: "inline_keyboard", payload: { buttons: rows } });

const mainPlayers = (s: FootballSession) => s.players.filter((p) => !p.isReserve);
const byKey = (s: FootballSession, k: string): Player | undefined => s.players.find((p) => playerKey(p) === k);
const nameOf = (s: FootballSession, k: string) => byKey(s, k)?.displayName ?? "(выбыл)";

function remaining(s: FootballSession, d: Draft): Player[] {
  const taken = new Set([...d.captains, ...d.picks.map((p) => p.k)]);
  return mainPlayers(s).filter((p) => !taken.has(playerKey(p)));
}

function picksLeft(s: FootballSession, d: Draft): number {
  return d.teamCount
    ? d.teamCount * (PLAYERS_PER_TEAM - 1) - d.picks.length
    : remaining(s, d).length;
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
  for (let t = 0; t < teamCount(d); t++) {
    const members = [d.captains[t], ...d.picks.filter((p) => p.team === t).map((p) => p.k)].filter((k) => byKey(s, k));
    if (t > 0) lines.push("");
    lines.push(`${TEAM_ICON[t]} Команда ${t + 1}, Кэп: ${nameOf(s, d.captains[t])}`);
    members.forEach((k, i) => lines.push(`${i + 1}. ${nameOf(s, k)}`));
  }
  if (d.teamCount && d.stage === "done") {
    const substitutes = remaining(s, d);
    if (substitutes.length) {
      lines.push("", "🔄 Замены", ...substitutes.map((player, index) => `${index + 1}. ${player.displayName}`));
    }
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
        `Админ, выберите ${teamCount(d)} капитанов из основы${chosen.length ? ` (выбраны: ${chosen.join(", ")})` : ""}.`,
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
      ...(getChatOptions(s.chatId).payment && hasEnoughPlayers(s)
        ? ["", paymentHeader(s.chatId, s.date), paymentDetailsLine(s.chatId), ...paymentPayerLines(s)] : []),
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
  const res = await api.sendMessageToChat(chatId, { ...render(s), notify: false }); // перепост — без уведомления
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
  d.stage = picksLeft(s, d) ? "picking" : "done";
  d.turn = 0;
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
  const modern = usesTeamFormat(s);
  const minimum = modern ? MIN_GAME_PLAYERS : 4;
  if (main.length < minimum) return `Для дележки нужно ${minimum} игроков в основе, сейчас ${main.length}.`;

  const draft: Draft = { stage: "captains", captains: [], picks: [], turn: 0, messageId: null };
  if (modern) draft.teamCount = completeTeams(s);
  if (a) {
    const numbers = a.split(/\s+/);
    const indices = numbers.map((number) => Number(number) - 1);
    const count = teamCount(draft);
    if (indices.length !== count || new Set(indices).size !== count ||
        numbers.some((number) => !/^\d+$/.test(number)) || indices.some((index) => !main[index])) {
      return `Укажите ${count} разных номера игроков основы (1–${main.length}), например /дележка ${count === 2 ? "2 5" : "2 5 8"}.`;
    }
    draft.captains = indices.map((index) => playerKey(main[index]));
    beginPicking(s, draft);
  }
  if (s.draft?.messageId) await api.deleteMessage(chatId, s.draft.messageId).catch(() => undefined);
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

  if (d.teamCount && d.stage !== "done") {
    const pool = new Set(mainPlayers(s).map(playerKey));
    if (completeTeams(s) !== d.teamCount || [...d.captains, ...d.picks.map((pick) => pick.k)].some((key) => !pool.has(key))) {
      return "Состав основы изменился. Админ может запустить /дележка заново.";
    }
  }

  if (action.a === "dr_cap") {
    if (d.stage !== "captains") return "Капитаны уже выбраны";
    if (!(await isChatAdmin(chatId, userId))) return "Капитанов назначает админ";
    if (!mainPlayers(s).some((player) => playerKey(player) === action.k) || d.captains.includes(action.k)) return "Этого игрока нельзя выбрать";
    d.captains.push(action.k);
    const ready = d.captains.length === teamCount(d);
    if (ready) beginPicking(s, d);
    await show(s);
    return ready ? "Капитаны назначены — первым выбирает ⚪" : "Выберите следующего капитана";
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
    d.turn = d.picks.length % teamCount(d);
    const left = remaining(s, d);
    if (left.length === 1 && picksLeft(s, d) === 1) {
      d.picks.push({ k: playerKey(left[0]), team: d.turn });
    }
    if (picksLeft(s, d) === 0) {
      d.stage = "done";
      // Инициализируем payment ledger сразу при завершении дележки
      if (receiptsEnabled(chatId)) {
        ensureLedger(s);
      }
    }
    await show(s);
    // Отправляем подсказку о возможности загрузки чеков
    if (d.stage === "done" && receiptsEnabled(chatId) && hasEnoughPlayers(s)) {
      await api.sendMessageToChat(chatId, {
        text: "💡 Можете сразу загружать чеки об оплате! Используйте /оплата_список для просмотра должников.",
        notify: false
      }).catch(() => undefined);
    }
    return d.stage === "done" ? "Составы готовы!" : `${nameOf(s, action.k)} — в команде`;
  }
  return "Готово";
}
