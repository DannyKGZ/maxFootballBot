import { config, isManagedChat } from "./config";
import { onChatMessageSent } from "./maxApi";
import { repostDraftMessage } from "./draftLogic";
import { getSession, getVoteSession } from "./store";
import { repostVoteMessage } from "./voteLogic";

/**
 * «Держать внизу»: пока идёт дележка, затем до конца голосования за MVP, их
 * сообщение всегда последнее в чате. В MAX нет закрепления внизу, поэтому
 * когда в чате появляется что-то новое (пишет человек или бот), через
 * STICKY_DELAY_MS бот публикует сообщение заново, а старое удаляет. Несколько
 * сообщений подряд дают один перепост. После итогов голосования — не держим.
 */

const timers = new Map<number, NodeJS.Timeout>();
const reposting = new Set<number>();

/** Что держим внизу: голосование, иначе дележка/составы текущей записи (пока MVP не выбран). */
function stickyOf(chatId: number): { kind: "vote" | "draft"; messageId: string | null } | null {
  const vote = getVoteSession(chatId);
  if (vote) return { kind: "vote", messageId: vote.messageId };
  const session = getSession(chatId);
  if (session?.draft && !session.mvpDone) return { kind: "draft", messageId: session.draft.messageId };
  return null;
}

/** В чате появилось новое сообщение (не наше «нижнее») — перепостим «нижнее» чуть позже. */
export function noteChatActivity(chatId: number, messageId?: string): void {
  if (config.stickyDelayMs <= 0 || !isManagedChat(chatId) || reposting.has(chatId)) return;
  const sticky = stickyOf(chatId);
  if (!sticky || (messageId && messageId === sticky.messageId)) return;
  clearTimeout(timers.get(chatId));
  timers.set(
    chatId,
    setTimeout(() => {
      timers.delete(chatId);
      void repostSticky(chatId);
    }, config.stickyDelayMs),
  );
}

async function repostSticky(chatId: number): Promise<void> {
  const sticky = stickyOf(chatId);
  if (!sticky) return;
  reposting.add(chatId);
  try {
    if (sticky.kind === "vote") await repostVoteMessage(chatId);
    else await repostDraftMessage(chatId);
  } catch (err) {
    console.warn(`[sticky] не удалось опустить сообщение вниз в чате ${chatId}:`, err instanceof Error ? err.message : err);
  } finally {
    reposting.delete(chatId);
  }
}

/** Подписка на все сообщения бота в чатах (вызывается при старте). */
export function startSticky(): void {
  onChatMessageSent((chatId, messageId) => noteChatActivity(chatId, messageId));
}
