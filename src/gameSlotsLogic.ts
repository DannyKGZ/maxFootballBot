import { config } from "./config";
import { computeNextGameDate, nextPublicationDate } from "./gameDays";
import { applyChatSchedule } from "./scheduler";
import { currentScheduleText, slotsText } from "./scheduleLogic";
import { isChatAdmin } from "./sessionLogic";
import { GameSlot, setGameSlots } from "./settingsStore";

/**
 * /игры (только админ) — у каждой игры свой день публикации и своё время:
 *   /игры Пн 12:00 Ср 21:20, Чт 12:00 Вс 20:20
 * → в Пн в 12:00 бот открывает запись на Ср 21:20, в Чт в 12:00 — на Вс 20:20.
 * Заменяет /расписание этого чата; /игры сброс — вернуть обычное расписание.
 */
export const GAMES_RE = /^\/(игры|games)(?:\s+([\s\S]+))?$/i;

const DAY_PREFIXES: Array<[RegExp, number]> = [
  [/^(пн|пон)/, 1],
  [/^(вт)/, 2],
  [/^(ср)/, 3],
  [/^(чт|чет)/, 4],
  [/^(пт|пят)/, 5],
  [/^(сб|суб)/, 6],
  [/^(вс|вос)/, 0],
];

function parseDay(word: string): number | null {
  const w = word.toLowerCase().replace(/ё/g, "е");
  return DAY_PREFIXES.find(([re]) => re.test(w))?.[1] ?? null;
}

function parseTime(text: string): string | null {
  const m = text.match(/^(\d{1,2})[:.](\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

const PAIR_RE = /([а-яё]+)\s+(\d{1,2}[:.]\d{2})\s*(?:→|->|—|-|=>)?\s*([а-яё]+)\s+(\d{1,2}[:.]\d{2})/gi;

/** «Пн 12:00 Ср 21:20, Чт 12:00 Вс 20:20» → пары; строка — ошибка. */
export function parseSlots(text: string): GameSlot[] | string {
  const slots: GameSlot[] = [];
  for (const m of text.matchAll(PAIR_RE)) {
    const pub = parseDay(m[1]);
    const game = parseDay(m[3]);
    const pubTime = parseTime(m[2].replace(".", ":"));
    const time = parseTime(m[4].replace(".", ":"));
    if (pub === null || game === null) return `Не понял день недели в «${m[0]}». Пишите Пн, Вт, Ср, Чт, Пт, Сб, Вс.`;
    if (!pubTime || !time) return `Не понял время в «${m[0]}». Формат ЧЧ:ММ, например 21:20.`;
    slots.push({ pub, pubTime, game, time });
  }
  return slots.length ? slots : "Не нашёл ни одной пары «день время публикации — день время игры».";
}

const HELP = [
  "Формат: /игры <день публикации> <время> <день игры> <время игры>, пары через запятую. Например:",
  "/игры Пн 12:00 Ср 21:20, Чт 12:00 Вс 20:20",
  "— в Пн в 12:00 бот откроет запись на игру в Ср в 21:20, в Чт в 12:00 — на Вс в 20:20.",
  "/игры сброс — вернуть обычное расписание (/расписание, игра на следующий день).",
].join("\n");

const fmt = (d: Date) =>
  `${["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"][d.getDay()]} ${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** Текст ответа админу. `groupChatId` — чат, чьи игры настраиваем (команда может прийти из лички). */
export async function gamesCommand(groupChatId: number, userId: number, arg?: string): Promise<string> {
  if (!(await isChatAdmin(groupChatId, userId))) return "Эта команда доступна только администраторам чата.";
  const text = arg?.trim();
  if (!text) return `Сейчас: ${currentScheduleText(groupChatId)}.\n\n${HELP}`;

  if (/^(сброс|reset)$/i.test(text)) {
    setGameSlots(groupChatId, null);
    applyChatSchedule(groupChatId);
    return `♻️ Игры по /игры отключены. Теперь: ${currentScheduleText(groupChatId)}.`;
  }

  const slots = parseSlots(text);
  if (typeof slots === "string") return `${slots}\n\n${HELP}`;
  setGameSlots(groupChatId, slots);
  applyChatSchedule(groupChatId);
  const next = nextPublicationDate(groupChatId)!;
  return [
    `✅ Игры чата: ${slotsText(slots)} (${config.timezone}).`,
    `Ближайшая запись откроется ${fmt(next)} — на игру ${fmt(computeNextGameDate(groupChatId, next))}.`,
    "Текущую запись это не меняет. /игры сброс — вернуть обычное расписание.",
  ].join("\n");
}
