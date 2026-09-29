// Лимиты MAX Bot API (см. dev.max.ru):
//  - не более 2 отправок/редактирований/ответов на callback в секунду на один чат
//  - не более 30 запросов в секунду суммарно на бота
//
// Реализация: последовательная очередь на чат (интервал >= 500мс между вызовами)
// поверх общей очереди с интервалом >= ~34мс между вызовами.

type Task<T> = () => Promise<T>;

class Queue {
  private queue: Array<() => void> = [];
  private lastRun = 0;
  private running = false;

  constructor(private readonly minIntervalMs: number) {}

  run<T>(task: Task<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(() => {
        task().then(resolve, reject);
      });
      this.pump();
    });
  }

  private pump(): void {
    if (this.running) return;
    this.running = true;
    const step = () => {
      const next = this.queue.shift();
      if (!next) {
        this.running = false;
        return;
      }
      const now = Date.now();
      const wait = Math.max(0, this.lastRun + this.minIntervalMs - now);
      setTimeout(() => {
        this.lastRun = Date.now();
        next();
        step();
      }, wait);
    };
    step();
  }
}

const GLOBAL_MIN_INTERVAL_MS = Math.ceil(1000 / 30); // 30 rps
const PER_CHAT_MIN_INTERVAL_MS = 500; // 2 rps per chat

const globalQueue = new Queue(GLOBAL_MIN_INTERVAL_MS);
const perChatQueues = new Map<number, Queue>();

function getChatQueue(chatId: number): Queue {
  let q = perChatQueues.get(chatId);
  if (!q) {
    q = new Queue(PER_CHAT_MIN_INTERVAL_MS);
    perChatQueues.set(chatId, q);
  }
  return q;
}

/**
 * Прогоняет вызов MAX API через общий и пер-чатовый лимитер.
 * chatId может быть 0/неизвестен (например, глобальные методы) — тогда
 * применяется только общий лимит.
 */
export function throttled<T>(chatId: number | undefined, task: Task<T>): Promise<T> {
  if (!chatId) {
    return globalQueue.run(task);
  }
  const chatQueue = getChatQueue(chatId);
  return globalQueue.run(() => chatQueue.run(task));
}
