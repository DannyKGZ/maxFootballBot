import { ButtonAction, VoteCandidate } from "./types";
import { InlineKeyboardAttachment, KeyboardButton } from "./maxApi";
import { progressBar } from "./messageFormatter";

function encodePayload(action: ButtonAction): string {
  return JSON.stringify(action);
}

export function decodePayload(payload: string | undefined): ButtonAction | null {
  if (!payload) return null;
  try {
    return JSON.parse(payload) as ButtonAction;
  } catch {
    return null;
  }
}

function callbackButton(text: string, action: ButtonAction): KeyboardButton {
  return { type: "callback", text, payload: encodePayload(action) };
}

/** «Вы уже записаны. Хотите записать другого игрока?» [Да] [Нет] */
export function addAnotherKeyboard(userId: number): InlineKeyboardAttachment {
  return {
    type: "inline_keyboard",
    payload: {
      buttons: [
        [
          callbackButton("Да", { a: "add_another_yes", u: userId }),
          callbackButton("Нет", { a: "add_another_no", u: userId }),
        ],
      ],
    },
  };
}

/** «Вы хотите удалить своё бронирование?» [Да] [Нет] */
export function confirmRemoveKeyboard(userId: number): InlineKeyboardAttachment {
  return {
    type: "inline_keyboard",
    payload: {
      buttons: [
        [
          callbackButton("Да", { a: "remove_yes", u: userId }),
          callbackButton("Нет", { a: "remove_no", u: userId }),
        ],
      ],
    },
  };
}

/** «Кого удалить из списка?» — по кнопке на каждую запись пользователя + «Отмена». */
export function removeChoiceKeyboard(userId: number, names: string[]): InlineKeyboardAttachment {
  return {
    type: "inline_keyboard",
    payload: {
      buttons: [
        ...names.map((n) => [callbackButton(n, { a: "rm_pick", u: userId, n })]),
        [callbackButton("Отмена", { a: "remove_no", u: userId })],
      ],
    },
  };
}

/**
 * Кнопки под сообщением записи в групповом чате — только для участников.
 * Инлайн-клавиатуру в группе видят все, поэтому админские кнопки живут в
 * личном чате админа с ботом (см. adminKeyboard и adminPanel.ts).
 */
export function rosterKeyboard(): InlineKeyboardAttachment {
  return {
    type: "inline_keyboard",
    payload: {
      buttons: [
        [callbackButton("➕ Записаться", { a: "join" }), callbackButton("➖ Убрать себя", { a: "leave" })],
        [callbackButton("🏆 Рейтинг MVP", { a: "show_mvp" }), callbackButton("ℹ️ Инструкция", { a: "help" })],
      ],
    },
  };
}

/** Кнопки участника в личном чате с ботом — действуют на запись общего чата. */
function userMenuRows(): KeyboardButton[][] {
  return [
    [callbackButton("➕ Записаться", { a: "join" }), callbackButton("➖ Убрать себя", { a: "leave" })],
    [callbackButton("📋 Статус", { a: "show_status" }), callbackButton("🏆 Рейтинг MVP", { a: "show_mvp" })],
    [callbackButton("✏️ Изменить имя", { a: "nick" })],
  ];
}

/** Меню участника в личке: запись, статус, рейтинг, инструкция. */
export function userMenuKeyboard(extraRows: KeyboardButton[][] = []): InlineKeyboardAttachment {
  return {
    type: "inline_keyboard",
    payload: { buttons: [...extraRows, ...userMenuRows(), [callbackButton("ℹ️ Инструкция", { a: "help" })]] },
  };
}

/** «Кого убрать из записи?» в личке — по кнопке на каждую свою запись + «Отмена». */
export function dmRemoveKeyboard(userId: number, names: string[]): InlineKeyboardAttachment {
  return {
    type: "inline_keyboard",
    payload: {
      buttons: [
        ...names.map((n) => [callbackButton(`➖ ${n}`, { a: "dm_rm", u: userId, n })]),
        [callbackButton("Отмена", { a: "dm_rm_cancel", u: userId })],
      ],
    },
  };
}

/** Панель администратора — только в личном чате с ботом, действия выполняются в группе. */
export function adminKeyboard(extraRows: KeyboardButton[][] = []): InlineKeyboardAttachment {
  return {
    type: "inline_keyboard",
    payload: {
      buttons: [
        ...extraRows,
        ...userMenuRows(),
        [callbackButton("🔄 Новая запись", { a: "admin_restart" }), callbackButton("⏹ Закрыть запись", { a: "adm_close" })],
        [callbackButton("✏️ Список игроков", { a: "adm_edit" }), callbackButton("⚽ Дележка", { a: "adm_draft" })],
        [callbackButton("🗳 Начать голосование", { a: "adm_vote" }), callbackButton("🏁 Итоги голосования", { a: "adm_finish" })],
        [callbackButton("🗓 Расписание", { a: "adm_schedule" }), callbackButton("🔗 Объединить в рейтинге", { a: "adm_merge" })],
        [
          callbackButton("🧹 Сброс сезона MVP", { a: "adm_mvp_reset", s: "season" }),
          callbackButton("🗑 Сброс всего MVP", { a: "adm_mvp_reset", s: "all" }),
        ],
        [callbackButton("ℹ️ Инструкция", { a: "help" })],
      ],
    },
  };
}

/** Подтверждение сброса рейтинга MVP — только для админа, который его запросил. */
export function mvpResetKeyboard(userId: number, scope: "season" | "all"): InlineKeyboardAttachment {
  return {
    type: "inline_keyboard",
    payload: {
      buttons: [
        [
          callbackButton(scope === "season" ? "Да, обнулить сезон" : "Да, обнулить всё", { a: "mvp_reset", u: userId, s: scope }),
          callbackButton("Нет", { a: "mvp_reset_no", u: userId }),
        ],
      ],
    },
  };
}

/** Подтверждение опасного действия в личке админа: [Да] [Нет]. */
export function adminConfirmKeyboard(userId: number, op: "restart" | "close"): InlineKeyboardAttachment {
  const yes = op === "restart" ? "Да, начать новую" : "Да, закрыть";
  return {
    type: "inline_keyboard",
    payload: {
      buttons: [
        [callbackButton(yes, { a: "dm_ok", u: userId, op }), callbackButton("Нет", { a: "dm_cancel", u: userId })],
      ],
    },
  };
}

/** «Уже идёт запись на N человек, точно начать новую?» [Да] [Нет] — только админу */
export function confirmRestartKeyboard(adminUserId: number): InlineKeyboardAttachment {
  return {
    type: "inline_keyboard",
    payload: {
      buttons: [
        [
          callbackButton("Да, начать новую", { a: "restart_yes", u: adminUserId }),
          callbackButton("Нет, оставить", { a: "restart_no", u: adminUserId }),
        ],
      ],
    },
  };
}

/** «Точно закрыть запись на N человек без открытия новой?» [Да] [Нет] — только админу */
export function confirmCloseKeyboard(adminUserId: number): InlineKeyboardAttachment {
  return {
    type: "inline_keyboard",
    payload: {
      buttons: [
        [
          callbackButton("Да, закрыть", { a: "close_yes", u: adminUserId }),
          callbackButton("Нет, оставить", { a: "close_no", u: adminUserId }),
        ],
      ],
    },
  };
}

/** Кнопка на каждого кандидата — по одной в строке; у кого есть голоса, на кнопке счётчик: "Валера · 3". */
export function voteCandidatesKeyboard(
  candidates: VoteCandidate[],
  counts: Record<number, number> = {},
  total = 0,
): InlineKeyboardAttachment {
  // Счёт прямо на кнопках: «Витя ▰▰▱▱▱▱▱▱▱▱ 2» — шкала из всех голосов основы.
  return {
    type: "inline_keyboard",
    payload: {
      buttons: candidates.map((c) => {
        const n = counts[c.index] || 0;
        // Прогресс-бар — только у тех, за кого уже голосовали; остальные — просто имя.
        return [callbackButton(n > 0 ? `${c.displayName} ${progressBar(n, total)} ${n}` : c.displayName, { a: "mvp_vote", c: c.index })];
      }),
    },
  };
}

// ---- Диалог настройки расписания ----

// Порядок кнопок — с понедельника; value — номер дня как в cron (0=вс).
const DAY_BUTTONS = [
  { label: "Пн", value: 1 },
  { label: "Вт", value: 2 },
  { label: "Ср", value: 3 },
  { label: "Чт", value: 4 },
  { label: "Пт", value: 5 },
  { label: "Сб", value: 6 },
  { label: "Вс", value: 0 },
];

const TIME_CHOICES = ["09:00", "10:00", "12:00", "18:00", "19:00", "20:00", "21:00"];

/** Кнопки-переключатели дней недели: выбранные помечены ✅. */
export function scheduleDaysKeyboard(userId: number, selected: number[]): InlineKeyboardAttachment {
  const dayButtons = DAY_BUTTONS.map((d) =>
    callbackButton(`${selected.includes(d.value) ? "✅ " : ""}${d.label}`, {
      a: "sch_day",
      u: userId,
      d: d.value,
    }),
  );
  return {
    type: "inline_keyboard",
    payload: {
      buttons: [
        dayButtons.slice(0, 4),
        dayButtons.slice(4),
        [
          callbackButton("Готово ➡️", { a: "sch_days_ok", u: userId }),
          callbackButton("Отмена", { a: "sch_cancel", u: userId }),
        ],
        [callbackButton("♻️ Сбросить расписание", { a: "sch_reset", u: userId })],
      ],
    },
  };
}

/** Популярные варианты времени + ручной ввод. */
export function scheduleTimeKeyboard(userId: number): InlineKeyboardAttachment {
  const timeButtons = TIME_CHOICES.map((t) => callbackButton(t, { a: "sch_time", u: userId, t }));
  return {
    type: "inline_keyboard",
    payload: {
      buttons: [
        timeButtons.slice(0, 3),
        timeButtons.slice(3, 6),
        [timeButtons[6], callbackButton("Другое время", { a: "sch_time_custom", u: userId })],
        [callbackButton("Отмена", { a: "sch_cancel", u: userId })],
      ],
    },
  };
}

/** Только «Отмена» — на шаге ручного ввода времени. */
export function scheduleCancelKeyboard(userId: number): InlineKeyboardAttachment {
  return {
    type: "inline_keyboard",
    payload: { buttons: [[callbackButton("Отмена", { a: "sch_cancel", u: userId })]] },
  };
}
