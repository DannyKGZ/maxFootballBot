export interface Player {
  id?: string; // постоянный id для кнопок (дележка, редактор); у старых записей появляется сам
  userId: number;
  displayName: string;
  isReserve: boolean;
  joinedAt: number; // Date.now()
  // Заполняются при записи голым "+" — данные профиля MAX (показываются в списке).
  lastName?: string;
  profileName?: string; // поле "name" профиля, выводится в скобках
  addedByName?: string; // first_name того, кто записал (для уведомления «записал Ruslan»)
  // Полное имя из профиля того, кто записал: MAX делает упоминание, только если текст
  // ссылки совпадает с именем в профиле целиком («Никита Халиманов», а не «Никита»).
  addedByFullName?: string;
  auto?: "legend" | "maniska"; // записан ботом автоматически как легенда / манишкаНосец
}

export interface FootballSession {
  chatId: number;
  messageId: string | null; // body.mid сообщения со списком (для PUT /messages)
  players: Player[];
  date: string; // ISO-строка даты/времени игры
  createdAt: number;
  reminderSent?: boolean; // старый флаг напоминания (до появления notified)
  notified?: string[]; // какие уведомления уже разосланы: "reminder", "pay-3" … "pay+2"
  paymentMessageId?: string | null; // последнее напоминание об оплате — следующее его заменяет
  closedAt?: number; // запись закрыта, потому что игра началась (список зафиксирован)
  voteAutoStarted?: boolean; // голосование за MVP по этой игре уже запускалось автоматически
  draft?: Draft; // дележка на команды
  mvpDone?: boolean; // голосование за MVP этой игры подведено — дележку внизу больше не держим
}

/** Дележка: админ выбирает двух капитанов, капитаны по очереди выбирают игроков основы. */
export interface Draft {
  stage: "captains" | "picking" | "done";
  captains: string[]; // ключи игроков (playerKey), 0 — первая команда, 1 — вторая
  picks: Array<{ k: string; team: 0 | 1 }>;
  turn: 0 | 1;
  messageId: string | null;
}

export type PendingActionType =
  | "confirm_add_another" // "Вы уже записаны. Хотите записать другого игрока?"
  | "await_new_player_name" // ждём текстовое сообщение с именем нового игрока
  | "confirm_remove" // "Вы хотите удалить своё бронирование?"
  | "confirm_restart_session" // "Уже идёт запись на N человек, точно начать новую?" (только админы)
  | "confirm_close_session"; // "Точно закрыть запись без открытия новой?" (только админы)

export interface PendingAction {
  type: PendingActionType;
  chatId: number;
  userId: number;
  createdAt: number;
  targetName?: string; // для confirm_remove: имя игрока, которого собираются удалить
}

// ---- Голосование за MVP матча ----

/** Кандидат — конкретный игрок из состава (по позиции в списке на момент старта голосования). */
export interface VoteCandidate {
  index: number; // позиция в списке кандидатов, используется как id в payload кнопки
  displayName: string;
  // Кто записал этого игрока и записал ли он себя (голый «+») — чтобы нельзя было голосовать за себя.
  ownerId?: number;
  isSelf?: boolean;
}

/** Один отданный голос — храним, чтобы все в чате видели, кто за кого проголосовал (п.ТЗ: прозрачность). */
export interface VoteRecord {
  voterId: number;
  voterName: string;
  candidateIndex: number;
  candidateName: string;
  createdAt: number;
}

export interface VoteSession {
  chatId: number;
  gameDate: string; // ISO-дата матча, за который идёт голосование (session.date на момент старта)
  candidates: VoteCandidate[];
  // Сколько голосов доступно каждому: по числу его записей в ОСНОВЕ (себя + друзей).
  // Резерв не играл — он не кандидат и голосов не даёт.
  creditsByVoter: Record<number, number>;
  // Имя голосующего — только для текста уведомлений/лога, на случай отображения.
  voterNames: Record<number, string>;
  votes: VoteRecord[];
  messageId: string | null; // сообщение с кнопками кандидатов и живым логом голосов
  rosterMessageId?: string | null; // сообщение записи той игры — не удаляется при очистке
  createdAt: number;
}

// ---- Сущности MAX Bot API (минимально необходимое подмножество) ----
// См. https://dev.max.ru/docs-api

export interface MaxUser {
  user_id: number;
  first_name: string;
  last_name?: string;
  name?: string;
  username?: string;
  is_bot?: boolean;
}

export interface MaxRecipient {
  chat_id?: number;
  user_id?: number;
  chat_type?: string;
}

export interface MaxMessageBody {
  mid: string;
  seq: number;
  text?: string;
  attachments?: unknown[];
}

export interface MaxMessage {
  sender: MaxUser;
  recipient: MaxRecipient;
  timestamp: number;
  body: MaxMessageBody;
  url?: string;
}

export interface MaxCallback {
  timestamp: number;
  callback_id: string;
  payload?: string;
  user: MaxUser;
}

// Ответ GET /chats/{chatId}/members/admins.
// ПРОВЕРЬТЕ имя поля user_id по факту первого вызова — в документации
// на dev.max.ru встречается непоследовательное написание (userId/user_id);
// здесь используется snake_case по аналогии с остальными объектами API.
export interface MaxChatMember {
  user_id: number;
  first_name?: string;
  last_name?: string;
  name?: string;
  is_bot?: boolean;
  is_owner?: boolean;
  is_admin?: boolean;
  [key: string]: unknown;
}

export interface MaxChatAdminsResponse {
  members: MaxChatMember[];
  marker?: number | null;
}

export interface MaxUpdate {
  update_type: "message_created" | "message_callback" | string;
  timestamp: number;
  message?: MaxMessage;
  callback?: MaxCallback;
  [key: string]: unknown;
}

// Payload инлайн-кнопок, которые генерирует бот (см. src/keyboard.ts)
export type ButtonAction =
  | { a: "add_another_yes"; u: number }
  | { a: "add_another_no"; u: number }
  | { a: "remove_yes"; u: number }
  | { a: "remove_no"; u: number }
  | { a: "rm_pick"; u: number; n: string } // выбор, кого из своих записей удалить (n = имя игрока)
  | { a: "admin_restart" } // кнопка в самом списке — доступна всем, право проверяется на сервере
  | { a: "restart_yes"; u: number }
  | { a: "restart_no"; u: number }
  | { a: "close_yes"; u: number }
  | { a: "close_no"; u: number }
  // Общие кнопки под сообщением записи/голосования: доступны всем, права проверяются на сервере
  | { a: "join" }
  | { a: "leave" }
  | { a: "show_mvp" }
  | { a: "show_status" } // /статус кнопкой (в личке с ботом)
  | { a: "nick" } // «✏️ Изменить имя» в личке — бот ждёт новое имя сообщением
  | { a: "dm_chat" } // «🔁 Чат: …» — выбрать, каким чатом управлять из лички
  | { a: "dm_chat_set"; c: number }
  // Роли чата: легенда и манишкаНосец (p — userId игрока)
  | { a: "adm_legend" }
  | { a: "adm_maniska" }
  | { a: "role_pick"; r: "legend" | "maniska"; p: number; n?: string; m?: 1 } // n — имя «друга»; m — участник чата (легенда)
  | { a: "role_page"; r: "legend" | "maniska"; pg: number } // листание участников чата
  | { a: "role_off"; r: "legend" | "maniska" }
  | { a: "role_cancel" }
  | { a: "mnk_take" } // «👕 Я забрал манишки» после игры
  | { a: "mnk_undo" } // кнопка с именем забравшего: он нажимает — «я ошибся»
  // Редактор списка в личке админа (k — ключ игрока userId:joinedAt)
  | { a: "adm_edit" }
  // Дележка на команды (k — ключ игрока)
  | { a: "adm_draft" }
  | { a: "dr_cap"; k: string }
  | { a: "dr_pick"; k: string }
  | { a: "dr_cancel" }
  | { a: "ed_list" }
  | { a: "ed_close" }
  | { a: "ed_pick"; k: string }
  | { a: "ed_del"; k: string }
  | { a: "ed_ren"; k: string }
  | { a: "dm_rm"; u: number; n: string } // в личке: убрать свою запись с именем n
  | { a: "dm_rm_cancel"; u: number }
  | { a: "help" }
  | { a: "adm_merge" } // подсказка по объединению имён в рейтинге MVP (панель админа) // инструкция — приходит нажавшему в личку
  | { a: "adm_vote" }
  | { a: "adm_finish" }
  | { a: "adm_close" }
  | { a: "adm_schedule" }
  | { a: "dm_ok"; u: number; op: "restart" | "close" } // подтверждение в личке админа
  | { a: "dm_cancel"; u: number }
  // Сброс рейтинга MVP: s = "season" (только сезон) или "all" (весь рейтинг)
  | { a: "adm_mvp_reset"; s: "season" | "all" } // кнопка в панели админа
  | { a: "mvp_reset"; u: number; s: "season" | "all" } // «Да, обнулить»
  | { a: "mvp_reset_no"; u: number }
  | { a: "mvp_vote"; c: number }
  | { a: "mvp_results" } // «📊 Посмотреть итоги» под голосованием // c = VoteCandidate.index — доступна всем, право/лимит проверяются на сервере
  // Диалог настройки расписания (только инициатор-админ, u = его userId)
  | { a: "sch_day"; u: number; d: number } // переключатель дня недели (0=вс..6=сб)
  | { a: "sch_days_ok"; u: number }
  | { a: "sch_time"; u: number; t: string } // t = "HH:MM"
  | { a: "sch_time_custom"; u: number }
  | { a: "sch_cancel"; u: number }
  | { a: "sch_reset"; u: number } // сбросить расписание к CRON_SCHEDULE из .env;

export type ScheduleAction = Extract<ButtonAction, { a: `sch_${string}` }>;
