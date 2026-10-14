import { config } from "./config";
import { db } from "./db";

// Настройки, которые должны переживать перезапуск: расписание публикации
// записи и накопительный рейтинг MVP. Хранятся в SQLite (см. db.ts).

// ---- Расписание публикации записи ----

export interface SavedSchedule {
  cron: string;
  days: number[]; // 0=вс ... 6=сб
  time: string; // "ЧЧ:ММ:СС" (у старых сохранений — "ЧЧ:ММ")
}

/** Расписание публикации записи этого чата из /расписание; null — действует CRON_SCHEDULE. */
export function loadSchedule(chatId: number): SavedSchedule | null {
  const row = db().prepare("SELECT cron, days, time FROM chat_schedule WHERE chat_id = ?").get(chatId) as
    | { cron: string; days: string; time: string }
    | undefined;
  return row ? { cron: row.cron, days: JSON.parse(row.days) as number[], time: row.time } : null;
}

/** Забыть расписание чата из /расписание — снова действует CRON_SCHEDULE из .env. */
export function deleteSchedule(chatId: number): void {
  db().prepare("DELETE FROM chat_schedule WHERE chat_id = ?").run(chatId);
}

export function saveSchedule(chatId: number, schedule: SavedSchedule): void {
  db()
    .prepare("INSERT OR REPLACE INTO chat_schedule (chat_id, cron, days, time) VALUES (?, ?, ?, ?)")
    .run(chatId, schedule.cron, JSON.stringify(schedule.days), schedule.time);
}

// ---- Время игры ----

/** Время начала игры чата: заданное через /описание, иначе GAME_TIME из .env. */
export function getGameTime(chatId: number): string {
  const row = db().prepare("SELECT value FROM meta WHERE key = ?").get(`game_time:${chatId}`) as { value: string } | undefined;
  return row?.value ?? config.gameTime;
}

export function setGameTime(chatId: number, time: string): void {
  db().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(`game_time:${chatId}`, time);
}

// ---- Игры чата: пары «публикация → игра» (/игры) ----

/** Пн 12:00 публикуем запись → игра Ср 21:20. Дни — как в cron: 0=вс … 6=сб. */
export interface GameSlot {
  pub: number;
  pubTime: string; // "ЧЧ:ММ"
  game: number;
  time: string; // "ЧЧ:ММ" — начало игры
}

/** Игры чата из /игры; null — обычное расписание (/расписание или CRON_SCHEDULE, игра на следующий день). */
export function getGameSlots(chatId: number): GameSlot[] | null {
  const row = db().prepare("SELECT value FROM meta WHERE key = ?").get(`game_slots:${chatId}`) as { value: string } | undefined;
  const slots = row ? (JSON.parse(row.value) as GameSlot[]) : null;
  return slots && slots.length ? slots : null;
}

export function setGameSlots(chatId: number, slots: GameSlot[] | null): void {
  if (!slots || !slots.length) db().prepare("DELETE FROM meta WHERE key = ?").run(`game_slots:${chatId}`);
  else db().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(`game_slots:${chatId}`, JSON.stringify(slots));
}

// ---- Настройки чата: манишки вкл/выкл, когда напоминать об оплате ----

export interface ChatOptions {
  maniska: boolean; // манишкаНосец и кнопка «Кто забрал манишки?»
  paymentBefore: number; // напоминания об оплате каждый час за N ч до игры (0 — нет)
  paymentAfter: number; // и N ч после игры
}

export function getChatOptions(chatId: number): ChatOptions {
  const row = db().prepare("SELECT value FROM meta WHERE key = ?").get(`chat_opts:${chatId}`) as { value: string } | undefined;
  const saved = row ? (JSON.parse(row.value) as Partial<ChatOptions>) : {};
  return { maniska: true, paymentBefore: config.paymentHoursBefore, paymentAfter: config.paymentHoursAfter, ...saved };
}

export function setChatOptions(chatId: number, patch: Partial<ChatOptions> | null): void {
  if (!patch) {
    db().prepare("DELETE FROM meta WHERE key = ?").run(`chat_opts:${chatId}`);
    return;
  }
  const row = db().prepare("SELECT value FROM meta WHERE key = ?").get(`chat_opts:${chatId}`) as { value: string } | undefined;
  const merged = { ...(row ? (JSON.parse(row.value) as Partial<ChatOptions>) : {}), ...patch };
  db().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(`chat_opts:${chatId}`, JSON.stringify(merged));
}

// ---- Роли: легенда и манишкаНосец (/легенда, /манишкаНосец) ----

export type RoleKind = "legend" | "maniska";

/** Кто носит роль: данные профиля — чтобы записывать его в каждую новую запись «как через +». */
export interface RoleHolder {
  // Свой аккаунт (self) — userId самого игрока. Иначе игрока записывает друг
  // (как «+Витя»): userId и имена — того, кто записывает.
  userId: number;
  self?: boolean; // у старых сохранений нет — считаем true
  displayName: string;
  lastName?: string;
  profileName: string; // полное имя из профиля MAX (для упоминаний); у «друга» — имя записывающего
  addedByName?: string; // у «друга»: кто его записывает
  since: number; // когда назначен
}

/** Это запись носителя роли? Свой аккаунт — его собственная запись; «друг» — запись с его именем от того же человека. */
export function isRoleHolderEntry(p: { userId: number; displayName: string; profileName?: string; auto?: string }, holder: RoleHolder | null): boolean {
  if (!holder || p.userId !== holder.userId) return false;
  if (holder.self !== false) return Boolean(p.profileName || p.auto);
  return !p.profileName && p.displayName.trim().toLowerCase() === holder.displayName.trim().toLowerCase();
}

const LEGEND_TERM_MS = (since: number) => {
  const until = new Date(since);
  until.setFullYear(until.getFullYear() + 1); // легенда — ровно на год
  return until.getTime();
};

/** До какого момента действует легенда. */
export function legendUntil(holder: RoleHolder): Date {
  return new Date(LEGEND_TERM_MS(holder.since));
}

/** Текущий носитель роли; у легенды — только пока не прошёл год. */
export function getRole(chatId: number, kind: RoleKind, now = Date.now()): RoleHolder | null {
  const row = db().prepare("SELECT value FROM meta WHERE key = ?").get(`role_${kind}:${chatId}`) as { value: string } | undefined;
  if (!row) return null;
  const holder = JSON.parse(row.value) as RoleHolder;
  if (kind === "legend" && now >= LEGEND_TERM_MS(holder.since)) return null;
  if (kind === "maniska" && !getChatOptions(chatId).maniska) return null; // манишки в этом чате выключены
  return holder;
}

export function setRole(chatId: number, kind: RoleKind, holder: RoleHolder | null): void {
  if (!holder) db().prepare("DELETE FROM meta WHERE key = ?").run(`role_${kind}:${chatId}`);
  else db().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(`role_${kind}:${chatId}`, JSON.stringify(holder));
}

// ---- Размер основы (/лимит) ----

/** Сколько человек в основе у чата: из /лимит, иначе MAX_PLAYERS из .env. Дальше — резерв. */
export function getMaxPlayers(chatId: number): number {
  const row = db().prepare("SELECT value FROM meta WHERE key = ?").get(`max_players:${chatId}`) as { value: string } | undefined;
  return row ? Number(row.value) : config.maxPlayers;
}

export function setMaxPlayers(chatId: number, n: number | null): void {
  if (n === null) db().prepare("DELETE FROM meta WHERE key = ?").run(`max_players:${chatId}`);
  else db().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(`max_players:${chatId}`, String(n));
}

// ---- Оплата чата (/оплата) ----

export interface Payment {
  amount: number; // ₽ с игрока
  details: string; // куда платить
}

/** Сумма и реквизиты чата: из /оплата, иначе PAYMENT_AMOUNT / PAYMENT_DETAILS из .env. */
export function getPayment(chatId: number): Payment {
  const row = db().prepare("SELECT value FROM meta WHERE key = ?").get(`payment:${chatId}`) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as Payment) : { amount: config.paymentAmount, details: config.paymentDetails };
}

export function hasOwnPayment(chatId: number): boolean {
  return Boolean(db().prepare("SELECT 1 FROM meta WHERE key = ?").get(`payment:${chatId}`));
}

export function setPayment(chatId: number, payment: Payment | null): void {
  if (!payment) db().prepare("DELETE FROM meta WHERE key = ?").run(`payment:${chatId}`);
  else db().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(`payment:${chatId}`, JSON.stringify(payment));
}

// ---- Своё имя в списке (/имя, кнопка «✏️ Изменить имя») ----

/** Как показывать человека в списке при записи через «+»; null — имя из профиля MAX. */
export function getNickname(userId: number): string | null {
  const row = db().prepare("SELECT name FROM nicknames WHERE user_id = ?").get(userId) as { name: string } | undefined;
  return row?.name ?? null;
}

export function setNickname(userId: number, name: string): void {
  db().prepare("INSERT OR REPLACE INTO nicknames (user_id, name) VALUES (?, ?)").run(userId, name);
}

// ---- Шаблон шапки записи ----

/**
 * Шапка записи из /описание: текст с подстановками {День}/{день} (день недели),
 * {дата} (ДД.ММ.ГГГГ), {дата_кратко} (ДД.ММ), {время}. null — стандартная шапка.
 */
export function getRosterTemplate(chatId: number): string | null {
  const row = db().prepare("SELECT value FROM meta WHERE key = ?").get(`roster_title:${chatId}`) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setRosterTemplate(chatId: number, template: string | null): void {
  if (template === null) db().prepare("DELETE FROM meta WHERE key = ?").run(`roster_title:${chatId}`);
  else db().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(`roster_title:${chatId}`, template);
}

// ---- Рейтинг MVP игроков ----

export interface MvpEntry {
  name: string;
  count: number; // за всё время
  season: number; // в текущем сезоне
  year: number; // в текущем игровом году (декабрь–ноябрь)
}

export type MvpResetScope = "season" | "all";

// Игрок = имя (без учёта регистра): у людей, записанных «за друга», нет своего
// ID в MAX. mvp_aliases — объединённые админом имена («рус» -> «ruslan»).

function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

function resolve(chatId: number, name: string): string {
  let key = nameKey(name);
  const st = db().prepare("SELECT to_key FROM mvp_aliases WHERE chat_id = ? AND from_key = ?");
  for (let i = 0; i < 10; i++) {
    const row = st.get(chatId, key) as { to_key: string } | undefined;
    if (!row) break;
    key = row.to_key;
  }
  return key;
}

/** Начисляет по +1 MVP каждому из победителей голосования. */
export function addMvpWins(chatId: number, names: string[], holders: Array<RoleHolder | null> = []): void {
  const st = db().prepare(
    `INSERT INTO mvp_players (chat_id, name_key, name, count, season_count, year_count) VALUES (?, ?, ?, 1, 1, 1)
     ON CONFLICT (chat_id, name_key) DO UPDATE SET count = count + 1, season_count = season_count + 1, year_count = year_count + 1`,
  );
  const user = db().prepare("INSERT OR REPLACE INTO mvp_users (chat_id, name_key, holder) VALUES (?, ?, ?)");
  db().transaction(() => {
    names.forEach((name, i) => {
      const key = resolve(chatId, name);
      st.run(chatId, key, name.trim());
      // Кто стоит за именем — чтобы в конце года назначить легенду года.
      if (holders[i]) user.run(chatId, key, JSON.stringify(holders[i]));
    });
  })();
}

/** Аккаунт за именем из рейтинга MVP (null — неизвестен, например победы до этой доработки). */
export function getMvpUser(chatId: number, name: string): RoleHolder | null {
  const row = db().prepare("SELECT holder FROM mvp_users WHERE chat_id = ? AND name_key = ?").get(chatId, resolve(chatId, name)) as
    | { holder: string }
    | undefined;
  return row ? (JSON.parse(row.holder) as RoleHolder) : null;
}

// ---- Смена сезона и игрового года (см. gameSeasons.ts, seasonLogic.ts) ----

const periodKey = (chatId: number) => `mvp_period:${chatId}`;

/** Сезон, по которому сейчас идёт сезонный счёт («2026-Осень»); null — ещё не отмечали. */
export function getMvpPeriod(chatId: number): string | null {
  const row = db().prepare("SELECT value FROM meta WHERE key = ?").get(periodKey(chatId)) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMvpPeriod(chatId: number, key: string, seasonStart: Date): void {
  db().transaction(() => {
    db().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(periodKey(chatId), key);
    db().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(`mvp_season_start:${chatId}`, seasonStart.toISOString());
  })();
}

/** Новый сезон: сезонный счёт с нуля. */
export function resetSeasonCounts(chatId: number): void {
  db().prepare("UPDATE mvp_players SET season_count = 0 WHERE chat_id = ?").run(chatId);
}

/** Новый игровой год: годовой счёт с нуля. */
export function resetYearCounts(chatId: number): void {
  db().prepare("UPDATE mvp_players SET year_count = 0 WHERE chat_id = ?").run(chatId);
}

/** Рейтинг чата: больше MVP за всё время — выше, при равенстве — по имени. */
export function getMvpRating(chatId: number): MvpEntry[] {
  const rows = db()
    .prepare("SELECT name, count, season_count AS season, year_count AS year FROM mvp_players WHERE chat_id = ?")
    .all(chatId) as MvpEntry[];
  return rows.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ru"));
}

const seasonKey = (chatId: number) => `mvp_season_start:${chatId}`;

/** Когда начался текущий сезон (последний сезонный или общий сброс); null — сбросов не было. */
export function getSeasonStart(chatId: number): Date | null {
  const row = db().prepare("SELECT value FROM meta WHERE key = ?").get(seasonKey(chatId)) as { value: string } | undefined;
  return row ? new Date(row.value) : null;
}

/**
 * Сброс рейтинга MVP: "season" — обнуляет только сезонный счёт; "all" —
 * удаляет весь рейтинг (и общий, и сезонный). Объединения имён сохраняются.
 * Возвращает, сколько игроков было затронуто.
 */
export function resetMvp(chatId: number, scope: MvpResetScope): number {
  const d = db();
  let affected = 0;
  d.transaction(() => {
    affected =
      scope === "season"
        ? d.prepare("UPDATE mvp_players SET season_count = 0 WHERE chat_id = ? AND season_count > 0").run(chatId).changes
        : d.prepare("DELETE FROM mvp_players WHERE chat_id = ?").run(chatId).changes;
    d.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(seasonKey(chatId), new Date().toISOString());
  })();
  return affected;
}

export type MergeResult =
  | { ok: true; from: string; to: string; count: number }
  | { ok: false; error: string };

/** Объединяет игрока `from` с `to` (счёт складывается, дальше победы `from` идут к `to`). */
export function mergeMvpNames(chatId: number, from: string, to: string): MergeResult {
  const d = db();
  const fromKey = resolve(chatId, from);
  const toKey = resolve(chatId, to);
  if (fromKey === toKey) return { ok: false, error: "Это уже один и тот же игрок." };
  const get = d.prepare("SELECT name, count, season_count AS season, year_count AS year FROM mvp_players WHERE chat_id = ? AND name_key = ?");
  const source = get.get(chatId, fromKey) as MvpEntry | undefined;
  if (!source) return { ok: false, error: `В рейтинге нет игрока «${from.trim()}».` };

  d.transaction(() => {
    d.prepare(
      `INSERT INTO mvp_players (chat_id, name_key, name, count, season_count, year_count) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (chat_id, name_key) DO UPDATE SET
         count = count + excluded.count, season_count = season_count + excluded.season_count,
         year_count = year_count + excluded.year_count`,
    ).run(chatId, toKey, to.trim(), source.count, source.season, source.year);
    d.prepare("UPDATE mvp_users SET name_key = ? WHERE chat_id = ? AND name_key = ? AND NOT EXISTS (SELECT 1 FROM mvp_users WHERE chat_id = ? AND name_key = ?)").run(toKey, chatId, fromKey, chatId, toKey);
    d.prepare("DELETE FROM mvp_players WHERE chat_id = ? AND name_key = ?").run(chatId, fromKey);
    d.prepare("INSERT OR REPLACE INTO mvp_aliases (chat_id, from_key, to_key) VALUES (?, ?, ?)").run(chatId, fromKey, toKey);
  })();
  const target = get.get(chatId, toKey) as MvpEntry;
  return { ok: true, from: source.name, to: target.name, count: target.count };
}
