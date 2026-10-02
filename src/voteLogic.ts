import * as api from "./maxApi";
import { voteCandidatesKeyboard } from "./keyboard";
import {
  buildMvpRatingText,
  buildMvpResultText,
  buildVoteResultsText,
  buildVoteText,
  getVoteWinners,
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
  setVoteSession,
  takeSentMessagesForCleanup,
} from "./store";
import { FootballSession, VoteCandidate, VoteSession } from "./types";

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

  if (getVoteSession(chatId)) return "already_active";

  const session = pickGameForVote(chatId);
  if (!session) return "no_session";

  // Только основа: резерв не играл — он не кандидат и голосов не даёт.
  const main = session.players.filter((p) => !p.isReserve);
  const candidates: VoteCandidate[] = main.map((p, index) => ({ index, displayName: p.displayName }));

  const vote: VoteSession = {
    chatId,
    gameDate: session.date,
    candidates,
    creditsByVoter: buildCredits(main.map((p) => p.userId)),
    voterNames: {},
    votes: [],
    messageId: null,
    rosterMessageId: session.messageId,
    createdAt: Date.now(),
  };

  const res = await api.sendMessageToChat(chatId, {
    text: buildVoteText(vote),
    attachments: [voteCandidatesKeyboard(candidates)],
  });
  vote.messageId = res.message.body.mid;
  setVoteSession(vote);

  return "started";
}

export type CastVoteOutcome =
  | "no_vote"
  | "not_eligible"
  | "no_credits_left"
  | "invalid_candidate"
  | "voted";

export async function castVote(
  chatId: number,
  voterId: number,
  voterName: string,
  candidateIndex: number,
): Promise<CastVoteOutcome> {
  const vote = getVoteSession(chatId);
  if (!vote) return "no_vote";

  const candidate = vote.candidates.find((c) => c.index === candidateIndex);
  if (!candidate) return "invalid_candidate";

  const credits = vote.creditsByVoter[voterId] || 0;
  if (credits === 0) return "not_eligible";

  const used = vote.votes.filter((v) => v.voterId === voterId).length;
  if (used >= credits) return "no_credits_left";

  vote.voterNames[voterId] = voterName;
  vote.votes.push({
    voterId,
    voterName,
    candidateIndex: candidate.index,
    candidateName: candidate.displayName,
    createdAt: Date.now(),
  });
  setVoteSession(vote);

  if (vote.messageId) {
    await api.editMessage(chatId, vote.messageId, {
      text: buildVoteText(vote),
      attachments: [voteCandidatesKeyboard(vote.candidates, voteCounts(vote))],
    });
  }

  return "voted";
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
export async function finalizeVote(chatId: number, auto: boolean): Promise<void> {
  const vote = getVoteSession(chatId);
  if (!vote) return;
  // Сразу убираем из стора, чтобы повторный вызов (кнопка + таймер) не посчитал MVP дважды.
  deleteVoteSession(chatId);

  addMvpWins(chatId, getVoteWinners(vote));
  const note = auto ? "\n\nГолосование закрыто автоматически по времени." : "";
  const res = await api.sendMessageToChat(chatId, { text: buildMvpResultText(vote) + note });

  const keep = [getSession(chatId)?.messageId, vote.rosterMessageId, res.message.body.mid];
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

/** «📊 Посмотреть итоги» — расклад голосов сообщением в чат (новое заменяет прошлое). */
export async function showVoteResults(chatId: number): Promise<string> {
  const vote = getVoteSession(chatId);
  if (!vote) return "Голосование уже завершено";
  if (vote.resultsMessageId) await api.deleteMessage(chatId, vote.resultsMessageId).catch(() => undefined);
  const res = await api.sendMessageToChat(chatId, { text: buildVoteResultsText(vote) });
  vote.resultsMessageId = res.message.body.mid;
  setVoteSession(vote);
  return "Итоги ниже";
}

/** Перерисовать сообщение голосования (например, после перезапуска с новыми правилами). */
export async function refreshVoteMessage(chatId: number): Promise<void> {
  const vote = getVoteSession(chatId);
  if (!vote?.messageId) return;
  await api
    .editMessage(chatId, vote.messageId, {
      text: buildVoteText(vote),
      attachments: [voteCandidatesKeyboard(vote.candidates, voteCounts(vote))],
    })
    .catch((err) => console.warn("[voteLogic] не удалось обновить сообщение голосования:", err instanceof Error ? err.message : err));
}
