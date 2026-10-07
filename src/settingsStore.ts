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
export function addMvpWins(chatId: number, names: string[]): void {
  const st = db().prepare(
    `INSERT INTO mvp_players (chat_id, name_key, name, count, season_count) VALUES (?, ?, ?, 1, 1)
     ON CONFLICT (chat_id, name_key) DO UPDATE SET count = count + 1, season_count = season_count + 1`,
  );
  db().transaction(() => {
    for (const name of names) st.run(chatId, resolve(chatId, name), name.trim());
  })();
}

/** Рейтинг чата: больше MVP за всё время — выше, при равенстве — по имени. */
export function getMvpRating(chatId: number): MvpEntry[] {
  const rows = db()
    .prepare("SELECT name, count, season_count AS season FROM mvp_players WHERE chat_id = ?")
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
  const get = d.prepare("SELECT name, count, season_count AS season FROM mvp_players WHERE chat_id = ? AND name_key = ?");
  const source = get.get(chatId, fromKey) as MvpEntry | undefined;
  if (!source) return { ok: false, error: `В рейтинге нет игрока «${from.trim()}».` };

  d.transaction(() => {
    d.prepare(
      `INSERT INTO mvp_players (chat_id, name_key, name, count, season_count) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (chat_id, name_key) DO UPDATE SET
         count = count + excluded.count, season_count = season_count + excluded.season_count`,
    ).run(chatId, toKey, to.trim(), source.count, source.season);
    d.prepare("DELETE FROM mvp_players WHERE chat_id = ? AND name_key = ?").run(chatId, fromKey);
    d.prepare("INSERT OR REPLACE INTO mvp_aliases (chat_id, from_key, to_key) VALUES (?, ?, ?)").run(chatId, fromKey, toKey);
  })();
  const target = get.get(chatId, toKey) as MvpEntry;
  return { ok: true, from: source.name, to: target.name, count: target.count };
}
