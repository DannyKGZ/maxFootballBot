import { WEEKDAYS, WEEKDAYS_SHORT, dateFull, dateShort, gameWhen, timeHM } from "./format";

/** «Пт 09.10» — день игры коротко. */
const gameDay = (iso: string) => `${WEEKDAYS_SHORT[new Date(iso).getDay()]} ${dateShort(new Date(iso))}`;
import { SEASON_MONTHS, seasonLabel, seasonOf } from "./gameSeasons";
import { MvpEntry, getMaxPlayers, getPayment, getRole, isRoleHolderEntry, getRosterTemplate } from "./settingsStore";
import { FootballSession, Player, VoteCandidate, VoteSession } from "./types";

const WEEKDAYS_RU = WEEKDAYS;
const formatDateRu = dateFull;

/**
 * Формат сообщения по ТЗ (п.3):
 *
 * Футбол в Среда 23.09.2027 года
 * В 21:30
 *
 * 1. Сергей
 * 2. Владимир
 * ...
 * 15. Игрок
 * 16. Руслан (Резерв)
 */
/** «ЧЧ:ММ» игры этой записи (из её даты — может отличаться от GAME_TIME после /описание). */
export function gameTimeOf(session: FootballSession): string {
  return timeHM(new Date(session.date));
}

export const DEFAULT_ROSTER_TEMPLATE = "Футбол в {День} {дата} года\nВ {время}";

/** Подставляет в шаблон шапки день недели, дату и время игры этой записи. */
export function renderRosterTemplate(template: string, session: FootballSession): string {
  const date = new Date(session.date);
  const weekday = WEEKDAYS_RU[date.getDay()];
  return template
    .replace(/\{День\}/g, weekday)
    .replace(/\{день\}/g, weekday.toLowerCase())
    .replace(/\{дата_кратко\}/g, formatDateRu(date).slice(0, 5))
    .replace(/\{дата\}/g, formatDateRu(date))
    .replace(/\{время\}/g, gameTimeOf(session));
}

/** Шапка записи: шаблон из /описание или стандартная «Футбол в Среда … / В …». */
export function rosterTitle(session: FootballSession): string {
  return renderRosterTemplate(getRosterTemplate(session.chatId) ?? DEFAULT_ROSTER_TEMPLATE, session);
}

/** «— Легенда 🏆🏅⚽» / «— 👕 манишкаНосец» у своей записи носителя роли. */
export function roleTag(session: FootballSession, player: Player): string {
  if (isRoleHolderEntry(player, getRole(session.chatId, "legend"))) return " — Легенда 🏆🏅⚽";
  if (isRoleHolderEntry(player, getRole(session.chatId, "maniska"))) return " — 👕 манишкаНосец";
  return "";
}

export function buildRosterText(session: FootballSession): string {
  const header = rosterTitle(session);

  if (session.players.length === 0) {
    return `${header}\n\nПока никого. Записаться: «+», друга — «+Имя».`;
  }

  const lines = session.players.map((player, index) => {
    const number = index + 1;
    const reserveTag = player.isReserve ? " (Резерв)" : "";
    // Только имя (или своё имя из /имя) — фамилия из профиля MAX в списке не нужна.
    return `${number}. ${player.displayName}${roleTag(session, player)}${reserveTag}`;
  });

  return `${header}\n\n${lines.join("\n")}`;
}

/** Склонение: 1 голос, 2 голоса, 5 голосов. */
function votesWord(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "голос";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "голоса";
  return "голосов";
}

/** Сколько голосов у каждого кандидата (index -> число). */
export function voteCounts(vote: VoteSession): Record<number, number> {
  const counts: Record<number, number> = {};
  for (const v of vote.votes) counts[v.candidateIndex] = (counts[v.candidateIndex] || 0) + 1;
  return counts;
}

/** Кто отдал голоса за кандидата: "Ruslan ×3, Рома" (в порядке первого голоса). */
function votersOf(vote: VoteSession, candidateIndex: number): string {
  const byVoter = new Map<number, { name: string; count: number }>();
  for (const v of vote.votes) {
    if (v.candidateIndex !== candidateIndex) continue;
    const entry = byVoter.get(v.voterId) ?? { name: v.voterName, count: 0 };
    entry.count += 1;
    byVoter.set(v.voterId, entry);
  }
  return [...byVoter.values()]
    .map((e) => (e.count > 1 ? `${e.name} ×${e.count}` : e.name))
    .join(", ");
}

/** Сколько голосов всего можно отдать: сумма голосов всех голосующих (= игроков основы). */
export function totalVotes(vote: VoteSession): number {
  return Object.values(vote.creditsByVoter).reduce((a, b) => a + b, 0);
}

/** Прогресс-бар из 10 делений: доля голосов кандидата от всех возможных. ▰▰▰▰▱▱▱▱▱▱ */
export function progressBar(count: number, total: number, width = 10): string {
  const filled = total > 0 ? Math.min(width, Math.round((count / total) * width)) : 0;
  return "▰".repeat(filled) + "▱".repeat(width - filled);
}

/** «Димас ▰▰▰▰▱▱▱▱▱▱ 4» */
function barLine(vote: VoteSession, c: VoteCandidate, count: number): string {
  return `${c.displayName} ${progressBar(count, totalVotes(vote))} ${count}`;
}

/** Голосующие с отметками: 🔴 — ещё не голосовал, ✅ — проголосовал (и за кого). */
function voterLines(vote: VoteSession): string[] {
  return Object.entries(vote.creditsByVoter).map(([id, credits]) => {
    const voterId = Number(id);
    const name = vote.voterNames[voterId] ?? "игрок";
    const mine = vote.votes.filter((v) => v.voterId === voterId);
    if (mine.length === 0) return `🔴 ${name}${credits > 1 ? ` — голосов: ${credits}` : ""}`;
    const left = credits - mine.length;
    return `✅ ${name} → ${mine.map((v) => v.candidateName).join(", ")}${left > 0 ? ` (ещё ${left})` : ""}`;
  });
}

/**
 * Живое сообщение голосования: кто уже проголосовал (✅, и за кого) и кто ещё
 * нет (🔴). Счёт и прогресс-бар — прямо на кнопках кандидатов. После каждого
 * голоса бот присылает свежее сообщение внизу чата.
 */
export function buildVoteText(vote: VoteSession): string {
  const header = `🏆 Голосование за MVP — ${gameDay(vote.gameDate)}`;
  const rules = "Голосует основа: голосов столько, сколько ваших записей в основе. За себя нельзя.";
  return [header, rules, "", `Голосов: ${vote.votes.length} из ${totalVotes(vote)}`, ...voterLines(vote)].join("\n");
}

/** Голоса по кандидатам, от большего к меньшему (при равенстве — по порядку в списке). */
export function rankCandidates(vote: VoteSession): Array<VoteCandidate & { count: number }> {
  const counts = voteCounts(vote);
  return vote.candidates
    .map((c) => ({ ...c, count: counts[c.index] || 0 }))
    .sort((a, b) => b.count - a.count);
}

/** Больше скольких MVP в одном матче не бывает (ничья на первом месте). */
export const MAX_MVP_WINNERS = 3;

/**
 * Победители голосования: все, у кого больше всех голосов (ничья), но не больше
 * MAX_MVP_WINNERS — при ничьей у большего числа игроков MVP получают те, кто
 * набрал это число голосов раньше. Пусто, если голосов не было.
 */
export function getVoteWinners(vote: VoteSession): string[] {
  if (vote.votes.length === 0) return [];
  const ranked = rankCandidates(vote);
  const top = ranked.filter((c) => c.count === ranked[0].count);
  // Когда кандидат набрал свой итоговый счёт — по времени последнего голоса за него.
  const reachedAt = (index: number) => Math.max(...vote.votes.filter((v) => v.candidateIndex === index).map((v) => v.createdAt));
  const order = top.length > MAX_MVP_WINNERS ? [...top].sort((a, b) => reachedAt(a.index) - reachedAt(b.index)) : top;
  return order.slice(0, MAX_MVP_WINNERS).map((c) => c.displayName);
}

/** Итоговое сообщение после завершения голосования — остаётся в чате при очистке. */
/** `congrats` — поздравления победителям (по одному на каждого, в порядке getVoteWinners). */
export function buildMvpResultText(vote: VoteSession, congrats: string[] = []): string {
  const header = `🏆 MVP матча ${gameDay(vote.gameDate)}`;
  if (vote.votes.length === 0) return `${header}: голосов не было.`;

  const ranked = rankCandidates(vote);
  const topCount = ranked[0].count;
  const winners = getVoteWinners(vote);
  const winnerLine =
    winners.length === 1
      ? `${header} — ${winners[0]} (${topCount} ${votesWord(topCount)})`
      : `${header} — ${winners.join(", ")} (по ${topCount} ${votesWord(topCount)})`;

  // В итогах — только те, за кого голосовали.
  // Победители — первыми (при ничьей больше чем на троих не все из лидеров — MVP).
  const isWinner = (c: VoteCandidate) => winners.includes(c.displayName);
  const resultLines = ranked
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count || Number(isWinner(b)) - Number(isWinner(a)))
    .map((c, i) => `${i + 1}. ${barLine(vote, c, c.count)} · ${votersOf(vote, c.index)}`);

  const congratLines = winners.flatMap((w, i) => (congrats[i] ? ["", `🎉 ${w}! ${congrats[i]}`] : []));
  return [
    winnerLine,
    ...congratLines,
    "",
    "Результаты:",
    ...resultLines,
  ].join("\n");
}

/** Рейтинг MVP по команде /mvp: сезон и за всё время. */
export function buildMvpRatingText(rating: MvpEntry[], seasonStart: Date | null = null, now = new Date()): string {
  const medals = ["🥇", "🥈", "🥉"];
  const table = (entries: Array<{ name: string; n: number }>) =>
    entries.length
      ? entries.map((e, i) => `${medals[i] ?? `${i + 1}.`} ${e.name} — ${e.n}`)
      : ["пока никого"];

  const season = rating
    .filter((e) => e.season > 0)
    .map((e) => ({ name: e.name, n: e.season }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, "ru"));
  const year = rating
    .filter((e) => e.year > 0)
    .map((e) => ({ name: e.name, n: e.year }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, "ru"));
  const total = rating.filter((e) => e.count > 0).map((e) => ({ name: e.name, n: e.count }));

  if (total.length === 0) {
    return "🏆 Рейтинг MVP пуст — появится после первого голосования.";
  }
  // Сезон — по календарю (Зима дек–фев, Весна, Лето, Осень сен–ноя); если админ сбрасывал
  // сезон вручную позже начала сезона — показываем, с какого дня идёт счёт.
  const s = seasonOf(now);
  const since = seasonStart && seasonStart.getTime() > s.start.getTime() + 86_400_000 ? `с ${formatDateRu(seasonStart)}` : SEASON_MONTHS[s.name];
  return [
    "🏆 Рейтинг MVP",
    "",
    `Сезон «${seasonLabel(s)}» (${since}):`,
    ...table(season),
    "",
    `Год ${s.gameYear} (с 01.12.${s.gameYear - 1}), лучший — легенда года:`,
    ...table(year),
    "",
    "За всё время:",
    ...table(total),
  ].join("\n");
}

/** Напоминание перед игрой (за REMINDER_HOURS_BEFORE часов). */
export function buildReminderText(session: FootballSession): string {
  const date = new Date(session.date);
  const main = session.players.filter((p) => !p.isReserve).length;
  const reserve = session.players.length - main;
  const today = new Date().toDateString() === date.toDateString();
  const when = today ? "Сегодня" : `${WEEKDAYS_SHORT[date.getDay()]} ${dateShort(date)}`;
  return [
    `⏰ ${when} в ${gameTimeOf(session)} футбол. Основа ${main}/${getMaxPlayers(session.chatId)}, резерв ${reserve}.`,
    "Не придёте — «-» или «➖ Убрать себя».",
  ].join("\n");
}

// ---- Упоминания и оплата ----

/** Экранирование для format: "html" — имена пишут сами участники. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Полное имя из профиля MAX: `name`, иначе «имя фамилия». */
export function fullName(user: { first_name?: string; last_name?: string; name?: string }): string {
  return (user.name || [user.first_name, user.last_name].filter(Boolean).join(" ")).trim();
}

/**
 * Упоминание пользователя MAX (приходит уведомление): <a href="max://user/ID">Имя</a>.
 * Важно: MAX превращает ссылку в упоминание, только если `name` — полное имя из
 * профиля. С одним first_name у людей с фамилией упоминание молча не срабатывает.
 */
export function mention(userId: number, name: string): string {
  return `<a href="max://user/${userId}">${escapeHtml(name)}</a>`;
}

/**
 * Напоминание об оплате (format: "html"). Платит основа: по каждому, кто
 * записывал, — сумма за всех его игроков и упоминание, чтобы пришло уведомление.
 */
/** Строки «@Ruslan — 700 ₽ (Ruslan, Петя)» по каждому, кто записывал игроков основы (html, с упоминаниями). */
export function paymentPayerLines(session: FootballSession): string[] {
  const main = session.players.filter((p) => !p.isReserve);
  const payment = getPayment(session.chatId);
  const byUser = new Map<number, typeof main>();
  for (const p of main) byUser.set(p.userId, [...(byUser.get(p.userId) ?? []), p]);

  return [...byUser.entries()].map(([userId, players]) => {
    const self = players.find((p) => p.profileName) ?? players[0];
    // Для упоминания нужно полное имя из профиля (см. mention): у записавшегося
    // себя это profileName, у записавшего друзей — addedByFullName.
    const payer = self.profileName ?? self.addedByFullName ?? self.addedByName ?? self.displayName;
    const sum = players.length * payment.amount;
    const who = players.length > 1 || players[0] !== self || !self.profileName
      ? ` (${players.map((p) => escapeHtml(p.displayName)).join(", ")})`
      : "";
    return `${mention(userId, payer)} — ${sum} ₽${who}`;
  });
}

/** «За игру 350 ₽ с игрока на …» (html). */
/** «💳 Сбер 0000000000» — реквизиты (html). */
export function paymentDetailsLine(chatId: number): string {
  const details = escapeHtml(getPayment(chatId).details);
  return /^\p{Extended_Pictographic}/u.test(details) ? details : `💳 ${details}`;
}

/** «💰 Оплата за игру Пт 09.10, 20:30 — 350 ₽ с игрока» */
export function paymentHeader(chatId: number, gameDate: string): string {
  return `💰 Оплата за игру ${gameWhen(new Date(gameDate))} — ${getPayment(chatId).amount} ₽ с игрока`;
}

export function buildPaymentText(session: FootballSession, phase: "before" | "after", hours: number): string {
  const when = phase === "before" ? `до игры ${hours} ч` : "игра прошла";
  return [`${paymentHeader(session.chatId, session.date)} (${when})`, paymentDetailsLine(session.chatId), "", ...paymentPayerLines(session)].join("\n");
}
