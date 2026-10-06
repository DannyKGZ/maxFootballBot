import { config } from "./config";
import * as api from "./maxApi";
import {
  scheduleCancelKeyboard,
  scheduleDaysKeyboard,
  scheduleTimeKeyboard,
} from "./keyboard";
import { applySchedule } from "./scheduler";
import { isChatAdmin } from "./sessionLogic";
import { GameSlot, deleteSchedule, getGameSlots, getGameTime, loadSchedule, saveSchedule, setGameSlots } from "./settingsStore";
import { gameWeekdays } from "./gameDays";
import { ButtonAction, ScheduleAction } from "./types";

/**
 * Диалог настройки расписания публикации записи (только админы):
 * /расписание → выбор дней (кнопки-переключатели) → выбор времени
 * (кнопки или ручной ввод ЧЧ:ММ:СС) → сохранение и перезапуск планировщика.
 * Состояние диалога — в памяти, по ключу chatId:userId админа.
 */

interface Dialog {
  group: number; // чат, чьё расписание настраиваем (диалог может идти в личке)
  step: "days" | "time" | "custom_time";
  days: number[]; // 0=вс ... 6=сб (как в cron)
  messageId: string;
}

const dialogs = new Map<string, Dialog>();

const key = (chatId: number, userId: number) => `${chatId}:${userId}`;
const DAY_NAMES = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];
// ЧЧ:ММ:СС, секунды можно не писать: "20:30" = "20:30:00".
const TIME_RE = /^(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?$/;
const pad = (n: number) => String(n).padStart(2, "0");

/** Дни в порядке пн..вс для показа пользователю. */
function formatDays(days: number[]): string {
  const ordered = [1, 2, 3, 4, 5, 6, 0].filter((d) => days.includes(d));
  return ordered.map((d) => DAY_NAMES[d]).join(", ");
}

/** Человеческое описание cron вида «[сек] мин час * * дни»; иначе — как есть. */
export function describeCron(expression: string): string {
  const f = expression.trim().split(/\s+/);
  const [sec, min, hour, dom, mon, dow] = f.length === 6 ? f : ["0", ...f];
  const days = dow?.split(",").map(Number);
  const simple =
    (f.length === 5 || f.length === 6) &&
    dom === "*" &&
    mon === "*" &&
    [sec, min, hour].every((x) => /^\d+$/.test(x)) &&
    Boolean(days?.every((d) => Number.isInteger(d) && d >= 0 && d <= 7));
  if (!simple) return `по cron «${expression}»`;
  const time = `${pad(Number(hour))}:${pad(Number(min))}${Number(sec) ? `:${pad(Number(sec))}` : ""}`;
  return `${formatDays(days!.map((d) => d % 7))} в ${time}`;
}

/** «игра — на следующий день: Ср, Пт, Пн в 20:30». */
export function gamesText(chatId: number): string {
  return `игра — на следующий день после публикации: ${formatDays(gameWeekdays(chatId))} в ${getGameTime(chatId)}`;
}

/** «Пн 12:00 → игра Ср 21:20; Чт 12:00 → игра Вс 20:20». */
export function slotsText(slots: GameSlot[]): string {
  return slots.map((s) => `${DAY_NAMES[s.pub]} ${s.pubTime} → игра ${DAY_NAMES[s.game]} ${s.time}`).join("; ");
}

/** Действующее расписание публикации: из /игры, /расписание или CRON_SCHEDULE из .env. */
export function currentScheduleText(chatId: number): string {
  const slots = getGameSlots(chatId);
  if (slots) return `${slotsText(slots)} (настроено через /игры)`;
  const saved = loadSchedule(chatId);
  return saved
    ? `${describeCron(saved.cron)} (настроено через /расписание)`
    : `${describeCron(config.cronSchedule)} (по умолчанию из .env)`;
}

function daysText(group: number, days: number[]): string {
  const chosen = days.length ? `Выбрано: ${formatDays(days)}` : "Пока ничего не выбрано";
  return [
    `Сейчас запись публикуется: ${currentScheduleText(group)}.`,
    "",
    "Выберите дни недели, в которые бот публикует запись (нажмите ещё раз, чтобы снять выбор), или сбросьте расписание к значению по умолчанию.",
    chosen,
  ].join("\n");
}

export function isScheduleAction(action: ButtonAction): action is ScheduleAction {
  return action.a.startsWith("sch_");
}

export type StartScheduleOutcome = "not_admin" | "started";

export async function startScheduleDialog(
  chatId: number,
  userId: number,
  adminOfChatId: number = chatId, // для диалога в личке — права проверяем в группе
): Promise<StartScheduleOutcome> {
  if (!(await isChatAdmin(adminOfChatId, userId))) return "not_admin";

  // Старый незаконченный диалог этого админа заменяем новым.
  await dropDialog(chatId, userId);

  const res = await api.sendMessageToChat(chatId, {
    text: daysText(adminOfChatId, []),
    attachments: [scheduleDaysKeyboard(userId, [])],
  });
  dialogs.set(key(chatId, userId), { group: adminOfChatId, step: "days", days: [], messageId: res.message.body.mid });
  return "started";
}

/** Убирает диалог и его сообщение (best-effort). */
async function dropDialog(chatId: number, userId: number): Promise<void> {
  const dialog = dialogs.get(key(chatId, userId));
  if (!dialog) return;
  dialogs.delete(key(chatId, userId));
  try {
    await api.deleteMessage(chatId, dialog.messageId);
  } catch (err) {
    console.error("[scheduleLogic] не удалось удалить сообщение диалога:", err);
  }
}

/** cron с секундами (node-cron: «сек мин час день месяц день_недели»). */
function buildCron(days: number[], hours: number, minutes: number, seconds: number): string {
  return `${seconds} ${minutes} ${hours} * * ${[...days].sort((a, b) => a - b).join(",")}`;
}

async function finish(
  chatId: number,
  userId: number,
  dialog: Dialog,
  hours: number,
  minutes: number,
  seconds = 0,
): Promise<string> {
  const time = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  const expression = buildCron(dialog.days, hours, minutes, seconds);

  setGameSlots(dialog.group, null); // /расписание заменяет /игры
  applySchedule(dialog.group, expression);
  saveSchedule(dialog.group, { cron: expression, days: dialog.days, time });
  dialogs.delete(key(chatId, userId));

  await api.editMessage(chatId, dialog.messageId, {
    text: `✅ Расписание сохранено: ${formatDays(dialog.days)} в ${time} (${config.timezone}).\nБот будет публиковать новую запись в эти дни, ${gamesText(dialog.group)}.`,
    attachments: [],
  });
  return "Расписание сохранено";
}

/** Обрабатывает нажатия кнопок диалога; возвращает текст всплывающего уведомления. */
export async function handleScheduleCallback(
  chatId: number,
  userId: number,
  action: ScheduleAction,
): Promise<string> {
  const dialog = dialogs.get(key(chatId, userId));
  if (!dialog) return "Диалог устарел — начните заново командой /расписание";

  switch (action.a) {
    case "sch_day": {
      if (dialog.step !== "days") return "Дни уже выбраны";
      dialog.days = dialog.days.includes(action.d)
        ? dialog.days.filter((d) => d !== action.d)
        : [...dialog.days, action.d];
      await api.editMessage(chatId, dialog.messageId, {
        text: daysText(dialog.group, dialog.days),
        attachments: [scheduleDaysKeyboard(userId, dialog.days)],
      });
      return "Ок";
    }
    case "sch_days_ok": {
      if (dialog.step !== "days") return "Дни уже выбраны";
      if (dialog.days.length === 0) return "Выберите хотя бы один день";
      dialog.step = "time";
      await api.editMessage(chatId, dialog.messageId, {
        text: `Дни: ${formatDays(dialog.days)}.\nВо сколько публиковать запись? (${config.timezone})`,
        attachments: [scheduleTimeKeyboard(userId)],
      });
      return "Ок";
    }
    case "sch_time": {
      if (dialog.step === "days") return "Сначала выберите дни";
      const match = TIME_RE.exec(action.t);
      if (!match) return "Некорректное время";
      return finish(chatId, userId, dialog, Number(match[1]), Number(match[2]));
    }
    case "sch_time_custom": {
      if (dialog.step === "days") return "Сначала выберите дни";
      dialog.step = "custom_time";
      await api.editMessage(chatId, dialog.messageId, {
        text: "Напишите время сообщением в формате ЧЧ:ММ:СС, например 20:30:00 (секунды можно не писать)",
        attachments: [scheduleCancelKeyboard(userId)],
      });
      return "Ок";
    }
    case "sch_cancel": {
      await dropDialog(chatId, userId);
      return "Отменено";
    }
    case "sch_reset": {
      // Забываем расписание из /расписание — снова действует CRON_SCHEDULE из .env.
      deleteSchedule(dialog.group);
      setGameSlots(dialog.group, null);
      applySchedule(dialog.group, config.cronSchedule);
      dialogs.delete(key(chatId, userId));
      await api.editMessage(chatId, dialog.messageId, {
        text: `♻️ Расписание сброшено. Теперь запись публикуется ${currentScheduleText(dialog.group)}, часовой пояс ${config.timezone}; ${gamesText(dialog.group)}.`,
        attachments: [],
      });
      return "Расписание сброшено";
    }
  }
}

/**
 * Текст, пришедший, пока админ на шаге ручного ввода времени. Возвращает true,
 * если сообщение «съедено» диалогом. Команды и обычный текст не трогаем.
 */
export async function handleAwaitedTime(
  chatId: number,
  userId: number,
  text: string,
): Promise<boolean> {
  const dialog = dialogs.get(key(chatId, userId));
  if (!dialog || dialog.step !== "custom_time") return false;

  const match = TIME_RE.exec(text.trim());
  if (!match) {
    if (!/^\d/.test(text.trim())) return false; // не похоже на время — пусть обработают другие команды
    await api.sendMessageToChat(chatId, { text: "Неверный формат. Напишите время как ЧЧ:ММ:СС, например 20:30:00" });
    return true;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] ?? 0);
  if (hours > 23 || minutes > 59 || seconds > 59) {
    await api.sendMessageToChat(chatId, { text: "Такого времени не бывает. Напишите как ЧЧ:ММ:СС, например 20:30:00" });
    return true;
  }

  await finish(chatId, userId, dialog, hours, minutes, seconds);
  return true;
}
