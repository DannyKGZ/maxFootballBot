import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { config } from "./config";
import { FootballSession, PendingAction, VoteSession } from "./types";

/**
 * SQLite-база бота (DB_FILE, по умолчанию ./data/bot.db). Схема простая:
 * запись и голосование хранятся JSON-документом в строке по chat_id (у них
 * вложенные списки игроков и голосов), рейтинг MVP и расписание — обычными
 * колонками. При первом запуске сюда один раз переносятся старые JSON-файлы.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (chat_id INTEGER PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS archived_sessions (chat_id INTEGER PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS votes (chat_id INTEGER PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pending_actions (
  chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);
CREATE TABLE IF NOT EXISTS sent_messages (
  chat_id INTEGER NOT NULL, message_id TEXT NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
CREATE TABLE IF NOT EXISTS rating_messages (chat_id INTEGER PRIMARY KEY, message_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS schedule (
  id INTEGER PRIMARY KEY CHECK (id = 1), cron TEXT NOT NULL, days TEXT NOT NULL, time TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mvp_players (
  chat_id INTEGER NOT NULL, name_key TEXT NOT NULL, name TEXT NOT NULL,
  count INTEGER NOT NULL,                      -- общий счёт MVP (за всё время)
  season_count INTEGER NOT NULL DEFAULT 0,     -- счёт текущего сезона
  year_count INTEGER NOT NULL DEFAULT 0,       -- счёт игрового года (декабрь–ноябрь)
  PRIMARY KEY (chat_id, name_key)
);
-- Кто стоит за именем в рейтинге MVP (для «легенды года»): аккаунт игрока или того, кто его записывает.
CREATE TABLE IF NOT EXISTS mvp_users (
  chat_id INTEGER NOT NULL, name_key TEXT NOT NULL, holder TEXT NOT NULL, -- JSON RoleHolder
  PRIMARY KEY (chat_id, name_key)
);
CREATE TABLE IF NOT EXISTS mvp_aliases (
  chat_id INTEGER NOT NULL, from_key TEXT NOT NULL, to_key TEXT NOT NULL,
  PRIMARY KEY (chat_id, from_key)
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS chat_schedule (
  chat_id INTEGER PRIMARY KEY, cron TEXT NOT NULL, days TEXT NOT NULL, time TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nicknames (user_id INTEGER PRIMARY KEY, name TEXT NOT NULL); -- своё имя в списке (/имя)
-- Учёт оплаты игры (чаты с проверкой чеков): строка на каждого, кто записывал игроков основы.
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL, game_date TEXT NOT NULL, payer_id INTEGER NOT NULL,
  payer_name TEXT NOT NULL, payer_profile TEXT NOT NULL,
  players TEXT NOT NULL,                       -- JSON: за кого платит (имена)
  due INTEGER NOT NULL,                        -- сколько должен, ₽
  paid INTEGER NOT NULL DEFAULT 0,             -- сколько подтверждено, ₽
  status TEXT NOT NULL DEFAULT 'unpaid',       -- unpaid | paid | review | manual
  note TEXT, updated_at INTEGER,
  UNIQUE (chat_id, game_date, payer_id)
);
CREATE TABLE IF NOT EXISTS receipts (hash TEXT PRIMARY KEY, chat_id INTEGER NOT NULL, payer_id INTEGER NOT NULL, at INTEGER NOT NULL);
`;

let instance: Database.Database | null = null;

export function db(): Database.Database {
  if (instance) return instance;
  const file = path.resolve(config.dbFile);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  instance = new Database(file);
  instance.pragma("journal_mode = WAL"); // устойчиво к сбоям, чтение не блокирует запись
  instance.pragma("busy_timeout = 5000");
  instance.exec(SCHEMA);
  migrateFromJson(instance);
  upgradeSchema(instance); // после JSON: старое общее расписание тоже переедет к первому чату
  return instance;
}

export function closeDb(): void {
  instance?.close();
  instance = null;
}

/** Доработки схемы для уже существующих баз. */
function upgradeSchema(d: Database.Database): void {
  const cols = d.prepare("PRAGMA table_info(mvp_players)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "season_count")) {
    // Сезонного счёта раньше не было — считаем, что все прошлые победы относятся к текущему сезону.
    d.exec("ALTER TABLE mvp_players ADD COLUMN season_count INTEGER NOT NULL DEFAULT 0");
    d.exec("UPDATE mvp_players SET season_count = count");
    console.log("[db] в рейтинг MVP добавлен сезонный счёт (прошлые победы засчитаны в текущий сезон)");
  }
  const payCols = d.prepare("PRAGMA table_info(payments)").all() as Array<{ name: string }>;
  if (!payCols.some((c) => c.name === "file_token")) {
    // Чек на ручной проверке: тип вложения MAX и его token — админ запросит файл кнопкой в личке.
    d.exec("ALTER TABLE payments ADD COLUMN file_type TEXT");
    d.exec("ALTER TABLE payments ADD COLUMN file_token TEXT");
  }
  if (!cols.some((c) => c.name === "year_count")) {
    // Счёт игрового года: бот работает с осени 2026 — все прошлые победы относятся к текущему году.
    d.exec("ALTER TABLE mvp_players ADD COLUMN year_count INTEGER NOT NULL DEFAULT 0");
    d.exec("UPDATE mvp_players SET year_count = count");
    console.log("[db] в рейтинг MVP добавлен счёт игрового года");
  }

  // Несколько чатов: расписание, время игры и шапка записи стали своими у каждого
  // чата. Прежние общие настройки переносятся первому чату (CHAT_ID / CHAT_IDS[0]).
  const first = config.chatIds[0];
  if (first && !d.prepare("SELECT 1 FROM meta WHERE key = 'per_chat_settings'").get()) {
    const old = d.prepare("SELECT cron, days, time FROM schedule WHERE id = 1").get() as
      | { cron: string; days: string; time: string }
      | undefined;
    if (old) d.prepare("INSERT OR IGNORE INTO chat_schedule (chat_id, cron, days, time) VALUES (?, ?, ?, ?)").run(first, old.cron, old.days, old.time);
    for (const k of ["game_time", "roster_title"]) {
      const row = d.prepare("SELECT value FROM meta WHERE key = ?").get(k) as { value: string } | undefined;
      if (row) d.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(`${k}:${first}`, row.value);
    }
    d.prepare("INSERT INTO meta (key, value) VALUES ('per_chat_settings', ?)").run(String(first));
    if (old) console.log(`[db] расписание, время игры и шапка записи теперь свои у каждого чата — прежние отданы чату ${first}`);
  }
}

// ---- Перенос старых JSON-файлов (один раз) ----

function readJsonFile<T>(file: string): T | null {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) return null;
  try {
    return JSON.parse(fs.readFileSync(abs, "utf8")) as T;
  } catch (err) {
    console.error(`[db] не удалось прочитать ${file} для переноса:`, err);
    return null;
  }
}

/** После переноса файл переименовывается в *.migrated, чтобы было видно, что он больше не используется. */
function markMigrated(file: string): void {
  const abs = path.resolve(file);
  if (fs.existsSync(abs)) fs.renameSync(abs, `${abs}.migrated`);
}

interface JsonSnapshot {
  sessions?: FootballSession[];
  archived?: FootballSession[];
  votes?: VoteSession[];
  pending?: PendingAction[];
  sent?: Record<string, string[]>;
  ratingMessages?: Record<string, string>;
}

type JsonMvp = Record<
  string,
  { players: Record<string, { name: string; count: number }>; aliases: Record<string, string> } | Record<string, { name: string; count: number }>
>;

function migrateFromJson(d: Database.Database): void {
  if (d.prepare("SELECT 1 FROM meta WHERE key = 'json_migrated'").get()) return;

  const moved: string[] = [];
  d.transaction(() => {
    const raw = readJsonFile<JsonSnapshot | FootballSession[]>(config.sessionsFile);
    if (raw) {
      const snap: JsonSnapshot = Array.isArray(raw) ? { sessions: raw } : raw;
      const put = (table: string, rows: Array<{ chatId: number }> = []) => {
        const st = d.prepare(`INSERT OR REPLACE INTO ${table} (chat_id, data) VALUES (?, ?)`);
        for (const r of rows) st.run(r.chatId, JSON.stringify(r));
      };
      put("sessions", snap.sessions);
      put("archived_sessions", snap.archived);
      put("votes", snap.votes);
      const pend = d.prepare("INSERT OR REPLACE INTO pending_actions (chat_id, user_id, data) VALUES (?, ?, ?)");
      for (const p of snap.pending ?? []) pend.run(p.chatId, p.userId, JSON.stringify(p));
      const sent = d.prepare("INSERT OR IGNORE INTO sent_messages (chat_id, message_id) VALUES (?, ?)");
      for (const [chat, ids] of Object.entries(snap.sent ?? {})) for (const id of ids) sent.run(Number(chat), id);
      const rating = d.prepare("INSERT OR REPLACE INTO rating_messages (chat_id, message_id) VALUES (?, ?)");
      for (const [chat, id] of Object.entries(snap.ratingMessages ?? {})) rating.run(Number(chat), id);
      moved.push(`записи: ${snap.sessions?.length ?? 0}, архив: ${snap.archived?.length ?? 0}, голосования: ${snap.votes?.length ?? 0}`);
    }

    const schedule = readJsonFile<{ cron: string; days: number[]; time: string }>(config.scheduleFile);
    if (schedule) {
      d.prepare("INSERT OR REPLACE INTO schedule (id, cron, days, time) VALUES (1, ?, ?, ?)").run(
        schedule.cron,
        JSON.stringify(schedule.days),
        schedule.time,
      );
      moved.push(`расписание: ${schedule.cron}`);
    }

    const mvp = readJsonFile<JsonMvp>(config.mvpFile);
    if (mvp) {
      const player = d.prepare(
        "INSERT OR REPLACE INTO mvp_players (chat_id, name_key, name, count, season_count) VALUES (?, ?, ?, ?, ?)",
      );
      const alias = d.prepare("INSERT OR REPLACE INTO mvp_aliases (chat_id, from_key, to_key) VALUES (?, ?, ?)");
      let n = 0;
      for (const [chat, value] of Object.entries(mvp)) {
        const players = ("players" in value && "aliases" in value ? value.players : value) as Record<string, { name: string; count: number }>;
        const aliases = ("players" in value && "aliases" in value ? value.aliases : {}) as Record<string, string>;
        for (const [key, e] of Object.entries(players)) {
          player.run(Number(chat), key, e.name, e.count, e.count);
          n++;
        }
        for (const [from, to] of Object.entries(aliases)) alias.run(Number(chat), from, to);
      }
      moved.push(`рейтинг MVP: игроков ${n}`);
    }

    d.prepare("INSERT INTO meta (key, value) VALUES ('json_migrated', ?)").run(new Date().toISOString());
  })();

  if (moved.length) {
    for (const f of [config.sessionsFile, config.scheduleFile, config.mvpFile]) markMigrated(f);
    console.log(`[db] данные из JSON перенесены в ${config.dbFile} (${moved.join("; ")})`);
  }
}
