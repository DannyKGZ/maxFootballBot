const { dmOf } = require("../harness");

module.exports = {
  name: "Админ правит список: /удалить, /переименовать, редактор в личке",
  env: { MAX_PLAYERS: "3" },
  async run(t) {
    await t.say(1, "/старт");
    await t.say(2, "+");
    await t.say(3, "+Рома +Петя +Коля"); // Коля — резерв
    t.ok(t.lines(t.roster()).length === 4, "4 игрока, последний — резерв");

    await t.say(4, "/удалить 2");
    t.ok(!!t.find(/только администраторам/) && t.lines(t.roster()).length === 4, "не-админ не может удалять чужих");

    await t.say(1, "/удалить 2");
    t.ok(!!t.find(/Админ убрал из списка: Рома/) && !t.lines(t.roster()).some((l) => l.includes("Рома")), "/удалить 2 — убран второй");
    t.ok(!!t.find(/Коля \(записал Рома\) переходит из резерва в основной состав/), "резервист поднят — уведомление");
    await t.say(1, "/удалить Никто");
    t.ok(!!t.find(/В списке нет «Никто»/), "несуществующий — понятная ошибка");

    await t.say(1, "/переименовать 1 Руслан Капитан");
    t.ok(t.lines(t.roster())[0].startsWith("1. Руслан Капитан"), "/переименовать 1 — новое имя", t.lines(t.roster()));
    await t.say(1, "/заменить Петя Пётр");
    t.ok(t.lines(t.roster()).some((l) => l.startsWith("2. Пётр")), "переименование по имени (синоним /заменить)");

    // Редактор в личке
    await t.botStarted(1);
    await t.click(1, t.find(/Панель администратора/, dmOf(1)), "✏️ Список игроков", { dm: true });
    let ed = t.find(/Список игроков — выберите/, dmOf(1));
    t.ok(t.buttons(ed).join("|") === "1. Руслан Капитан|2. Пётр|3. Коля|Закрыть", "редактор показывает список кнопками", t.buttons(ed));
    await t.click(1, ed, "3. Коля", { dm: true });
    ed = t.mock.messages.get(ed.mid);
    t.ok(t.buttons(ed).join("|") === "❌ Удалить|✏️ Переименовать|↩️ Назад к списку", "выбор игрока — действия");
    await t.click(1, ed, "✏️ Переименовать", { dm: true });
    await t.say(1, "Николай", { dm: true });
    t.ok(t.lines(t.roster()).some((l) => l.startsWith("3. Николай")) && !!t.find(/Коля → Николай/, dmOf(1)), "переименование через редактор");
    ed = t.mock.messages.get(ed.mid);
    await t.click(1, ed, "2. Пётр", { dm: true });
    await t.click(1, t.mock.messages.get(ed.mid), "❌ Удалить", { dm: true });
    t.ok(!t.lines(t.roster()).some((l) => l.includes("Пётр")) && t.toast() === "Удалён: Пётр", "удаление через редактор");

    await t.click(4, t.mock.messages.get(ed.mid), "1.", { dm: true });
    t.ok(t.toast() === "Только для администраторов чата", "чужие нажатия в редакторе не работают");
    await t.say(1, "/удалить 1", { dm: true });
    t.ok(!!t.find(/Админ убрал из списка: Руслан Капитан/, dmOf(1)), "/удалить работает и из лички");
  },
};
