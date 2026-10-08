import * as api from "./maxApi";
import { InlineKeyboardAttachment, KeyboardButton } from "./maxApi";
import { db } from "./db";
import { applyRoleChange, isChatAdmin } from "./sessionLogic";
import { RoleHolder, RoleKind, getRole, isRoleHolderEntry, legendUntil, setRole } from "./settingsStore";
import { getArchivedSession, getSession } from "./store";
import { ButtonAction, FootballSession, Player } from "./types";

/**
 * Роли чата — их носителя бот сам записывает в каждую новую запись:
 *  - 🏆 Легенда — всегда 1-й в списке, ровно год с назначения, одна на чат;
 *  - 👕 манишкаНосец — у кого манишки, всегда 2-й (после легенды), один на чат.
 * Назначает админ: /легенда, /манишкаНосец (или кнопки в панели) — выбор игрока
 * кнопками. МанишкаНосца после игры может отметить и сам игрок: под
 * голосованием за MVP есть кнопка «👕 Я забрал манишки» (и «↩️ Я ошибся»).
 * Из записи носитель удаляется как обычно — сам («-») или админом.
 */

export const LEGEND_RE = /^\/(легенда|legend)(?:\s+([\s\S]+))?$/i;
export const MANISKA_RE = /^\/(манишка\s*носец|манишканосец|манишки|манишка|maniska)(?:\s+([\s\S]+))?$/i;

const NOT_ADMIN = "Эта команда доступна только администраторам чата.";
const TITLE: Record<RoleKind, string> = { legend: "🏆 Легенда", maniska: "👕 манишкаНосец" };

const btn = (text: string, action: ButtonAction): KeyboardButton => ({ type: "callback", text, payload: JSON.stringify(action) });
const kb = (rows: KeyboardButton[][]): InlineKeyboardAttachment => ({ type: "inline_keyboard", payload: { buttons: rows } });
const pad = (n: number) => String(n).padStart(2, "0");
const fmtDate = (d: Date) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;

function holderText(chatId: number, kind: RoleKind): string {
  const h = getRole(chatId, kind);
  if (!h) return "никто";
  return kind === "legend" ? `${h.displayName} (до ${fmtDate(legendUntil(h))})` : h.displayName;
}

/** Кого можно назначить: все из текущей и прошлой записи (и записавшиеся сами, и записанные друзьями). */
function candidates(chatId: number): Player[] {
  const seen = new Set<string>();
  const out: Player[] = [];
  for (const s of [getSession(chatId), getArchivedSession(chatId)]) {
    for (const p of s?.players ?? []) {
      const key = p.profileName ? `${p.userId}` : `${p.userId}:${p.displayName.trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

const holderFrom = (p: Player): RoleHolder =>
  p.profileName
    ? { userId: p.userId, self: true, displayName: p.displayName, lastName: p.lastName, profileName: p.profileName, since: Date.now() }
    : {
        userId: p.userId,
        self: false,
        displayName: p.displayName,
        profileName: p.addedByFullName ?? p.addedByName ?? p.displayName,
        addedByName: p.addedByName,
        since: Date.now(),
      };

type Sender = { user_id: number; first_name: string; last_name?: string; name?: string };

/** Назначить/снять роль и поправить открытую запись. */
async function assign(chatId: number, kind: RoleKind, holder: RoleHolder | null): Promise<void> {
  const previous = getRole(chatId, kind);
  setRole(chatId, kind, holder);
  // Легенда может и сам забрать манишки: роли не мешают друг другу, в списке он один раз — 1-м.
  await applyRoleChange(chatId, kind, previous);
}

/**
 * /легенда, /манишкаНосец (только админ). `groupChatId` — чат, чью роль меняем;
 * `replyChatId` — куда прислать выбор (сам чат или личка админа). Пусто — выбор уже отправлен.
 */
export async function roleCommand(
  groupChatId: number,
  replyChatId: number,
  sender: Sender,
  kind: RoleKind,
  arg?: string,
): Promise<string> {
  const userId = sender.user_id;
  if (!(await isChatAdmin(groupChatId, userId))) return NOT_ADMIN;
  const text = arg?.trim() ?? "";
  if (/^(сброс|снять|reset)$/i.test(text)) {
    await assign(groupChatId, kind, null);
    return `${TITLE[kind]}: роль снята.`;
  }
  if (text) {
    // «/манишкаНосец Володя»: игрок из списков — его; иначе записываем от имени админа (как «+Володя»).
    if (text.length > 40 || !/\p{L}/u.test(text)) return "Имя — до 40 символов и хотя бы одна буква.";
    const found = candidates(groupChatId).find((p) => p.displayName.trim().toLowerCase() === text.toLowerCase());
    const holder: RoleHolder = found
      ? holderFrom(found)
      : { userId, self: false, displayName: text, profileName: sender.name || sender.first_name, addedByName: sender.first_name.trim(), since: Date.now() };
    await assign(groupChatId, kind, holder);
    return `✅ ${TITLE[kind]}: ${holderText(groupChatId, kind)}.${found ? "" : ` Записывать его будет ${sender.first_name.trim()} (как «+${text}»).`}`;
  }
  const list = candidates(groupChatId);
  if (!list.length) return `Выбрать не из кого — в записях пока никого. Можно указать имя: /${kind === "legend" ? "легенда" : "манишкаНосец"} Витя. Сейчас ${TITLE[kind]} — ${holderText(groupChatId, kind)}.`;
  const current = getRole(groupChatId, kind);
  const rows = list.map((p) => [
    btn(`${isRoleHolderEntry(p, current) ? "✅ " : ""}${p.displayName}${p.profileName ? "" : ` (записывает ${p.addedByName ?? "друг"})`}`, {
      a: "role_pick",
      r: kind,
      p: p.userId,
      ...(p.profileName ? {} : { n: p.displayName }),
    }),
  ]);
  if (getRole(groupChatId, kind)) rows.push([btn("✖️ Снять роль", { a: "role_off", r: kind })]);
  rows.push([btn("Отмена", { a: "role_cancel" })]);
  const about =
    kind === "legend"
      ? "Легенда всегда записан 1-м в каждой записи — ровно год с назначения."
      : "МанишкаНосец всегда записан 2-м (после легенды) в каждой записи.";
  await api.sendMessageToChat(replyChatId, {
    text: `${TITLE[kind]} — сейчас: ${holderText(groupChatId, kind)}.\n${about}\nВыберите игрока (только админ). Нет в списке — напишите имя: /${kind === "legend" ? "легенда" : "манишкаНосец"} Володя`,
    attachments: [kb(rows)],
  });
  return "";
}

// ---- Кнопка «👕 Я забрал манишки» после игры ----

interface ManiskaPrompt {
  messageId: string;
  eligible: number[]; // кто играл (основа) — только они могут нажать
  takenBy?: number;
  previous?: RoleHolder | null; // кто был манишкаНосцем до нажатия — вернём при «Я ошибся»
}

const promptKey = (chatId: number) => `maniska_prompt:${chatId}`;

function loadPrompt(chatId: number): ManiskaPrompt | null {
  const row = db().prepare("SELECT value FROM meta WHERE key = ?").get(promptKey(chatId)) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as ManiskaPrompt) : null;
}

function savePrompt(chatId: number, p: ManiskaPrompt): void {
  db().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(promptKey(chatId), JSON.stringify(p));
}

/** Сообщение с кнопкой «Я забрал манишки» — не удаляется при очистке чата после итогов MVP. */
export function maniskaPromptMessageId(chatId: number): string | undefined {
  return loadPrompt(chatId)?.messageId;
}

function promptView(chatId: number, p: ManiskaPrompt): { text: string; attachments: InlineKeyboardAttachment[] } {
  if (p.takenBy !== undefined) {
    const name = getRole(chatId, "maniska")?.displayName ?? "игрок";
    return {
      text: `👕 Манишки забрал: ${name} — в следующую игру он записан вторым (после легенды).\nОшибка? Пусть ${name} нажмёт «Я ошибся».`,
      attachments: [kb([[btn("↩️ Я ошибся", { a: "mnk_undo" })]])],
    };
  }
  return {
    text: "👕 Кто забрал манишки? Нажмите кнопку — в следующую игру бот запишет вас вторым (после легенды). Нажать может только тот, кто играл.",
    attachments: [kb([[btn("👕 Я забрал манишки", { a: "mnk_take" })]])],
  };
}

/** После игры (вместе с голосованием за MVP): кнопка для манишкаНосца. */
export async function postManiskaPrompt(game: FootballSession): Promise<void> {
  const prompt: ManiskaPrompt = { messageId: "", eligible: [...new Set(game.players.filter((p) => !p.isReserve).map((p) => p.userId))] };
  const res = await api.sendMessageToChat(game.chatId, promptView(game.chatId, prompt));
  prompt.messageId = res.message.body.mid;
  savePrompt(game.chatId, prompt);
}

async function refreshPrompt(chatId: number, p: ManiskaPrompt): Promise<void> {
  savePrompt(chatId, p);
  await api.editMessage(chatId, p.messageId, promptView(chatId, p)).catch(() => undefined);
}

function playerOf(chatId: number, userId: number): Player | undefined {
  for (const s of [getSession(chatId), getArchivedSession(chatId)]) {
    const p = s?.players.find((x) => x.userId === userId && x.profileName);
    if (p) return p;
  }
  return undefined;
}

export function isRoleAction(action: ButtonAction): boolean {
  return ["adm_legend", "adm_maniska", "role_pick", "role_off", "role_cancel", "mnk_take", "mnk_undo"].includes(action.a);
}

/**
 * Нажатия кнопок ролей → текст всплывающего уведомления. `groupChatId` — чат,
 * чьи роли меняем (для лички — выбранный человеком чат); `messageChatId` и
 * `messageId` — где сообщение с кнопками.
 */
export async function handleRoleAction(
  groupChatId: number,
  messageChatId: number,
  messageId: string | undefined,
  user: { user_id: number; first_name: string; last_name?: string; name?: string },
  action: ButtonAction,
): Promise<string> {
  const userId = user.user_id;
  switch (action.a) {
    case "adm_legend":
    case "adm_maniska": {
      const reply = await roleCommand(groupChatId, messageChatId, user, action.a === "adm_legend" ? "legend" : "maniska");
      return reply || "Выберите игрока";
    }
    case "role_cancel":
      if (!(await isChatAdmin(groupChatId, userId))) return "Только для администраторов";
      if (messageId) await api.deleteMessage(messageChatId, messageId).catch(() => undefined);
      return "Отменено";
    case "role_off":
    case "role_pick": {
      if (!(await isChatAdmin(groupChatId, userId))) return "Назначает только админ";
      const kind = action.r;
      let holder: RoleHolder | null = null;
      if (action.a === "role_pick") {
        const p = action.n
          ? candidates(groupChatId).find((x) => x.userId === action.p && !x.profileName && x.displayName === action.n)
          : playerOf(groupChatId, action.p);
        if (!p) return "Этого игрока уже нет в записи";
        holder = holderFrom(p);
      }
      await assign(groupChatId, kind, holder);
      const done = holder
        ? `✅ ${TITLE[kind]}: ${holderText(groupChatId, kind)}. ${kind === "legend" ? "Записан 1-м" : "Записан 2-м"} в текущей и следующих записях.`
        : `${TITLE[kind]}: роль снята.`;
      if (messageId) await api.editMessage(messageChatId, messageId, { text: done, attachments: [] }).catch(() => undefined);
      return holder ? `${TITLE[kind]} — ${holder.displayName}` : "Роль снята";
    }
    case "mnk_take": {
      const p = loadPrompt(groupChatId);
      if (!p || p.messageId !== messageId) return "Эта кнопка уже не действует";
      if (p.takenBy !== undefined) {
        return p.takenBy === userId ? "Манишки уже у вас" : `Манишки уже забрал ${getRole(groupChatId, "maniska")?.displayName ?? "другой игрок"}`;
      }
      if (!p.eligible.includes(userId)) return "Нажать может только тот, кто играл";
      const player = playerOf(groupChatId, userId);
      const holder: RoleHolder = player
        ? holderFrom(player)
        : { userId, displayName: user.first_name.trim(), lastName: user.last_name?.trim() || undefined, profileName: user.name ?? user.first_name, since: Date.now() };
      p.previous = getRole(groupChatId, "maniska");
      p.takenBy = userId;
      await assign(groupChatId, "maniska", holder);
      await refreshPrompt(groupChatId, p);
      return "👕 Вы манишкаНосец — в следующую игру записаны вторым";
    }
    case "mnk_undo": {
      const p = loadPrompt(groupChatId);
      if (!p || p.messageId !== messageId || p.takenBy === undefined) return "Эта кнопка уже не действует";
      if (p.takenBy !== userId && !(await isChatAdmin(groupChatId, userId))) return "«Я ошибся» может нажать только тот, кто забрал манишки";
      const previous = p.previous ?? null;
      delete p.takenBy;
      delete p.previous;
      await assign(groupChatId, "maniska", previous);
      await refreshPrompt(groupChatId, p);
      return "Отменено — нажать может другой игрок";
    }
  }
  return "Готово";
}
