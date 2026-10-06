import { config } from "./config";
import { getGameTime, loadSchedule } from "./settingsStore";

/**
 * День игры считается от расписания публикации: игра — на следующий день после
 * дня публикации, в GAME_TIME (или время из /описание). Расписание «Вт, Чт, Вс»
 * → игры в Ср, Пт, Пн. Если расписание не еженедельное (сложный cron) —
 * игра в GAME_DAY_OF_WEEK из .env.
 */

export interface WeeklyCron {
  days: number[]; // 0=вс … 6=сб
  hour: number;
  minute: number;
  second: number;
}

/** Разбор cron вида «[сек] мин час * * дни»; null — расписание не еженедельное. */
export function parseWeeklyCron(expression: string): WeeklyCron | null {
  const f = expression.trim().split(/\s+/);
  if (f.length !== 5 && f.length !== 6) return null;
  const [sec, min, hour, dom, mon, dow] = f.length === 6 ? f : ["0", ...f];
  if (dom !== "*" || mon !== "*" || ![sec, min, hour].every((x) => /^\d+$/.test(x))) return null;
  const days = dow.split(",").map(Number);
  if (!days.every((d) => Number.isInteger(d) && d >= 0 && d <= 7)) return null;
  return { days: [...new Set(days.map((d) => d % 7))], hour: Number(hour), minute: Number(min), second: Number(sec) };
}

/** Действующее расписание публикации: из /расписание, иначе CRON_SCHEDULE. */
export function effectiveScheduleCron(chatId: number): string {
  return loadSchedule(chatId)?.cron ?? config.cronSchedule;
}

/** Дни недели игр: следующий день после каждого дня публикации. */
export function gameWeekdays(chatId: number): number[] {
  const weekly = parseWeeklyCron(effectiveScheduleCron(chatId));
  if (!weekly) return [config.gameDayOfWeek];
  return [...new Set(weekly.days.map((d) => (d + 1) % 7))].sort((a, b) => a - b);
}

/** Ближайшая игра строго после `from`: ближайший игровой день, время игры. */
export function computeNextGameDate(chatId: number, from: Date = new Date()): Date {
  const [hours, minutes] = getGameTime(chatId).split(":").map(Number);
  const days = gameWeekdays(chatId);
  for (let add = 0; add <= 7; add++) {
    const d = new Date(from);
    d.setDate(d.getDate() + add);
    d.setHours(hours, minutes, 0, 0);
    if (days.includes(d.getDay()) && d.getTime() > from.getTime()) return d;
  }
  throw new Error("не удалось вычислить дату игры"); // недостижимо: за 8 дней игровой день есть всегда
}

/** Когда бот сам опубликует следующую запись (для /статус); null — расписание не еженедельное. */
export function nextPublicationDate(chatId: number, from: Date = new Date()): Date | null {
  const weekly = parseWeeklyCron(effectiveScheduleCron(chatId));
  if (!weekly) return null;
  for (let add = 0; add <= 7; add++) {
    const d = new Date(from);
    d.setDate(d.getDate() + add);
    d.setHours(weekly.hour, weekly.minute, weekly.second, 0);
    if (weekly.days.includes(d.getDay()) && d.getTime() > from.getTime()) return d;
  }
  return null;
}

/** Запись принимает игроков до начала игры; после — закрыта (список фиксируется). */
export function isSignupOpen(session: { date: string; closedAt?: number }, now = Date.now()): boolean {
  return !session.closedAt && now < new Date(session.date).getTime();
}
