import { createHash } from "node:crypto";
import { db } from "./db";
import type { MaxUpdate } from "./types";

export const UPDATE_TYPES = ["message_created", "message_callback", "bot_started", "bot_added"];
const MARKER_KEY = "updates_marker";
const RETENTION_MS = 7 * 86_400_000;
const MAX_ATTEMPTS = 12;

type Handler = (update: MaxUpdate) => Promise<void>;
type Job = { id: number; payload: string; attempts: number };
let handler: Handler | undefined;
let active: Promise<void> | undefined;
let wakeup: NodeJS.Timeout | undefined;

export function isMaxUpdate(value: unknown): value is MaxUpdate {
  if (!value || typeof value !== "object") return false;
  const update = value as Partial<MaxUpdate>;
  return typeof update.update_type === "string" && Number.isFinite(update.timestamp);
}

function putUpdate(update: MaxUpdate, now: number): void {
  if (!UPDATE_TYPES.includes(update.update_type)) return;
  const chatId = update.message?.recipient?.chat_id ?? update.chat_id;
  const userId = update.callback?.user?.user_id ?? update.message?.sender?.user_id
    ?? (update.user as { user_id?: number } | undefined)?.user_id;
  const scope = chatId == null ? `user:${userId ?? "unknown"}` : `chat:${chatId}`;
  const stableId = update.update_type === "message_callback" ? update.callback?.callback_id
    : update.update_type === "message_created" ? update.message?.body?.mid : undefined;
  const payload = JSON.stringify(update);
  const identifier = stableId ?? (chatId != null && (update.update_type === "bot_started" || update.update_type === "bot_added")
    ? `${scope}:${userId ?? ""}:${update.timestamp}`
    : createHash("sha256").update(payload).digest("hex"));
  db().prepare("INSERT OR IGNORE INTO incoming_updates (event_key, scope, payload, received_at, retry_at) VALUES (?, ?, ?, ?, ?)")
    .run(`${update.update_type}:${identifier}`, scope, payload, now, now);
}

export function enqueueWebhook(update: MaxUpdate): void {
  putUpdate(update, Date.now());
  wakeWorker();
}

export function loadPollingMarker(): number | undefined {
  const row = db().prepare("SELECT value FROM meta WHERE key = ?").get(MARKER_KEY) as { value: string } | undefined;
  return row ? Number(row.value) : undefined;
}

export function enqueuePollingBatch(updates: MaxUpdate[], marker?: number | null): void {
  db().transaction(() => {
    const now = Date.now();
    for (const update of updates) putUpdate(update, now);
    if (marker != null) db().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(MARKER_KEY, String(marker));
  })();
  if (updates.length) wakeWorker();
}

export function pruneIncomingUpdates(now = Date.now()): void {
  db().prepare("DELETE FROM incoming_updates WHERE completed_at < ?").run(now - RETENTION_MS);
}

function wakeWorker(): void {
  if (!handler || active || wakeup) return;
  wakeup = setTimeout(() => {
    wakeup = undefined;
    active = drain().catch((err) => console.error("[inbox] ошибка очереди:", err)).finally(() => {
      active = undefined;
    });
  }, 0);
}

async function drain(): Promise<void> {
  const next = db().prepare(
    `SELECT job.id, job.payload, job.attempts FROM incoming_updates AS job
     WHERE job.completed_at IS NULL AND job.retry_at <= ?
       AND NOT EXISTS (
         SELECT 1 FROM incoming_updates AS earlier
         WHERE earlier.scope = job.scope AND earlier.id < job.id AND earlier.completed_at IS NULL
       )
     ORDER BY job.id LIMIT 1`,
  );
  while (handler) {
    const job = next.get(Date.now()) as Job | undefined;
    if (!job) return;
    try {
      await handler(JSON.parse(job.payload) as MaxUpdate);
      db().prepare("UPDATE incoming_updates SET payload = NULL, completed_at = ? WHERE id = ?").run(Date.now(), job.id);
    } catch (err) {
      const attempts = job.attempts + 1;
      const now = Date.now();
      const finished = attempts >= MAX_ATTEMPTS;
      const retryAt = now + Math.min(60_000, 1000 * 2 ** (attempts - 1));
      db().prepare("UPDATE incoming_updates SET attempts = ?, retry_at = ?, completed_at = ? WHERE id = ?")
        .run(attempts, retryAt, finished ? now : null, job.id);
      console.error(`[inbox] событие ${job.id}, попытка ${attempts}${finished ? ", осталось в журнале ошибок" : ""}:`, err);
    }
  }
}

let retryTimer: NodeJS.Timeout | undefined;

export function startUpdateWorker(processUpdate: Handler): void {
  handler = processUpdate;
  retryTimer = setInterval(wakeWorker, 1000);
  wakeWorker();
}

export async function stopUpdateWorker(): Promise<void> {
  handler = undefined;
  clearInterval(retryTimer);
  clearTimeout(wakeup);
  await active;
}
