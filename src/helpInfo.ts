import { getChatOptions, getMaxPlayers, getPayment } from "./settingsStore";
import { config } from "./config";
import { currentScheduleText } from "./scheduleLogic";
import { getSession, getVoteSession } from "./store";
import { Block, packBlocks } from "./messageParts";

/**
 * Инструкция (кнопка «ℹ️ Инструкция», команда /help). Приходит нажавшему в личку:
 *  - участнику — только команды участника и его личный статус;
 *  - админу — все админские команды по разделам, состояние чата и, отдельно,
 *    краткий список команд участника.
 * Админские команды есть только в инструкции админа.
 *
 * Текст собирается логическими блоками (раздел = заголовок и строки под ним):
 * инструкция админа не влезает в одно сообщение MAX (лимит 4000 символов),
 * поэтому `*HelpParts` отдаёт её частями по целым разделам. См. messageParts.ts.
 */

/** Личный статус: что записал этот человек и сколько у него голосов. */
function personalStatus(groupChatId: number, userId: number): Block {
  const session = getSession(groupChatId);
  const own = session?.players.filter((p) => p.userId === userId) ?? [];
  const signup = !session
    ? "записи нет"
    : own.length === 0
      ? "вы не записаны"
      : `вы записали ${own.length}: ${own.map((p) => p.displayName + (p.isReserve ? " (резерв)" : "")).join(", ")}`;

  const vote = getVoteSession(groupChatId);
  let voting = "не идёт";
  if (vote) {
    const credits = vote.creditsByVoter[userId] || 0;
    const used = vote.votes.filter((v) => v.voterId === userId).length;
    voting = credits ? `идёт, вы отдали ${used} из ${credits}` : "идёт, вы не голосуете (не играли)";
  }
  return ["Ваш статус:", `• Запись: ${signup}`, `• Голосование MVP: ${voting}`];
}

function reminders(chatId: number): Block {
  const payment = getPayment(chatId);
  const out: string[] = [];
  if (config.reminderHoursBefore > 0) out.push(`⏰ За ${config.reminderHoursBefore} ч до игры — напоминание о составе.`);
  const opts = getChatOptions(chatId);
  if (opts.paymentBefore > 0 || opts.paymentAfter > 0) {
    const when = [
      opts.paymentBefore > 0 ? `за ${opts.paymentBefore} ч до игры` : "",
      opts.paymentAfter > 0 ? `${opts.paymentAfter} ч после` : "",
    ].filter(Boolean);
    out.push(`💰 Оплата ${payment.amount} ₽ с игрока основы: ${payment.details}. Напоминания каждый час ${when.join(" и ")}.`);
  }
  if (opts.receipts) out.push("📄 После оплаты пришлите PDF-чек в чат или боту в личку: сумма = сколько вы записали × цена. Фото — на ручную проверку.");
  return out;
}

/** Команды участника — одинаковы для всех. Три раздела: запись, голосование, другое. */
function userCommandBlocks(chatId: number): Block[] {
  const maniska = getChatOptions(chatId).maniska;
  return [
    [
      "Запись:",
      "• «+» или «➕ Записаться» — записать себя",
      `• «+Рома», «+Рома +Влад» — записать друзей (до ${config.maxNamesPerMessage} имён за раз)`,
      "• «-» или «➖ Убрать себя» — убрать запись; «-Рома» — убрать записанного вами",
      `• Первые ${getMaxPlayers(chatId)} — основа, дальше резерв. Запись закрывается в начале игры`,
    ],
    [
      "MVP (после игры):",
      "• Голосование открывается через час после начала игры, закрывается, когда проголосуют все",
      "• Голосует основа: голосов столько, сколько ваших записей в основе; за себя нельзя",
      "• /голос — показать голосование внизу чата",
      ...(maniska ? ["• «👕 Я забрал манишки» — в следующей записи вы 2-й; ошиблись — нажмите ещё раз"] : []),
    ],
    [
      "Другое:",
      "• /статус — запись, состав, время до игры, следующая запись",
      "• /составы — команды после дележки",
      "• /mvp — рейтинг MVP: сезон, год, всё время",
      "• /имя Руслан Большой или «✏️ Изменить имя» в личке — как вас показывать в списке",
      "• /help — эта инструкция (в личку)",
    ],
  ];
}

/** Инструкция участника логическими блоками. */
function userHelpBlocks(groupChatId: number, userId: number): Block[] {
  return [["ℹ️ Как пользоваться ботом"], personalStatus(groupChatId, userId), ...userCommandBlocks(groupChatId), reminders(groupChatId)];
}

/** Инструкция админа логическими блоками: каждый раздел — отдельный блок. */
function adminHelpBlocks(groupChatId: number, userId: number): Block[] {
  void userId;
  const session = getSession(groupChatId);
  const vote = getVoteSession(groupChatId);
  const main = session ? Math.min(session.players.length, getMaxPlayers(groupChatId)) : 0;
  const autoClose = config.voteAutoCloseHours > 0 ? ` Иначе закроется само через ${config.voteAutoCloseHours} ч.` : "";

  return [
    ["ℹ️ Инструкция администратора"],
    [
      "Сейчас:",
      `• Запись: ${session ? `${session.players.length} чел. (основа ${main}, резерв ${session.players.length - main})` : "нет"}`,
      `• Голосование: ${vote ? `идёт, голосов ${vote.votes.length}` : "нет"}`,
      `• Публикация: ${currentScheduleText(groupChatId)}`,
      "Команды — в чат или боту в личку (из лички — на выбранный чат, «🔁 Чат»). В личке есть панель с кнопками.",
    ],
    [
      "📋 Запись:",
      "• /старт — новая запись (старая закроется); /закрыть — закрыть без новой",
      "• /удалить 3 (или имя), /переименовать 3 Имя, /поменять 1 на 12; в личке — «✏️ Список игроков»",
      "• /описание Футбол в Среда 30.09.2026 года ⏎ В 20:30 - 21:30 — шапка (день и дата подставляются, первое время — начало игры); /описание сброс",
      "• /лимит 15 — размер основы; /лимит сброс",
    ],
    [
      "🗓 Расписание:",
      "• /расписание — дни и время публикации (игра на следующий день); «♻️ Сбросить» — из .env",
      "• /игры Пн 12:00 Ср 21:20, Чт 12:00 Вс 20:20 — своя игра на каждую публикацию; /игры сброс",
    ],
    [
      "💰 Оплата:",
      "• /оплата 350 Т-банк 89990000000 Имя — сумма и реквизиты; /оплата сброс",
      "• /напоминания 0 2 — напоминать за 0 ч до игры и 2 ч после; /напоминания сброс",
      "• /должники — кто не оплатил (месяц: /должники 9, все: /должники все); в личке и кнопкой «💰 Должники и чеки» — с файлами чеков на проверке; /оплатил 5 — отметить по номеру",
    ],
    [
      "🏆 Роли:",
      "• /легенда — 1-й в каждой записи, на год (выбор из участников чата); /легенда Имя; /легенда сброс",
      "• /манишкаНосец — 2-й в записи (выбор из записавшихся); /манишкаНосец сброс; выкл / вкл — манишки в чате",
      "• 1 декабря лучший по MVP за год становится легендой года",
    ],
    [
      "⚽ Дележка:",
      "• /дележка — выбрать двух капитанов кнопками; /дележка 2 5 — по номерам; /дележка сброс",
      "• Капитаны выбирают по одному (⚪ ⚫ ⚪ ⚫), за капитана может нажать админ; резерв не участвует",
      "• Готовые составы — с суммой оплаты и упоминаниями; пока идёт выбор, дележка держится внизу чата",
    ],
    [
      "🏆 MVP:",
      "• /голосование — по последней сыгранной игре",
      `• /итоги — объявить MVP (+1 в рейтинг) и убрать служебные сообщения.${autoClose}`,
      "• /объединить Рус = Ruslan — склеить одного игрока под разными именами",
      "• Сезоны: зима (дек–фев), весна, лето, осень (сен–ноя), сезонный счёт обнуляется сам",
      "• /мвпСезонныйСброс, /мвпОбщийСброс — обнулить сезон / весь рейтинг (с подтверждением)",
    ],
    ["📢 /Всем текст, @all текст — упомянуть всех участников; просто @all — «Внимание всем!»"],
    ["Бот должен быть админом чата, чтобы удалять сообщения (MAX удаляет только младше 24 ч)."],
    // Разделитель приклеен к первому блоку: иначе он мог бы остаться последней строкой части.
    ...withSeparator("— Команды участников —", userCommandBlocks(groupChatId)),
    reminders(groupChatId),
  ];
}

/** Первому блоку — строку-разделитель сверху, чтобы они не разъехались по частям. */
function withSeparator(separator: string, blocks: Block[]): Block[] {
  if (blocks.length === 0) return [[separator]];
  return [[separator, ...blocks[0]], ...blocks.slice(1)];
}

/** Инструкция участника частями по целым разделам (обычно одна часть). */
export function buildUserHelpParts(groupChatId: number, userId: number): string[] {
  return packBlocks(userHelpBlocks(groupChatId, userId));
}

/** Инструкция админа частями по целым разделам: в одно сообщение MAX она не влезает. */
export function buildAdminHelpParts(groupChatId: number, userId: number): string[] {
  return packBlocks(adminHelpBlocks(groupChatId, userId));
}


/** Приветствие участнику в личке (с кнопками меню): кратко, что умеет бот, и его статус. */
export function buildUserWelcome(groupChatId: number, userId: number): string {
  return [
    "👋 Бот записи на футбол. Кнопки ниже работают отсюда, подробно — «ℹ️ Инструкция».",
    "",
    ...personalStatus(groupChatId, userId),
  ].join("\n");
}
