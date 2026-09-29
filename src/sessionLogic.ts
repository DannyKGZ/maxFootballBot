import { config } from "./config";
import { getGameTime } from "./settingsStore";
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

/** Пересчитывает isReserve строго по позиции в списке (правило: первые MAX_PLAYERS — основа). */
function recomputeReserveFlags(session: FootballSession): void {
  session.players.forEach((player, index) => {
    player.isReserve = index >= config.maxPlayers;
  });
}

/** Следующая дата игры (день недели + время из конфига), строго в будущем. */
export function computeNextGameDate(from: Date = new Date()): Date {
  const result = new Date(from);
  result.setSeconds(0, 0);
  const [hours, minutes] = getGameTime().split(":").map(Number);
  result.setHours(hours, minutes, 0, 0);

  let diff = (config.gameDayOfWeek - result.getDay() + 7) % 7;
  if (diff === 0 && result.getTime() <= from.getTime()) {
    diff = 7; // время сегодня уже прошло — берём через неделю
  }
  result.setDate(result.getDate() + diff);
  return result;
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
    await api.editMessage(chatId, session.messageId, { text: buildRosterText(session), attachments: [rosterKeyboard()] });
  } catch (err) {
    console.warn("[sessionLogic] не удалось обновить сообщение записи при запуске:", err instanceof Error ? err.message : err);
  }
}

/** Перерисовать сообщение записи (например, после /описание). */
export async function refreshRoster(session: FootballSession): Promise<void> {
  await pushRosterUpdate(session);
}

async function pushRosterUpdate(session: FootballSession): Promise<void> {
  const text = buildRosterText(session);
  const attachments = [rosterKeyboard()];
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
    date: computeNextGameDate().toISOString(),
    createdAt: Date.now(),
  };
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
      userId,
      addedByName: sender.first_name.trim(),
      addedByFullName: fullName(sender),
      isReserve: false, // пересчитается ниже
      joinedAt: Date.now(),
    });
  }
  recomputeReserveFlags(session);
  await pushRosterUpdate(session);
}

/**
 * Удаляет запись и обновляет список. Если из-за этого кто-то перешёл из
 * резерва в основу — сообщаем в чат, чтобы он (или записавший его) узнал.
 */
async function removePlayerAt(session: FootballSession, index: number): Promise<void> {
  const wasReserve = new Set(session.players.filter((p) => p.isReserve));
  session.players.splice(index, 1);
  recomputeReserveFlags(session);
  await pushRosterUpdate(session);

  const promoted = session.players.filter((p) => wasReserve.has(p) && !p.isReserve);
  for (const p of promoted) {
    const by = p.addedByName && p.addedByName !== p.displayName ? ` (записал ${p.addedByName})` : "";
    await api.sendMessageToChat(session.chatId, {
      text: `⬆️ ${p.displayName}${by} переходит из резерва в основной состав — освободилось место.`,
    });
  }
}

/** Игрок из профиля MAX для голого "+": first_name (+ last_name), в скобках name. */
function playerFromProfile(sender: MaxUser): NewPlayer {
  return {
    displayName: sender.first_name.trim(),
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

export type JoinOutcome = "no_session" | "already" | "joined";

/** «➕ Записаться» в личке: записать себя по профилю в запись общего чата. */
export async function joinSelf(groupChatId: number, sender: MaxUser): Promise<JoinOutcome> {
  const session = getSession(groupChatId);
  if (!session) return "no_session";
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
  if (!session) return false;
  const index = findOwnIndex(session, userId, name);
  if (index === -1 || session.players[index].displayName.toLowerCase() !== name.toLowerCase()) return false;
  await removePlayerAt(session, index);
  return true;
}
