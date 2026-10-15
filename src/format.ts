/** Общие форматы дат и повторяющиеся тексты. */

export const WEEKDAYS = ["Воскресенье", "Понедельник", "Вторник", "Среда", "Четверг", "Пятница", "Суббота"];
export const WEEKDAYS_SHORT = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

export const pad = (n: number) => String(n).padStart(2, "0");

/** 09.10.2026 */
export const dateFull = (d: Date) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
/** 09.10 */
export const dateShort = (d: Date) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}`;
/** 20:30 */
export const timeHM = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
/** «Пт 09.10, 20:30» — день и время игры коротко. */
export const gameWhen = (d: Date) => `${WEEKDAYS_SHORT[d.getDay()]} ${dateShort(d)}, ${timeHM(d)}`;

export const NOT_ADMIN = "Только для админов чата.";
