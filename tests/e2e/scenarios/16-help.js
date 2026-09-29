const { GROUP } = require("../harness");

// Все админские команды — должны быть в инструкции админа и не должны быть у участника.
const ADMIN_COMMANDS = [
  "/старт", "/закрыть", "/описание", "/расписание", "/голосование", "/итоги",
  "/объединить", "/мвпСезонныйСброс", "/мвпОбщийСброс", "/Всем", "@all",
];
const USER_COMMANDS = ["«+»", "«+Рома»", "«-»", "«-Рома»", "/статус", "/mvp", "/help"];

module.exports = {
  name: "Инструкция: участнику — только его команды, админу — все админские",
  async run(t) {
    const menu = (t.mock.state.commands || []).map((c) => c.name).join(",");
    t.ok(menu === "status,mvp,help", "меню «/» в MAX — только команды участников", menu);

    await t.say(1, "/старт");
    await t.say(2, "+");

    await t.click(2, t.roster(), "ℹ️ Инструкция");
    const user = t.dmTo(2).pop().text;
    t.ok(user.startsWith("ℹ️ Как пользоваться") && user.includes("вы записали 1: Ruslan"), "участнику — его инструкция и статус");
    t.ok(USER_COMMANDS.every((c) => user.includes(c)), "в ней все команды участника", USER_COMMANDS.filter((c) => !user.includes(c)));
    const leaked = ADMIN_COMMANDS.filter((c) => user.includes(c));
    t.ok(leaked.length === 0, "ни одной админской команды у участника", leaked);

    await t.say(1, "/help");
    const admin = t.dmTo(1).pop().text;
    t.ok(admin.startsWith("ℹ️ Инструкция администратора"), "/help от админа — инструкция администратора в личку");
    const missing = ADMIN_COMMANDS.filter((c) => !admin.includes(c));
    t.ok(missing.length === 0, "в инструкции админа есть все админские команды", missing);
    t.ok(USER_COMMANDS.every((c) => admin.includes(c)), "и отдельно — команды участников");
    t.ok(!t.all(GROUP).some((m) => m.text.startsWith("ℹ️")), "в общем чате инструкций нет");

    await t.say(3, "/инструкция");
    t.ok(t.dmTo(3).pop().text.startsWith("ℹ️ Как пользоваться"), "/инструкция от участника — его инструкция в личку");
    await t.say(9, "/help");
    t.ok(!!t.find(/Чтобы получить инструкцию, откройте бота/), "не открывавшему бота — подсказка в чате");
  },
};
