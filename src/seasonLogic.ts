import { dateFull } from "./format";
import * as api from "./maxApi";
import { fullName } from "./messageFormatter";
import { GameSeason, SEASON_MONTHS, seasonLabel, seasonOf } from "./gameSeasons";
import { assign, holderFromMember } from "./rolesLogic";
import {
  RoleHolder,
  getMvpPeriod,
  getMvpRating,
  getMvpUser,
  getNickname,
  legendUntil,
  resetSeasonCounts,
  resetYearCounts,
  setMvpPeriod,
} from "./settingsStore";

/**
 * Смена сезона и игрового года (проверяется по таймеру, см. scheduler.ts):
 *  - новый сезон (1 декабря, 1 марта, 1 июня, 1 сентября) — сезонный рейтинг MVP с нуля;
 *  - 1 декабря заканчивается игровой год: у кого больше всех MVP за год — тот
 *    «Легенда года» (роль легенды на год: всегда 1-й в записи), годовой счёт с нуля.
 * При ничьей или если не удалось понять, чей это аккаунт, — легенду выбирает админ (/легенда).
 */

const fmtDate = dateFull;

/** Аккаунт победителя: из записи о его победах, иначе участник чата с таким именем (если он один). */
async function holderFor(chatId: number, name: string): Promise<RoleHolder | null> {
  const known = getMvpUser(chatId, name);
  if (known) return known;
  const lower = name.trim().toLowerCase();
  const members = await api.listChatMembers(chatId).catch(() => []);
  const match = members.filter(
    (m) =>
      fullName(m).toLowerCase() === lower ||
      (m.first_name ?? "").trim().toLowerCase() === lower ||
      (getNickname(m.user_id) ?? "").trim().toLowerCase() === lower,
  );
  return match.length === 1 ? holderFromMember(match[0]) : null;
}

/** Итоги игрового года → текст объявления (и назначение легенды года). */
async function crownLegendOfYear(chatId: number, gameYear: number, rating: ReturnType<typeof getMvpRating>, start: Date): Promise<string> {
  const year = rating.filter((e) => e.year > 0).sort((a, b) => b.year - a.year);
  if (!year.length) return `🏆 Год ${gameYear} закончился: MVP не было, легенды года нет.`;
  const top = year.filter((e) => e.year === year[0].year);
  const table = year.slice(0, 5).map((e, i) => `${["🥇", "🥈", "🥉"][i] ?? `${i + 1}.`} ${e.name} — ${e.year}`);
  if (top.length > 1) {
    return [
      `🏆 Итоги года ${gameYear}: ничья — по ${top[0].year} MVP у ${top.map((e) => e.name).join(", ")}. Легенду выбирает админ: /легенда`,
      "",
      ...table,
    ].join("\n");
  }
  const holder = await holderFor(chatId, top[0].name);
  if (!holder) {
    return [
      `🏆 Легенда ${gameYear} года — ${top[0].name} (${top[0].year} MVP). Аккаунт в чате не найден — админ: /легенда ${top[0].name}`,
      "",
      ...table,
    ].join("\n");
  }
  holder.since = start.getTime(); // ровно год — с 1 декабря
  await assign(chatId, "legend", holder);
  return [
    `🏆 Легенда ${gameYear} года — ${top[0].name} (${top[0].year} MVP)! 🏆🏅⚽ 1-й в каждой записи до ${fmtDate(legendUntil(holder))}.`,
    "",
    ...table,
  ].join("\n");
}

function seasonStartText(s: GameSeason): string {
  return `🗓 Сезон «${seasonLabel(s)}» (${SEASON_MONTHS[s.name]}): сезонный рейтинг MVP обнулён.`;
}

/** Проверить смену сезона/года для чата; при смене — сбросить счёт и объявить. */
export async function rolloverIfDue(chatId: number, now = new Date()): Promise<void> {
  const current = seasonOf(now);
  const stored = getMvpPeriod(chatId);
  if (stored === current.key) return;
  if (!stored) {
    // Первый запуск: текущий счёт и есть счёт этого сезона и года — только запоминаем сезон.
    setMvpPeriod(chatId, current.key, current.start);
    return;
  }
  const previousYear = Number(stored.split("-")[0]);
  const rating = getMvpRating(chatId); // до сброса — для итогов года
  // Сначала отмечаем сезон (повторная проверка уже ничего не сделает), потом объявляем.
  setMvpPeriod(chatId, current.key, current.start);
  resetSeasonCounts(chatId);
  const messages: string[] = [];
  if (previousYear !== current.gameYear) {
    resetYearCounts(chatId);
    messages.push(await crownLegendOfYear(chatId, previousYear, rating, current.start));
  }
  messages.push(seasonStartText(current));
  console.log(`[season] чат ${chatId}: ${stored} → ${current.key}`);
  for (const text of messages) await api.sendMessageToChat(chatId, { text });
}
