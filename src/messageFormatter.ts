import { config } from "./config";
import { MvpEntry, getRosterTemplate } from "./settingsStore";
import { FootballSession, VoteCandidate, VoteSession } from "./types";

const WEEKDAYS_RU = [
  "Воскресенье",
  "Понедельник",
  "Вторник",
  "Среда",
  "Четверг",
  "Пятница",
  "Суббота",
];

function formatDateRu(date: Date): string {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}.${month}.${year}`;
}

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
  const d = new Date(session.date);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
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

export function buildRosterText(session: FootballSession): string {
  const header = rosterTitle(session);

  if (session.players.length === 0) {
    return `${header}\n\nПока никто не записался. Чтобы записаться, напишите +Имя`;
  }

  const lines = session.players.map((player, index) => {
    const number = index + 1;
    const reserveTag = player.isReserve ? " (Резерв)" : "";
    const fullName = player.lastName ? `${player.displayName} ${player.lastName}` : player.displayName;
    const profileTag = player.profileName ? ` (${player.profileName})` : "";
    return `${number}. ${fullName}${profileTag}${reserveTag}`;
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

/** Строка кандидата: "Валера — 3 голоса · Ruslan ×3" (без голосов — просто "— 0 голосов"). */
function candidateVoteLine(vote: VoteSession, c: VoteCandidate, count: number): string {
  const voters = count > 0 ? ` · ${votersOf(vote, c.index)}` : "";
  return `${c.displayName} — ${count} ${votesWord(count)}${voters}`;
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
  const date = new Date(vote.gameDate);
  const weekday = WEEKDAYS_RU[date.getDay()];
  const header = `🏆 Голосование за MVP матча ${weekday} ${formatDateRu(date)} года`;
  const rules =
    "Голосуют только игроки основы: у каждого столько голосов, сколько у него записей в основе (себя и друзей). За себя голосовать нельзя. Нажмите на игрока ниже.";
  return [header, rules, "", `Отдано голосов: ${vote.votes.length} из ${totalVotes(vote)}`, ...voterLines(vote)].join("\n");
}

/** Голоса по кандидатам, от большего к меньшему (при равенстве — по порядку в списке). */
export function rankCandidates(vote: VoteSession): Array<VoteCandidate & { count: number }> {
  const counts = voteCounts(vote);
  return vote.candidates
    .map((c) => ({ ...c, count: counts[c.index] || 0 }))
    .sort((a, b) => b.count - a.count);
}

/** Победители голосования (несколько — при ничьей); пусто, если голосов не было. */
export function getVoteWinners(vote: VoteSession): string[] {
  if (vote.votes.length === 0) return [];
  const ranked = rankCandidates(vote);
  return ranked.filter((c) => c.count === ranked[0].count).map((c) => c.displayName);
}

/** Итоговое сообщение после завершения голосования — остаётся в чате при очистке. */
export function buildMvpResultText(vote: VoteSession): string {
  const date = new Date(vote.gameDate);
  const weekday = WEEKDAYS_RU[date.getDay()];
  const header = `🏆 MVP матча ${weekday} ${formatDateRu(date)} года`;

  if (vote.votes.length === 0) {
    return `${header}\n\nГолосов не было — победитель не определён.`;
  }

  const ranked = rankCandidates(vote);
  const topCount = ranked[0].count;
  const winners = getVoteWinners(vote);
  const winnerLine =
    winners.length === 1
      ? `Победитель: ${winners[0]} — ${topCount} ${votesWord(topCount)}`
      : `Ничья: ${winners.join(", ")} — по ${topCount} ${votesWord(topCount)}`;

  // В итогах — только те, за кого голосовали.
  const resultLines = ranked
    .filter((c) => c.count > 0)
    .map((c, i) => `${i + 1}. ${barLine(vote, c, c.count)} · ${votersOf(vote, c.index)}`);

  return [
    header,
    winnerLine,
    "Победителю засчитан MVP в общий рейтинг (команда /mvp).",
    "",
    "Результаты:",
    ...resultLines,
  ].join("\n");
}

/** Рейтинг MVP по команде /mvp: сезон и за всё время. */
export function buildMvpRatingText(rating: MvpEntry[], seasonStart: Date | null = null): string {
  const medals = ["🥇", "🥈", "🥉"];
  const table = (entries: Array<{ name: string; n: number }>) =>
    entries.length
      ? entries.map((e, i) => `${medals[i] ?? `${i + 1}.`} ${e.name} — ${e.n}`)
      : ["пока никого"];

  const season = rating
    .filter((e) => e.season > 0)
    .map((e) => ({ name: e.name, n: e.season }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, "ru"));
  const total = rating.filter((e) => e.count > 0).map((e) => ({ name: e.name, n: e.count }));

  if (total.length === 0) {
    return "🏆 Рейтинг MVP пока пуст — после первого голосования здесь появятся игроки.";
  }
  const since = seasonStart ? ` (с ${formatDateRu(seasonStart)})` : "";
  return ["🏆 Рейтинг MVP", "", `Сезон${since}:`, ...table(season), "", "За всё время:", ...table(total)].join("\n");
}

/** Напоминание перед игрой (за REMINDER_HOURS_BEFORE часов). */
export function buildReminderText(session: FootballSession): string {
  const date = new Date(session.date);
  const main = session.players.filter((p) => !p.isReserve).length;
  const reserve = session.players.length - main;
  const today = new Date().toDateString() === date.toDateString();
  const when = today ? "Сегодня" : `${WEEKDAYS_RU[date.getDay()]} ${formatDateRu(date)}`;
  return [
    `⏰ ${when} футбол в ${gameTimeOf(session)}.`,
    `В основе: ${main} из ${config.maxPlayers}, в резерве: ${reserve}.`,
    "Кто не сможет прийти — напишите «-» или нажмите «Убрать себя», чтобы место досталось резерву.",
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
export function buildPaymentText(session: FootballSession, phase: "before" | "after", hours: number): string {
  const date = new Date(session.date);
  const main = session.players.filter((p) => !p.isReserve);
  const byUser = new Map<number, typeof main>();
  for (const p of main) byUser.set(p.userId, [...(byUser.get(p.userId) ?? []), p]);

  const lines = [...byUser.entries()].map(([userId, players]) => {
    const self = players.find((p) => p.profileName) ?? players[0];
    // Для упоминания нужно полное имя из профиля (см. mention): у записавшегося
    // себя это profileName, у записавшего друзей — addedByFullName.
    const payer = self.profileName ?? self.addedByFullName ?? self.addedByName ?? self.displayName;
    const sum = players.length * config.paymentAmount;
    const who = players.length > 1 || players[0] !== self || !self.profileName
      ? ` (${players.map((p) => escapeHtml(p.displayName)).join(", ")})`
      : "";
    return `${mention(userId, payer)} — ${sum} ₽${who}`;
  });

  const when =
    phase === "before"
      ? `до игры ${hours} ч`
      : "игра прошла — не забудьте оплатить";
  return [
    `💰 Оплата за игру ${WEEKDAYS_RU[date.getDay()]} ${formatDateRu(date)}, ${gameTimeOf(session)} (${when})`,
    `За игру ${config.paymentAmount} ₽ с игрока на ${escapeHtml(config.paymentDetails)}`,
    "",
    ...lines,
  ].join("\n");
}
