import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Не задана обязательная переменная окружения: ${name}`);
  }
  return value;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  botToken: required("BOT_TOKEN"),
  defaultChatId: optionalInt("CHAT_ID", 0),
  port: optionalInt("PORT", 8443),
  // Как получать сообщения из MAX: "webhook" (MAX шлёт на PUBLIC_WEBHOOK_URL — нужен
  // HTTPS: туннель или домен) или "polling" (бот сам забирает их через GET /updates —
  // не нужны ни домен, ни туннель; так бот работает на сервере).
  updatesMode: (process.env.UPDATES_MODE || "webhook").toLowerCase() === "polling" ? "polling" : "webhook",
  publicWebhookUrl: process.env.PUBLIC_WEBHOOK_URL || "",
  webhookSecret: process.env.WEBHOOK_SECRET || "",
  autoRegisterWebhook: (process.env.AUTO_REGISTER_WEBHOOK || "false").toLowerCase() === "true",
  tlsCertPath: process.env.TLS_CERT_PATH || "",
  tlsKeyPath: process.env.TLS_KEY_PATH || "",
  timezone: process.env.TIMEZONE || "Europe/Moscow",
  cronSchedule: process.env.CRON_SCHEDULE || "0 9 * * 1,5",
  gameDayOfWeek: optionalInt("GAME_DAY_OF_WEEK", 3),
  gameTime: process.env.GAME_TIME || "21:30",
  maxPlayers: optionalInt("MAX_PLAYERS", 10),
  // База SQLite со всем состоянием бота (записи, голосования, рейтинг, расписание).
  dbFile: process.env.DB_FILE || "./data/bot.db",
  // Старые JSON-файлы — из них данные один раз переносятся в базу при первом запуске.
  sessionsFile: process.env.SESSIONS_FILE || "./data/sessions.json",
  scheduleFile: process.env.SCHEDULE_FILE || "./data/schedule.json",
  mvpFile: process.env.MVP_FILE || "./data/mvp.json",
  // Лимиты для "+Имя +Имя": сколько имён за одно сообщение и какой длины имя.
  maxNamesPerMessage: optionalInt("MAX_NAMES_PER_MESSAGE", 5),
  maxNameLength: optionalInt("MAX_NAME_LENGTH", 30),
  // Объявление /Всем (@all) дублировать каждому участнику в личку. По умолчанию
  // выключено: MAX не даёт боту писать первым, и почти никому копия не доходит.
  announceDm: (process.env.ANNOUNCE_DM || "false").toLowerCase() === "true",
  // Через сколько минут бот забывает неотвеченный вопрос ("Да/Нет", "напишите имя").
  pendingTtlMinutes: optionalInt("PENDING_TTL_MINUTES", 15),
  // Напоминание в чат за N часов до игры (0 — выключено).
  reminderHoursBefore: optionalInt("REMINDER_HOURS_BEFORE", 5),
  // Напоминание об оплате игрокам основы: сумма и реквизиты, отдельным сообщением
  // каждый час за PAYMENT_HOURS_BEFORE ч до игры и PAYMENT_HOURS_AFTER ч после (0 — выкл.).
  paymentAmount: optionalInt("PAYMENT_AMOUNT", 350),
  paymentDetails: process.env.PAYMENT_DETAILS || "реквизиты не указаны (PAYMENT_DETAILS в .env)",
  paymentHoursBefore: optionalInt("PAYMENT_HOURS_BEFORE", 3),
  paymentHoursAfter: optionalInt("PAYMENT_HOURS_AFTER", 2),
  // Голосование за MVP запускается само через N минут после начала игры (60 → в 21:30 при игре в 20:30; 0 — выкл.).
  voteAutoStartMinutes: optionalInt("VOTE_AUTO_START_MINUTES", 60),
  // Голосование закрывается само через N часов после старта (0 — только вручную).
  voteAutoCloseHours: optionalInt("VOTE_AUTO_CLOSE_HOURS", 24),
  // Как часто проверять напоминания и автозакрытие. Меняется только в тестах.
  tickIntervalMs: optionalInt("TICK_INTERVAL_MS", 60_000),
  // MAX_API_BASE_URL нужен только для тестов с подставным сервером; в проде не задаётся.
  apiBaseUrl: process.env.MAX_API_BASE_URL || "https://platform-api2.max.ru",
};

// Все даты бот считает в часовом поясе TIMEZONE, а не в поясе сервера: иначе на
// хостинге в UTC игра «21:30» превратилась бы в 00:30 по Москве следующего дня,
// а с ней съехали бы напоминания и оплата. Node применяет TZ на лету.
process.env.TZ = config.timezone;
