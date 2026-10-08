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
    const user = t.helpDm(2);
    t.ok(user.startsWith("ℹ️ Как пользоваться") && user.includes("вы записали 1: Ruslan"), "участнику — его инструкция и статус");
    t.ok(USER_COMMANDS.every((c) => user.includes(c)), "в ней все команды участника", USER_COMMANDS.filter((c) => !user.includes(c)));
    const leaked = ADMIN_COMMANDS.filter((c) => user.includes(c));
    t.ok(leaked.length === 0, "ни одной админской команды у участника", leaked);

    await t.say(1, "/help");
    const adminParts = t.dmTo(1).filter((m) => m.text.startsWith("ℹ️ Инструкция администратора") || m.text.includes("— часть "));
    const admin = t.helpDm(1);
    t.ok(admin.startsWith("ℹ️ Инструкция администратора"), "/help от админа — инструкция администратора в личку");
    t.ok(adminParts.length > 1, "инструкция админа пришла несколькими частями", adminParts.length);
    const oversized = t.dmTo(1).filter((m) => m.text.length > 4000).map((m) => m.text.length);
    t.ok(oversized.length === 0, "ни одна часть не превышает лимит MAX в 4000 символов", oversized);
    const numbered = adminParts.every((m, i) => m.text.endsWith(`— часть ${i + 1} из ${adminParts.length}`));
    t.ok(numbered, "части пронумерованы «— часть N из M»");
    const split = adminParts.slice(1).every((m) => /^[^•]/.test(m.text));
    t.ok(split, "часть начинается с заголовка раздела, а не с обрывка списка");
    const missing = ADMIN_COMMANDS.filter((c) => !admin.includes(c));
    t.ok(missing.length === 0, "в инструкции админа есть все админские команды", missing);
    t.ok(USER_COMMANDS.every((c) => admin.includes(c)), "и отдельно — команды участников");
    t.ok(!t.all(GROUP).some((m) => m.text.startsWith("ℹ️")), "в общем чате инструкций нет");

    await t.say(3, "/инструкция");
    t.ok(t.helpDm(3).startsWith("ℹ️ Как пользоваться"), "/инструкция от участника — его инструкция в личку");
    await t.say(9, "/help");
    t.ok(!!t.find(/Чтобы получить инструкцию, откройте бота/), "не открывавшему бота — подсказка в чате");
  },
};
