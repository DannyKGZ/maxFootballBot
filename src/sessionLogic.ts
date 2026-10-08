import { RoleHolder, RoleKind, getMaxPlayers, getRole, isRoleHolderEntry } from "./settingsStore";
import { config } from "./config";
import { computeNextGameDate, isSignupOpen } from "./gameDays";
import { getNickname, setNickname } from "./settingsStore";
import * as api from "./maxApi";
import {
  addAnotherKeyboard,
  rosterKeyboard,
  confirmCloseKeyboard,
  confirmRemoveKeyboard,
  removeChoiceKeyboard,
  confirmRestartKeyboard,
} from "./keyboard";
import { buildRosterText, fullName } from "./messageFormatter";
import {
  clearPendingAction,
  deleteSession,
  getPendingAction,
  getSession,
  setArchivedSession,
  setPendingAction,
  setSession,
} from "./store";
import { FootballSession, MaxUser, Player } from "./types";

/** Пересчитывает isReserve строго по позиции в списке (правило: первые /лимит или MAX_PLAYERS — основа). */
function recomputeReserveFlags(session: FootballSession): void {
  orderRolePlayers(session);
  session.players.forEach((player, index) => {
    player.isReserve = index >= getMaxPlayers(session.chatId);
  });
}

// ---- Легенда и манишкаНосец: всегда первыми в списке ----

/** Своя запись носителя роли (через «+» или автоматическая), не друзья, которых он записал. */
function isRoleEntry(p: Player, holder: RoleHolder | null): boolean {
  return isRoleHolderEntry(p, holder);
}

/** Легенда — всегда 1-я, манишкаНосец — сразу после неё (остальные — в прежнем порядке). */
function orderRolePlayers(session: FootballSession): void {
  const legend = getRole(session.chatId, "legend");
  const maniska = getRole(session.chatId, "maniska");
  const rank = (p: Player) => (isRoleEntry(p, legend) ? 0 : isRoleEntry(p, maniska) ? 1 : 2);
  const first = new Set<number>(); // только первая своя запись носителя поднимается наверх
  const ranked = session.players.map((p, i) => {
    let r = rank(p);
    if (r < 2) {
      if (first.has(r)) r = 2;
      else first.add(r);
    }
    return { p, i, r };
  });
  ranked.sort((x, y) => x.r - y.r || x.i - y.i);
  session.players = ranked.map((x) => x.p);
}

function roleEntry(holder: RoleHolder, kind: RoleKind): Player {
  const self = holder.self !== false;
  return {
    id: newPlayerId(),
    userId: holder.userId,
    displayName: holder.displayName,
    lastName: holder.lastName,
    profileName: self ? holder.profileName : undefined, // «друга» записывает другой человек — как «+Витя»
    addedByName: self ? holder.displayName : holder.addedByName,
    addedByFullName: holder.profileName,
    isReserve: false,
    joinedAt: Date.now(),
    auto: kind,
  };
}

/** Новая запись: легенда и манишкаНосец записаны сразу (удалиться может сам игрок или админ). */
function seedRolePlayers(session: FootballSession): void {
  const legend = getRole(session.chatId, "legend");
  const maniska = getRole(session.chatId, "maniska");
  if (legend) session.players.push(roleEntry(legend, "legend"));
  if (maniska && maniska.userId !== legend?.userId) session.players.push(roleEntry(maniska, "maniska"));
  recomputeReserveFlags(session);
}

/**
 * Роль сменилась — поправить открытую запись: прежнего носителя, записанного
 * только из-за роли, убрать, нового — записать (если его ещё нет). Запись на уже
 * начавшуюся игру не трогаем.
 */
export async function applyRoleChange(chatId: number, kind: RoleKind, previous: RoleHolder | null): Promise<void> {
  const session = getSession(chatId);
  if (!session || !isSignupOpen(session)) return;
  const holder = getRole(chatId, kind);
  if (previous && previous.userId !== holder?.userId) {
    session.players = session.players.filter((p) => !(p.auto === kind && p.userId === previous.userId));
  }
  if (holder && !session.players.some((p) => isRoleEntry(p, holder))) session.players.push(roleEntry(holder, kind));
  recomputeReserveFlags(session);
  await repostRoster(session);
}

/** Дата игры — от расписания (см. gameDays.ts): на следующий день после публикации. */
export { computeNextGameDate };

let idSeq = 0;
function newPlayerId(): string {
  return `${Date.now().toString(36)}${(idSeq++ % 1296).toString(36).padStart(2, "0")}`;
}

/**
 * Ключ игрока для кнопок (позиция в списке может сдвигаться). Это id игрока:
 * «кто записал + время записи» не годится — «+Андрей +Борис» записываются в одну
 * миллисекунду одним человеком.
 */
export function playerKey(p: Player): string {
  return p.id ?? `${p.userId}:${p.joinedAt}`;
}

/** Выдать id игрокам, у которых его нет (записаны старой версией бота). */
export function ensurePlayerIds(session: FootballSession): void {
  let changed = false;
  for (const p of session.players) {
    if (!p.id) {
      p.id = newPlayerId();
      changed = true;
    }
  }
  if (changed) setSession(session);
}

/** Текст и кнопки сообщения записи: после начала игры — без кнопок и с пометкой. */
function rosterMessage(session: FootballSession) {
  const closed = !isSignupOpen(session);
  return {
    text: closed ? `${buildRosterText(session)}\n\n🔒 Запись закрыта — игра началась.` : buildRosterText(session),
    attachments: closed ? [] : [rosterKeyboard()],
  };
}

/** Текст отказа, когда запись уже закрыта (игра началась). */
export function signupClosedText(session: FootballSession): string {
  const d = new Date(session.date);
  const time = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `🔒 Запись на игру ${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")} в ${time} закрыта — игра уже началась. Состав изменить может только админ.`;
}

/**
 * Вызывается по таймеру: если игра началась, запись закрывается — сообщение со
 * списком помечается «закрыта», кнопки снимаются, «+»/«-» больше не меняют список.
 */
export async function closeSignupIfStarted(session: FootballSession, now = Date.now()): Promise<boolean> {
  if (session.closedAt || now < new Date(session.date).getTime()) return false;
  session.closedAt = now;
  setSession(session);
  if (session.messageId) {
    try {
      await api.editMessage(session.chatId, session.messageId, rosterMessage(session));
    } catch (err) {
      console.warn("[sessionLogic] не удалось пометить запись закрытой:", err instanceof Error ? err.message : err);
    }
  }
  return true;
}

/**
 * При запуске: перерисовать сообщение текущей записи основного чата — шапка и
 * кнопки могли поменяться (новый шаблон /описание, новая версия бота). Только
 * правка существующего сообщения, без повторной публикации.
 */
export async function refreshRosterOnStartup(chatId: number): Promise<void> {
  const session = getSession(chatId);
  if (!session?.messageId) return;
  try {
    await api.editMessage(chatId, session.messageId, rosterMessage(session));
  } catch (err) {
    console.warn("[sessionLogic] не удалось обновить сообщение записи при запуске:", err instanceof Error ? err.message : err);
  }
}

/** Перерисовать сообщение записи (например, после /описание). */
export async function refreshRoster(session: FootballSession): Promise<void> {
  await pushRosterUpdate(session);
}

/**
 * Состав изменился («+», «-», кнопки, правка админом): публикуем свежий список
 * внизу чата, чтобы его сразу было видно, а старое сообщение убираем. Если
 * старое удалить нельзя (MAX удаляет только сообщения младше 24 ч) — снимаем
 * с него кнопки и помечаем, что актуальный список ниже.
 */
async function repostRoster(session: FootballSession): Promise<void> {
  const old = session.messageId;
  const { text, attachments } = rosterMessage(session);
  const res = await api.sendMessageToChat(session.chatId, { text, attachments });
  session.messageId = res.message.body.mid;
  setSession(session);
  if (!old) return;
  try {
    await api.deleteMessage(session.chatId, old);
  } catch {
    await api
      .editMessage(session.chatId, old, { text: `${text}\n\n⬇️ Список обновлён — актуальный ниже.`, attachments: [] })
      .catch(() => undefined); // старого сообщения уже нет — и ладно
  }
}

/** Перерисовать сообщение записи на месте (шапка, закрытие, перезапуск бота). */
async function pushRosterUpdate(session: FootballSession): Promise<void> {
  const { text, attachments } = rosterMessage(session);
  if (session.messageId) {
    try {
      await api.editMessage(session.chatId, session.messageId, { text, attachments });
      setSession(session);
      return;
    } catch (err) {
      // Сообщение со списком удалили из чата — публикуем список заново, иначе запись
      // навсегда «сломается». Другие ошибки (сеть, лимиты) пробрасываем как раньше.
      // Точный код ответа MAX для удалённого сообщения не задокументирован — ловим оба варианта.
      if (!(err instanceof Error && /HTTP 404|not[._ ]?found/i.test(err.message))) throw err;
      console.warn("[sessionLogic] сообщение со списком не найдено — публикую заново");
    }
  }
  const res = await api.sendMessageToChat(session.chatId, { text, attachments });
  session.messageId = res.message.body.mid;
  setSession(session);
}

/**
 * Публикует новую запись (по расписанию или админом). Текущая запись, если
 * есть, закрывается («открыта новая») и уходит в архив — по ней
 * ещё можно провести голосование за MVP.
 */
export async function publishNewSession(chatId: number): Promise<FootballSession> {
  const previous = getSession(chatId);
  if (previous) await closeAndArchive(previous, true);

  const session: FootballSession = {
    chatId,
    messageId: null,
    players: [],
    date: computeNextGameDate(chatId).toISOString(),
    createdAt: Date.now(),
  };
  seedRolePlayers(session);
  await pushRosterUpdate(session);
  return session;
}

/** Помечает старое сообщение со списком как закрытое (best-effort, не критично при ошибке). */
async function closeSessionMessage(session: FootballSession, newOpened = true): Promise<void> {
  if (!session.messageId) return;
  try {
    const suffix = newOpened ? "— Запись закрыта, открыта новая —" : "— Запись закрыта —";
    const text = `${buildRosterText(session)}\n\n${suffix}`;
    await api.editMessage(session.chatId, session.messageId, { text, attachments: [] });
  } catch (err) {
    console.error("[sessionLogic] не удалось закрыть старое сообщение:", err);
  }
}

/** Закрывает сообщение записи и кладёт запись в архив (последняя сыгранная игра для голосования). */
async function closeAndArchive(session: FootballSession, newOpened: boolean): Promise<void> {
  await closeSessionMessage(session, newOpened);
  if (session.players.length > 0) setArchivedSession(session);
}

/**
 * Проверка "пользователь — администратор этого чата" через
 * GET /chats/{chatId}/members/admins. Владелец чата и боты со статусом
 * администратора также попадают в этот список.
 */
export async function isChatAdmin(chatId: number, userId: number): Promise<boolean> {
  try {
    const res = await api.getChatAdmins(chatId);
    return res.members.some((m) => m.user_id === userId);
  } catch (err) {
    console.error("[sessionLogic] не удалось проверить права администратора:", err);
    return false; // при ошибке API безопаснее отказать, чем разрешить
  }
}

function findPlayerIndexByUser(session: FootballSession, userId: number): number {
  // Если пользователь записал несколько человек, "своей" считается последняя добавленная запись.
  for (let i = session.players.length - 1; i >= 0; i--) {
    if (session.players[i].userId === userId) return i;
  }
  return -1;
}

type NewPlayer = Pick<Player, "displayName" | "lastName" | "profileName">;

/** Добавляет сразу нескольких игроков и обновляет список ОДИН раз (лимит 2 сообщения/сек на чат). */
/** Индекс записи пользователя по имени (последняя подходящая); без имени/совпадения — его последняя запись. -1, если записей нет. */
function findOwnIndex(session: FootballSession, userId: number, name?: string): number {
  const own = session.players.map((p, i) => ({ p, i })).filter((x) => x.p.userId === userId);
  if (own.length === 0) return -1;
  if (name) {
    const byName = own.filter((x) => x.p.displayName.toLowerCase() === name.toLowerCase());
    if (byName.length) return byName[byName.length - 1].i;
  }
  return own[own.length - 1].i;
}

/** Проверка имён из "+Имя +Имя": null — всё в порядке, иначе текст ошибки для чата. */
export function validateNames(names: string[]): string | null {
  if (names.length > config.maxNamesPerMessage) {
    return `Одним сообщением можно записать не больше ${config.maxNamesPerMessage} игроков.`;
  }
  const tooLong = names.find((n) => n.length > config.maxNameLength);
  if (tooLong) return `Имя «${tooLong.slice(0, 20)}…» слишком длинное — не больше ${config.maxNameLength} символов.`;
  if (names.some((n) => !/\p{L}/u.test(n))) return "Имя должно содержать хотя бы одну букву.";
  return null;
}

async function addPlayers(
  session: FootballSession,
  userId: number,
  newPlayers: NewPlayer[],
  sender: MaxUser,
): Promise<void> {
  for (const np of newPlayers) {
    session.players.push({
      ...np,
      id: newPlayerId(),
      userId,
      addedByName: sender.first_name.trim(),
      addedByFullName: fullName(sender),
      isReserve: false, // пересчитается ниже
      joinedAt: Date.now(),
    });
  }
  recomputeReserveFlags(session);
  await repostRoster(session);
}

/**
 * Удаляет запись и обновляет список. Если из-за этого кто-то перешёл из
 * резерва в основу — сообщаем в чат, чтобы он (или записавший его) узнал.
 */
async function removePlayerAt(session: FootballSession, index: number): Promise<void> {
  const wasReserve = new Set(session.players.filter((p) => p.isReserve));
  session.players.splice(index, 1);
  recomputeReserveFlags(session);

  // Сначала — кто поднялся из резерва, потом свежий список: он должен быть последним в чате.
  const promoted = session.players.filter((p) => wasReserve.has(p) && !p.isReserve);
  for (const p of promoted) {
    const by = p.addedByName && p.addedByName !== p.displayName ? ` (записал ${p.addedByName})` : "";
    await api.sendMessageToChat(session.chatId, {
      text: `⬆️ ${p.displayName}${by} переходит из резерва в основной состав — освободилось место.`,
    });
  }
  await repostRoster(session);
}

/** Игрок из профиля MAX для голого "+": first_name (+ last_name), в скобках name. */
function playerFromProfile(sender: MaxUser): NewPlayer {
  return {
    // Своё имя из /имя (если задано), иначе имя из профиля MAX.
    displayName: getNickname(sender.user_id) ?? sender.first_name.trim(),
    lastName: sender.last_name?.trim() || undefined,
    profileName: fullName(sender),
  };
}

/**
 * Обработка сообщения, начинающегося с "+": голый "+" (запись себя по профилю)
 * или одно/несколько имён — "+Сергей +Владимир +Андрей" (массовый ввод).
 */
export async function handlePlusCommand(
  chatId: number,
  userId: number,
  names: string[],
  sender: MaxUser,
): Promise<void> {
  const session = getSession(chatId);
  if (!session) return; // нет активной записи в этом чате
  if (!isSignupOpen(session)) {
    await api.sendMessageToChat(chatId, { text: signupClosedText(session) });
    return;
  }

  const alreadyRegistered = findPlayerIndexByUser(session, userId) !== -1;


  // Явные имена ("+Рома", "+Рома +Влад") добавляем сразу, даже если автор уже записан.
  if (names.length) {
    const error = validateNames(names);
    if (error) {
      await api.sendMessageToChat(chatId, { text: error });
      return;
    }
    await addPlayers(session, userId, names.map((displayName) => ({ displayName })), sender);
    return;
  }

  // Голый "+": записываем по профилю; если автор уже в списке — уточняем, чтобы не задвоить себя.
  if (!alreadyRegistered) {
    await addPlayers(session, userId, [playerFromProfile(sender)], sender);
    return;
  }

  setPendingAction({ type: "confirm_add_another", chatId, userId, createdAt: Date.now() });
  await api.sendMessageToChat(chatId, {
    text: "Вы уже записаны. Хотите записать другого игрока?",
    attachments: [addAnotherKeyboard(userId)],
  });
}

/** Обработка текстового сообщения "-Имя". */
export async function handleMinusCommand(
  chatId: number,
  userId: number,
  name?: string,
): Promise<void> {
  const session = getSession(chatId);
  if (!session) return;

  const own = session.players.filter((p) => p.userId === userId);
  if (own.length === 0) return; // записей этого пользователя нет — ничего не делаем
  if (!isSignupOpen(session)) {
    await api.sendMessageToChat(chatId, { text: signupClosedText(session) });
    return;
  }

  // Кандидаты на удаление: записи с указанным именем, а без имени/совпадения — все свои.
  const named = name
    ? own.filter((p) => p.displayName.toLowerCase() === name.toLowerCase())
    : [];
  const candidates = named.length ? named : own;

  if (candidates.length === 1) {
    const targetName = candidates[0].displayName;
    setPendingAction({ type: "confirm_remove", chatId, userId, createdAt: Date.now(), targetName });
    await api.sendMessageToChat(chatId, {
      text: `Удалить из списка: ${targetName}?`,
      attachments: [confirmRemoveKeyboard(userId)],
    });
    return;
  }

  // Несколько своих записей (себя + друзей) — даём выбрать, кого убрать.
  await api.sendMessageToChat(chatId, {
    text: "Кого удалить из списка?",
    attachments: [removeChoiceKeyboard(userId, candidates.map((p) => p.displayName))],
  });
}

/** Выбор в списке «Кого удалить?» — удаляем сразу, без повторного подтверждения. */
export async function handleRemovePick(chatId: number, userId: number, name: string): Promise<void> {
  const session = getSession(chatId);
  if (!session) return;
  if (!isSignupOpen(session)) {
    await api.sendMessageToChat(chatId, { text: signupClosedText(session) });
    return;
  }

  const index = findOwnIndex(session, userId, name);
  if (index === -1) return;

  await removePlayerAt(session, index);
}

/**
 * Свободный текст, пришедший, пока у пользователя открыт pendingAction
 * "await_new_player_name" — это и есть имя нового игрока, которого он хочет добавить.
 */
export async function handleAwaitedPlayerName(
  chatId: number,
  userId: number,
  name: string,
  sender: MaxUser,
): Promise<boolean> {
  const pending = getPendingAction(chatId, userId);
  if (!pending || pending.type !== "await_new_player_name") return false;
  // Команды, "@all" и "+"/"-" не считаем именем — пусть обработаются как обычно.
  if (/^[/@+-]/.test(name)) {
    clearPendingAction(chatId, userId);
    return false;
  }

  const session = getSession(chatId);
  clearPendingAction(chatId, userId);
  if (!session) return true;
  if (!isSignupOpen(session)) {
    await api.sendMessageToChat(chatId, { text: signupClosedText(session) });
    return true;
  }

  const error = validateNames([name]);
  if (error) {
    await api.sendMessageToChat(chatId, { text: error });
    return true;
  }
  await addPlayers(session, userId, [{ displayName: name }], sender);
  return true;
}

// ---- Обработка нажатий на инлайн-кнопки ----

export async function handleAddAnotherYes(chatId: number, userId: number): Promise<void> {
  const session = getSession(chatId);
  if (session && !isSignupOpen(session)) {
    await api.sendMessageToChat(chatId, { text: signupClosedText(session) });
    return;
  }
  setPendingAction({ type: "await_new_player_name", chatId, userId, createdAt: Date.now() });
  await api.sendMessageToChat(chatId, { text: "Напишите имя нового игрока сообщением, например: Владимир" });
}

export async function handleAddAnotherNo(chatId: number, userId: number): Promise<void> {
  clearPendingAction(chatId, userId);
}

export async function handleRemoveYes(chatId: number, userId: number): Promise<void> {
  const targetName = getPendingAction(chatId, userId)?.targetName;
  clearPendingAction(chatId, userId);
  const session = getSession(chatId);
  if (!session) return;
  if (!isSignupOpen(session)) {
    await api.sendMessageToChat(chatId, { text: signupClosedText(session) });
    return;
  }

  const index = findOwnIndex(session, userId, targetName);
  if (index === -1) return;

  await removePlayerAt(session, index);
}

export async function handleRemoveNo(chatId: number, userId: number): Promise<void> {
  clearPendingAction(chatId, userId);
}

// ---- Ручной запуск новой записи админом (команда или кнопка) ----

export type AdminStartOutcome = "not_admin" | "started" | "asked_confirmation";

/**
 * Общая точка входа и для текстовой команды, и для кнопки "🔄 Начать новую запись".
 * Сама проверяет права через API — вызывающий код (webhookServer) просто
 * транслирует результат в подходящее сообщение/уведомление.
 */
export async function requestAdminStart(chatId: number, userId: number): Promise<AdminStartOutcome> {
  const admin = await isChatAdmin(chatId, userId);
  if (!admin) return "not_admin";

  const session = getSession(chatId);

  if (!session || session.players.length === 0) {
    await publishNewSession(chatId);
    return "started";
  }

  setPendingAction({ type: "confirm_restart_session", chatId, userId, createdAt: Date.now() });
  await api.sendMessageToChat(chatId, {
    text: `Сейчас уже идёт запись (записано: ${session.players.length}). Точно начать новую? Старая запись закроется.`,
    attachments: [confirmRestartKeyboard(userId)],
  });
  return "asked_confirmation";
}

export async function handleRestartYes(chatId: number, userId: number): Promise<void> {
  clearPendingAction(chatId, userId);
  await publishNewSession(chatId);
}

export async function handleRestartNo(chatId: number, userId: number): Promise<void> {
  clearPendingAction(chatId, userId);
}

// ---- Ручное закрытие записи админом (без открытия новой) ----

export type AdminCloseOutcome = "not_admin" | "no_session" | "closed" | "asked_confirmation";

/**
 * Общая точка входа и для текстовой команды, и для кнопки "❌ Закрыть запись".
 * Сама проверяет права через API — вызывающий код (webhookServer) просто
 * транслирует результат в подходящее сообщение/уведомление.
 */
export async function requestAdminClose(chatId: number, userId: number): Promise<AdminCloseOutcome> {
  const admin = await isChatAdmin(chatId, userId);
  if (!admin) return "not_admin";

  const session = getSession(chatId);
  if (!session) return "no_session";

  if (session.players.length === 0) {
    await closeAndArchive(session, false);
    deleteSession(chatId);
    return "closed";
  }

  setPendingAction({ type: "confirm_close_session", chatId, userId, createdAt: Date.now() });
  await api.sendMessageToChat(chatId, {
    text: `Точно закрыть текущую запись (записано: ${session.players.length}) без открытия новой?`,
    attachments: [confirmCloseKeyboard(userId)],
  });
  return "asked_confirmation";
}

export async function handleCloseYes(chatId: number, userId: number): Promise<void> {
  clearPendingAction(chatId, userId);
  const session = getSession(chatId);
  if (session) await closeAndArchive(session, false);
  deleteSession(chatId);
}

export async function handleCloseNo(chatId: number, userId: number): Promise<void> {
  clearPendingAction(chatId, userId);
}

// ---- Запись из личного чата с ботом (кнопки в личке) ----

export type JoinOutcome = "no_session" | "closed" | "already" | "joined";

/** «➕ Записаться» в личке: записать себя по профилю в запись общего чата. */
export async function joinSelf(groupChatId: number, sender: MaxUser): Promise<JoinOutcome> {
  const session = getSession(groupChatId);
  if (!session) return "no_session";
  if (!isSignupOpen(session)) return "closed";
  // «Себя» — запись с профилем (голый «+»); друзья, записанные этим человеком, не в счёт.
  if (session.players.some((p) => p.userId === sender.user_id && p.profileName)) return "already";
  await addPlayers(session, sender.user_id, [playerFromProfile(sender)], sender);
  return "joined";
}

/** Имена записей, сделанных этим пользователем (для выбора «кого убрать» в личке). */
export function ownEntries(groupChatId: number, userId: number): string[] {
  return getSession(groupChatId)?.players.filter((p) => p.userId === userId).map((p) => p.displayName) ?? [];
}

/** Убрать свою запись по имени (выбор в личке); false — такой записи уже нет. */
export async function removeOwnByName(groupChatId: number, userId: number, name: string): Promise<boolean> {
  const session = getSession(groupChatId);
  if (!session || !isSignupOpen(session)) return false;
  const index = findOwnIndex(session, userId, name);
  if (index === -1 || session.players[index].displayName.toLowerCase() !== name.toLowerCase()) return false;
  await removePlayerAt(session, index);
  return true;
}

// ---- Правка списка админом (/удалить, /переименовать, редактор в личке) ----

/** Индекс игрока по «3» (номер в списке) или по имени (последнее совпадение); -1 — не найден. */
export function findPlayerIndex(session: FootballSession, ref: string): number {
  const t = ref.trim();
  if (/^\d+$/.test(t)) {
    const i = Number(t) - 1;
    return i >= 0 && i < session.players.length ? i : -1;
  }
  const name = t.toLowerCase();
  for (let i = session.players.length - 1; i >= 0; i--) {
    const p = session.players[i];
    const full = (p.lastName ? `${p.displayName} ${p.lastName}` : p.displayName).toLowerCase();
    if (p.displayName.toLowerCase() === name || full === name) return i;
  }
  return -1;
}

/** Админ убирает любого игрока (и после начала игры — чтобы поправить итоговый состав). */
export async function adminRemoveAt(session: FootballSession, index: number): Promise<string> {
  const name = session.players[index].displayName;
  await removePlayerAt(session, index);
  return name;
}

/** Админ переименовывает игрока; null — успех, иначе текст ошибки. */
export async function adminRenameAt(session: FootballSession, index: number, newName: string): Promise<string | null> {
  const name = newName.trim();
  const error = validateNames([name]);
  if (error) return error;
  const p = session.players[index];
  p.displayName = name;
  delete p.lastName; // фамилия из профиля больше не относится к новому имени
  await repostRoster(session);
  return null;
}

/**
 * Админ меняет местами двух игроков (например, «1 на 12» — игрока основы с
 * резервистом). Основа/резерв пересчитываются по новым позициям.
 */
/** /лимит изменили — пересчитать основу/резерв текущей записи и показать свежий список. */
export async function applyMaxPlayers(chatId: number): Promise<void> {
  const session = getSession(chatId);
  if (!session) return;
  recomputeReserveFlags(session);
  await repostRoster(session);
}

export async function adminSwap(session: FootballSession, i: number, j: number): Promise<void> {
  [session.players[i], session.players[j]] = [session.players[j], session.players[i]];
  recomputeReserveFlags(session);
  await repostRoster(session);
}

// ---- Своё имя в списке ----

/**
 * Человек задаёт, как его показывать в списке (например, трое «Русланов» —
 * «Руслан Большой», «Рус»…). Имя запоминается для будущих записей через «+»,
 * а в текущей записи его собственная строка (через «+») сразу переименовывается.
 * null — успех, иначе текст ошибки.
 */
export async function setOwnNickname(userId: number, name: string): Promise<string | null> {
  const nick = name.trim();
  const error = validateNames([nick]);
  if (error) return error;
  setNickname(userId, nick);
  // Имя одно на человека — переименовываем его собственную строку во всех чатах бота.
  for (const chatId of config.chatIds) {
    const session = getSession(chatId);
    const own = session?.players.filter((p) => p.userId === userId && p.profileName) ?? [];
    if (!session || own.length === 0) continue;
    for (const p of own) {
      p.displayName = nick;
      delete p.lastName;
    }
    await pushRosterUpdate(session);
  }
  return null;
}
