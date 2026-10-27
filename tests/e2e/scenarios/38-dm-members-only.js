const { dmOf } = require("../harness");

module.exports = {
  name: "Личка с ботом — только для участников чатов бота",
  async run(t) {
    t.mock.state.chatMembers = { "-1": [1, 2, 3, 4] }; // Шестой (6) — не в чате
    const DENIED = /^Бот работает только для участников футбольных чатов/;
    await t.say(1, "/старт");

    await t.botStarted(6);
    t.ok(!!t.find(DENIED, dmOf(6)) && !t.find(/^👋/, dmOf(6)), "чужой открыл бота — отказ без меню");
    await t.say(6, "+", { dm: true });
    await t.say(6, "/статус", { dm: true });
    t.ok(t.count(DENIED, dmOf(6)) === 3 && !t.roster().text.includes("Шестой"), "чужой не записывается и не получает статус из лички");
    t.ok(/\[dm\] отказ: .*user_id=6\) не состоит ни в одном чате бота/.test(t.log), "попытка записана в лог");

    await t.botStarted(4);
    const menu = t.find(/^👋 Бот записи/, dmOf(4));
    await t.click(6, menu, "➕ Записаться", { dm: true });
    t.ok(DENIED.test(t.toast()) && t.lines(t.roster()).length === 0, "кнопка из лички у чужого — отказ");
    await t.click(4, menu, "➕ Записаться", { dm: true });
    t.ok(t.toast() === "✅ Вы записаны" && t.lines(t.roster()).join("|") === "1. Влад", "участник чата записывается из лички как раньше");
  },
};
