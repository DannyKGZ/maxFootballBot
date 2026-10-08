import { config } from "./config";
import * as api from "./maxApi";
import { voteCandidatesKeyboard } from "./keyboard";
import {
  buildMvpRatingText,
  buildMvpResultText,
  buildVoteText,
  getVoteWinners,
  totalVotes,
  voteCounts,
} from "./messageFormatter";
import { isChatAdmin } from "./sessionLogic";
import { addMvpWins, getMvpRating, getSeasonStart } from "./settingsStore";
import {
  deleteVoteSession,
  getArchivedSession,
  getRatingMessage,
  getSession,
  getVoteSession,
  setRatingMessage,
  setSession,
  setVoteSession,
  takeSentMessagesForCleanup,
} from "./store";
import { FootballSession, VoteCandidate, VoteSession } from "./types";
import { maniskaPromptMessageId, postManiskaPrompt } from "./rolesLogic";

/**
 * Голосование за MVP матча. Правила (по ТЗ):
 *  - голосовать может только тот, кто был записан на игру (по userId в составе);
 *  - у кого несколько записей (себя + друзей/знакомых) — столько же голосов;
 *  - кто не был записан — участвовать не может, но видит в чате, кто за кого
 *    проголосовал (голосование не анонимное, лог голосов открыт всем);
 *  - после подведения итогов чат очищается от всех сообщений бота, кроме
 *    сообщения с записью на игру и итогового сообщения MVP.
 */

export type StartVoteOutcome = "not_admin" | "no_session" | "already_active" | "started";

/** Считает, сколько раз каждый userId встречается в составе — это и есть его лимит голосов. */
function buildCredits(playerUserIds: number[]): Record<number, number> {
  const credits: Record<number, number> = {};
  for (const userId of playerUserIds) {
    credits[userId] = (credits[userId] || 0) + 1;
  }
  return credits;
}

/**
 * За какую игру голосуем: за последнюю уже сыгранную (дата игры прошла) —
 * текущую или закрытую. Так голосование работает и после того, как в пятницу
 * по расписанию открылась запись на следующую среду. Если сыгранной игры с
 * игроками нет (например, проверяют заранее) — по текущей записи.
 */
export function pickGameForVote(chatId: number, now = Date.now()): FootballSession | undefined {
  const withPlayers = [getSession(chatId), getArchivedSession(chatId)].filter(
    (s): s is FootballSession => Boolean(s && s.players.length > 0),
  );
  const played = withPlayers
    .filter((s) => new Date(s.date).getTime() <= now)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return played[0] ?? withPlayers[0];
}

export async function startVote(chatId: number, adminUserId: number): Promise<StartVoteOutcome> {
  const admin = await isChatAdmin(chatId, adminUserId);
  if (!admin) return "not_admin";
  return openVote(chatId);
}

/**
 * По таймеру: через VOTE_AUTO_START_MINUTES после начала игры (по умолчанию в
 * 21:30 при игре в 20:30) голосование открывается само — один раз на игру.
 */
export async function autoStartVoteIfDue(session: FootballSession, now = Date.now()): Promise<boolean> {
  if (config.voteAutoStartMinutes <= 0 || session.voteAutoStarted) return false;
  const due = new Date(session.date).getTime() + config.voteAutoStartMinutes * 60_000;
  if (now < due) return false;
  // Только в течение 6 часов после срока: по давно прошедшей игре (например, после
  // долгого простоя бота) голосование само не открываем — это сделает админ.
  if (now > due + 6 * 3_600_000) return false;
  if (!session.players.some((p) => !p.isReserve)) return false;
  session.voteAutoStarted = true; // отмечаем до запуска: при сбое лучше пропустить, чем запустить дважды
  setSession(session);
  if (getVoteSession(session.chatId)) return false; // админ уже запустил вручную
  return (await openVote(session.chatId)) === "started";
}

async function openVote(chatId: number): Promise<StartVoteOutcome> {
  if (getVoteSession(chatId)) return "already_active";

  const session = pickGameForVote(chatId);
  if (!session) return "no_session";

  // Только основа: резерв не играл — он не кандидат и голосов не даёт.
  const main = session.players.filter((p) => !p.isReserve);
  const candidates: VoteCandidate[] = main.map((p, index) => ({
    index,
    displayName: p.displayName,
    ownerId: p.userId,
    isSelf: Boolean(p.profileName),
  }));

  const vote: VoteSession = {
    chatId,
    gameDate: session.date,
    candidates,
    creditsByVoter: buildCredits(main.map((p) => p.userId)),
    voterNames: voterNamesFrom(main),
    votes: [],
    messageId: null,
    rosterMessageId: session.messageId,
    createdAt: Date.now(),
  };

  // Кнопка «👕 Я забрал манишки» — перед голосованием, чтобы голосование было последним.
  await postManiskaPrompt(session).catch((err) => console.warn("[voteLogic] не удалось отправить кнопку манишек:", err instanceof Error ? err.message : err));

  const res = await api.sendMessageToChat(chatId, {
    text: buildVoteText(vote),
    attachments: [voteKeyboard(vote)],
  });
  vote.messageId = res.message.body.mid;
  setVoteSession(vote);

  return "started";
}

export type CastVoteOutcome =
  | "self_vote"
  | "no_vote"
  | "not_eligible"
  | "no_credits_left"
  | "invalid_candidate"
  | "voted";

/** Кнопки кандидатов с текущим счётом и прогресс-баром. */
function voteKeyboard(vote: VoteSession) {
  return voteCandidatesKeyboard(vote.candidates, voteCounts(vote), totalVotes(vote));
}

/**
 * Как подписать голосующего в списке «🔴/✅»: своя запись (через «+») — её имя,
 * иначе имя того, кто записывал друзей.
 */
function voterNamesFrom(players: FootballSession["players"]): Record<number, string> {
  const names: Record<number, string> = {};
  for (const p of players) {
    if (p.profileName) names[p.userId] = p.displayName;
    else names[p.userId] ??= p.addedByName ?? p.addedByFullName ?? p.displayName;
  }
  return names;
}

/** Голосованию, начатому старой версией бота, — имена всех голосующих (а не только проголосовавших). */
function ensureVoterNames(vote: VoteSession): void {
  const missing = Object.keys(vote.creditsByVoter).some((id) => !vote.voterNames[Number(id)]);
  if (!missing) return;
  const game = [getSession(vote.chatId), getArchivedSession(vote.chatId)].find((s) => s?.date === vote.gameDate);
  if (!game) return;
  const derived = voterNamesFrom(game.players.filter((p) => !p.isReserve));
  for (const id of Object.keys(vote.creditsByVoter)) vote.voterNames[Number(id)] ??= derived[Number(id)];
  setVoteSession(vote);
}

/**
 * Кандидат — это сам голосующий? Своя запись через «+» (по профилю) или под
 * своим именем. За друзей, которых человек записал, голосовать можно.
 */
function isOwnCandidate(c: VoteCandidate, voterId: number, voterNames: string[]): boolean {
  if (c.ownerId === voterId && c.isSelf) return true;
  const name = c.displayName.trim().toLowerCase();
  return (c.ownerId === undefined || c.ownerId === voterId) && voterNames.some((n) => n && n.trim().toLowerCase() === name);
}

export async function castVote(
  chatId: number,
  voterId: number,
  voterName: string,
  candidateIndex: number,
  voterFullName = voterName,
): Promise<CastVoteOutcome> {
  const vote = getVoteSession(chatId);
  if (!vote) return "no_vote";

  const candidate = vote.candidates.find((c) => c.index === candidateIndex);
  if (!candidate) return "invalid_candidate";

  const credits = vote.creditsByVoter[voterId] || 0;
  if (credits === 0) return "not_eligible";

  const used = vote.votes.filter((v) => v.voterId === voterId).length;
  if (used >= credits) return "no_credits_left";
  if (isOwnCandidate(candidate, voterId, [voterName, voterFullName])) return "self_vote";

  vote.voterNames[voterId] ??= voterName;
  vote.votes.push({
    voterId,
    voterName,
    candidateIndex: candidate.index,
    candidateName: candidate.displayName,
    createdAt: Date.now(),
  });
  setVoteSession(vote);

  // Все игроки основы отдали все голоса — закрываем и показываем итоги сразу.
  if (vote.votes.length >= totalVotes(vote)) {
    await finalizeVote(chatId, "all_voted");
    return "voted";
  }
  await repostVoteMessage(chatId);
  return "voted";
}

/**
 * Свежее сообщение голосования внизу чата, старое удаляется (как со списком
 * записи). Если старое удалить нельзя (старше 24 ч) — снимаем с него кнопки.
 */
export async function repostVoteMessage(chatId: number): Promise<boolean> {
  const vote = getVoteSession(chatId);
  if (!vote) return false;
  ensureVoterNames(vote);
  const old = vote.messageId;
  const res = await api.sendMessageToChat(chatId, {
    text: buildVoteText(vote),
    attachments: [voteKeyboard(vote)],
  });
  vote.messageId = res.message.body.mid;
  setVoteSession(vote);
  if (old) {
    await api.deleteMessage(chatId, old).catch(() =>
      api.editMessage(chatId, old, { text: "🗳 Голосование обновлено — актуальное ниже ⬇️", attachments: [] }).catch(() => undefined),
    );
  }
  return true;
}

/** /голос: показать голосование внизу чата; если его нет — админ запускает новое. */
export async function voteCommand(chatId: number, userId: number): Promise<string | null> {
  if (await repostVoteMessage(chatId)) return null;
  const outcome = await startVote(chatId, userId);
  if (outcome === "not_admin") return "Голосование сейчас не идёт — его запускает админ.";
  if (outcome === "no_session") return "Нет записи с игроками, за которую можно голосовать.";
  return null;
}

export type FinishVoteOutcome = "not_admin" | "no_vote" | "finished";

/** /итоги и кнопка «Итоги» — только админ. */
export async function finishVote(chatId: number, adminUserId: number): Promise<FinishVoteOutcome> {
  if (!(await isChatAdmin(chatId, adminUserId))) return "not_admin";
  if (!getVoteSession(chatId)) return "no_vote";
  await finalizeVote(chatId, false);
  return "finished";
}

/**
 * Подводит итоги: MVP получает +1 в рейтинг, публикуется итог (остаётся в
 * чате), затем удаляются прочие сообщения бота с прошлой очистки — кроме
 * записей (текущей и той, за которую голосовали) и итога.
 */
export async function finalizeVote(chatId: number, reason: boolean | "all_voted"): Promise<void> {
  const vote = getVoteSession(chatId);
  if (!vote) return;
  // Сразу убираем из стора, чтобы повторный вызов (кнопка + таймер) не посчитал MVP дважды.
  deleteVoteSession(chatId);
  if (vote.messageId) await api.deleteMessage(chatId, vote.messageId).catch(() => undefined);

  addMvpWins(chatId, getVoteWinners(vote));
  // MVP этой игры выбран — её дележку больше не держим внизу (stickyLogic.ts).
  const game = getSession(chatId);
  if (game && game.date === vote.gameDate) {
    game.mvpDone = true;
    setSession(game);
  }
  const note =
    reason === "all_voted"
      ? "\n\nВсе проголосовали — голосование закрыто автоматически."
      : reason
        ? "\n\nГолосование закрыто автоматически по времени."
        : "";
  const res = await api.sendMessageToChat(chatId, { text: buildMvpResultText(vote) + note });

  // Составы (дележка с упоминаниями и оплатой) тоже остаются.
  const keep = [
    getSession(chatId)?.messageId,
    getSession(chatId)?.draft?.messageId,
    vote.rosterMessageId,
    res.message.body.mid,
    maniskaPromptMessageId(chatId), // кнопка «Я забрал манишки» нужна и после итогов
  ];
  for (const messageId of takeSentMessagesForCleanup(chatId, keep)) {
    try {
      await api.deleteMessage(chatId, messageId);
    } catch (err) {
      // MAX не даёт удалить сообщения старше 24 часов — это ожидаемо и не критично.
      console.error(`[voteLogic] не удалось удалить сообщение ${messageId}:`, err);
    }
  }
}

// Новое /mvp заменяет прошлое сообщение с рейтингом (id хранится в сторе).
// Запрос, пока идёт другой такой же (например, 5 человек нажали одновременно),
// присоединяется к нему, а не создаёт ещё одно сообщение.
const ratingInFlight = new Map<number, Promise<void>>();

async function postMvpRating(chatId: number): Promise<void> {
  const previous = getRatingMessage(chatId);
  if (previous) {
    try {
      await api.deleteMessage(chatId, previous);
    } catch {
      // старое сообщение уже удалено или слишком старое — не критично
    }
  }
  const res = await api.sendMessageToChat(chatId, { text: buildMvpRatingText(getMvpRating(chatId), getSeasonStart(chatId)) });
  setRatingMessage(chatId, res.message.body.mid);
}

/** Команда /mvp и кнопка «Рейтинг MVP» (доступны всем): общий рейтинг MVP игроков. */
export function showMvpRating(chatId: number): Promise<void> {
  const running = ratingInFlight.get(chatId);
  if (running) return running;
  const task = postMvpRating(chatId).finally(() => ratingInFlight.delete(chatId));
  ratingInFlight.set(chatId, task);
  return task;
}

/** Перерисовать сообщение голосования (например, после перезапуска с новыми правилами). */
export async function refreshVoteMessage(chatId: number): Promise<void> {
  const vote = getVoteSession(chatId);
  if (!vote?.messageId) return;
  ensureVoterNames(vote);
  await api
    .editMessage(chatId, vote.messageId, {
      text: buildVoteText(vote),
      attachments: [voteKeyboard(vote)],
    })
    .catch((err) => console.warn("[voteLogic] не удалось обновить сообщение голосования:", err instanceof Error ? err.message : err));
}
