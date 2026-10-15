/**
 * Игровой календарь: сезоны по временам года (по 3 месяца) и игровой год.
 *   Зима — декабрь–февраль, Весна — март–май, Лето — июнь–август, Осень — сентябрь–ноябрь.
 * Игровой год начинается 1 декабря (с зимы) и заканчивается 30 ноября (осенью);
 * называется по году, в котором заканчивается: декабрь 2025 – ноябрь 2026 → «2026».
 */

export type SeasonName = "Зима" | "Весна" | "Лето" | "Осень";

export interface GameSeason {
  name: SeasonName;
  gameYear: number;
  start: Date; // 1-е число первого месяца сезона, 00:00
  key: string; // «2026-Осень» — чтобы заметить смену сезона
}

const NAMES: SeasonName[] = ["Зима", "Весна", "Лето", "Осень"];
export const SEASON_MONTHS: Record<SeasonName, string> = {
  Зима: "дек–фев",
  Весна: "мар–май",
  Лето: "июн–авг",
  Осень: "сен–ноя",
};

/** Сезон, в который попадает дата (по местному времени — TIMEZONE). */
export function seasonOf(date: Date): GameSeason {
  const month = date.getMonth(); // 0 = январь
  const shifted = (month + 1) % 12; // декабрь → 0, январь → 1, …
  const index = Math.floor(shifted / 3);
  const gameYear = month === 11 ? date.getFullYear() + 1 : date.getFullYear();
  const startMonth = (index * 3 + 11) % 12; // 11 (дек), 2 (мар), 5 (июн), 8 (сен)
  const startYear = startMonth === 11 ? gameYear - 1 : gameYear;
  const name = NAMES[index];
  return { name, gameYear, start: new Date(startYear, startMonth, 1), key: `${gameYear}-${name}` };
}

export function seasonLabel(s: GameSeason): string {
  return `${s.name} ${s.name === "Зима" ? `${s.gameYear - 1}/${String(s.gameYear).slice(2)}` : s.gameYear}`;
}
