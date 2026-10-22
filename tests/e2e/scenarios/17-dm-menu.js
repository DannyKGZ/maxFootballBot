const { dmOf, GROUP } = require("../harness");

module.exports = {
  name: "Личка с ботом: приветствие и кнопки участника",
  async run(t) {
    const USER_MENU = "➕ Записаться|➖ Убрать себя|📋 Статус|🏆 Рейтинг MVP|✏️ Изменить имя|ℹ️ Инструкция";
    await t.botStarted(4);
    const menu = t.find(/^👋 Бот записи/, dmOf(4));
    t.ok(!!menu && t.buttons(menu).join("|") === USER_MENU, "участник открыл бота — приветствие с кнопками", menu && t.buttons(menu));
    await t.click(4, menu, "➕ Записаться", { dm: true });
    t.ok(t.toast().includes("Сейчас записи нет"), "записи нет — понятное уведомление");

    await t.say(1, "/старт");
    await t.click(4, menu, "➕ Записаться", { dm: true });
    t.ok(t.toast() === "✅ Вы записаны" && t.lines(t.roster()).join("|") === "1. Влад", "«Записаться» из лички — запись в общем чате", t.lines(t.roster()));
    await t.click(4, menu, "➕ Записаться", { dm: true });
    t.ok(t.toast() === "Вы уже записаны" && t.lines(t.roster()).length === 1, "повторно не записывает");
    t.ok(!t.find(/Хотите записать другого/, GROUP), "в общий чат лишних вопросов не уходит");

    await t.say(4, "+Друг Влада");
    await t.click(4, menu, "➖ Убрать себя", { dm: true });
    t.ok(t.toast() === "➖ Убрано из записи: Влад" && t.lines(t.roster()).join("|") === "1. Друг Влада" && !t.find(/Кого убрать/, dmOf(4)), "«Убрать себя» — своя запись убрана сразу, без вопроса", t.lines(t.roster()));
    t.ok(!!t.find(/^➖ Влад ушёл из записи$/, GROUP), "в чате — кто ушёл");
    await t.say(4, "+Брат Влада");
    await t.click(4, menu, "➖ Убрать себя", { dm: true });
    const pick = t.find(/Кого убрать из записи\?/, dmOf(4));
    t.ok(pick && t.buttons(pick).join("|") === "➖ Друг Влада|➖ Брат Влада|Отмена", "сам не записан, записал двоих — выбор", pick && t.buttons(pick));
    await t.click(4, pick, "➖ Брат Влада", { dm: true });
    t.ok(t.toast() === "Убрано из записи: Брат Влада" && !t.find(/Кого убрать из записи\?/, dmOf(4)), "выбранный убран, вопрос удалён");

    await t.click(4, menu, "📋 Статус", { dm: true });
    const st = t.find(/^📋 (Игра |Записи нет)/, dmOf(4));
    t.ok(st && st.text.includes("Основа 1/") && t.buttons(st).join("|") === USER_MENU, "«Статус» — в личку, с кнопками меню");
    await t.click(4, menu, "🏆 Рейтинг MVP", { dm: true });
    t.ok(!!t.find(/Рейтинг MVP/, dmOf(4)), "«Рейтинг MVP» — в личку");
    await t.click(4, menu, "ℹ️ Инструкция", { dm: true });
    t.ok(t.helpDm(4).startsWith("ℹ️ Как пользоваться"), "«Инструкция» — инструкция участника");
    t.ok(!t.all(GROUP).some((m) => /^(📋|🏆 Рейтинг|ℹ️|👋)/.test(m.text)), "ответы из лички не попадают в общий чат");

    await t.click(4, menu, "➖ Убрать себя", { dm: true });
    t.ok(t.lines(t.roster()).length === 0, "одна запись — убрана сразу");
  },
};
