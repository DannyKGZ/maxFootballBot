const { dmOf, GROUP } = require("../harness");

module.exports = {
  name: "Личка с ботом: приветствие и кнопки участника",
  async run(t) {
    const USER_MENU = "➕ Записаться|➖ Убрать себя|📋 Статус|🏆 Рейтинг MVP|ℹ️ Инструкция";
    await t.botStarted(4);
    const menu = t.find(/^👋 Это бот записи/, dmOf(4));
    t.ok(!!menu && t.buttons(menu).join("|") === USER_MENU, "участник открыл бота — приветствие с кнопками", menu && t.buttons(menu));
    await t.click(4, menu, "➕ Записаться", { dm: true });
    t.ok(t.toast().includes("Сейчас записи нет"), "записи нет — понятное уведомление");

    await t.say(1, "/старт");
    await t.click(4, menu, "➕ Записаться", { dm: true });
    t.ok(t.toast() === "✅ Вы записаны" && t.lines(t.roster()).join("|") === "1. Влад (Влад)", "«Записаться» из лички — запись в общем чате", t.lines(t.roster()));
    await t.click(4, menu, "➕ Записаться", { dm: true });
    t.ok(t.toast() === "Вы уже записаны" && t.lines(t.roster()).length === 1, "повторно не записывает");
    t.ok(!t.find(/Хотите записать другого/, GROUP), "в общий чат лишних вопросов не уходит");

    await t.say(4, "+Друг Влада");
    await t.click(4, menu, "➖ Убрать себя", { dm: true });
    const pick = t.find(/Кого убрать из записи\?/, dmOf(4));
    t.ok(pick && t.buttons(pick).join("|") === "➖ Влад|➖ Друг Влада|Отмена", "«Убрать себя» — выбор своих записей в личке", pick && t.buttons(pick));
    await t.click(4, pick, "➖ Друг Влада", { dm: true });
    t.ok(t.toast() === "Убрано из записи: Друг Влада" && !t.lines(t.roster()).some((l) => l.includes("Друг")), "выбранная запись убрана из общего чата");
    t.ok(!t.find(/Кого убрать из записи\?/, dmOf(4)), "вопрос в личке убран");

    await t.click(4, menu, "📋 Статус", { dm: true });
    const st = t.find(/^📋 Статус записи/, dmOf(4));
    t.ok(st && st.text.includes("Основа: 1 из") && t.buttons(st).join("|") === USER_MENU, "«Статус» — в личку, с кнопками меню");
    await t.click(4, menu, "🏆 Рейтинг MVP", { dm: true });
    t.ok(!!t.find(/Рейтинг MVP/, dmOf(4)), "«Рейтинг MVP» — в личку");
    await t.click(4, menu, "ℹ️ Инструкция", { dm: true });
    t.ok(t.dmTo(4).pop().text.startsWith("ℹ️ Как пользоваться"), "«Инструкция» — инструкция участника");
    t.ok(!t.all(GROUP).some((m) => /^(📋|🏆 Рейтинг|ℹ️|👋)/.test(m.text)), "ответы из лички не попадают в общий чат");

    await t.click(4, menu, "➖ Убрать себя", { dm: true });
    await t.click(4, t.find(/Убрать из записи: Влад\?/, dmOf(4)), "➖ Влад", { dm: true });
    t.ok(t.lines(t.roster()).length === 0, "одна запись — подтверждение одной кнопкой, и она убрана");
  },
};
