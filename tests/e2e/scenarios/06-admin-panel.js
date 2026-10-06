const { GROUP, dmOf } = require("../harness");

module.exports = {
  name: "Панель админа в личке и кнопка «Инструкция»",
  async run(t) {
    await t.botStarted(1);
    const panel = t.find(/Панель администратора/, dmOf(1));
    t.ok(!!panel, "bot_started → панель в личке админа");
    t.ok(t.buttons(panel).join("|") === "➕ Записаться|➖ Убрать себя|📋 Статус|🏆 Рейтинг MVP|✏️ Изменить имя|🔄 Новая запись|⏹ Закрыть запись|✏️ Список игроков|⚽ Дележка|🗳 Начать голосование|🏁 Итоги голосования|🗓 Расписание|🔗 Объединить в рейтинге|🧹 Сброс сезона MVP|🗑 Сброс всего MVP|ℹ️ Инструкция", "в панели все админ-кнопки", t.buttons(panel));
    await t.say(4, "привет", { dm: true });
    const userDm = t.find(/./, dmOf(4));
    t.ok(userDm.text.startsWith("👋 Это бот записи") && t.buttons(userDm).join("|") === "➕ Записаться|➖ Убрать себя|📋 Статус|🏆 Рейтинг MVP|✏️ Изменить имя|ℹ️ Инструкция", "не-админу в личке — приветствие и кнопки участника, без админских", t.buttons(userDm));

    await t.click(1, panel, "🔄 Новая запись", { dm: true });
    t.ok(t.roster() && t.roster().chat === GROUP, "кнопка из лички публикует запись в группе");
    await t.say(2, "+");
    await t.say(2, "+Валера");
    await t.click(1, panel, "🔄 Новая запись", { dm: true });
    const confirm = t.find(/Начать новую\?/, dmOf(1));
    t.ok(!!confirm, "подтверждение приходит в личку, а не в группу");
    await t.click(1, confirm, "Нет", { dm: true });
    t.ok(t.toast() === "Отменено" && !t.find(/Начать новую\?/, dmOf(1)), "«Нет» отменяет и убирает вопрос");

    await t.click(1, panel, "🗳 Начать голосование", { dm: true });
    t.ok(t.find(/Голосование за MVP/) && t.find(/Голосование за MVP/).chat === GROUP, "голосование опубликовано в группе");
    await t.click(4, panel, "🏁 Итоги голосования", { dm: true });
    t.ok(t.toast() === "Только для администраторов чата", "не-админ не может нажать кнопку панели");
    await t.click(1, panel, "🏁 Итоги голосования", { dm: true });
    t.ok(!!t.find(/^🏆 MVP матча/), "итоги из лички опубликованы в группе");

    await t.click(1, panel, "🔗 Объединить в рейтинге", { dm: true });
    t.ok(!!t.find(/\/объединить Рус = Ruslan/, dmOf(1)), "подсказка по объединению в личке");
    await t.say(1, "/объединить Никто = Ruslan", { dm: true });
    t.ok(!!t.find(/нет игрока «Никто»/, dmOf(1)), "команда объединения работает в личке");

    await t.click(2, t.roster(), "ℹ️ Инструкция");
    const help = t.dmTo(2).pop();
    t.ok(help && help.text.includes("вы записали 2: Ruslan, Валера") && !help.text.includes("Для администратора"), "участнику — личный статус, без админских разделов", help && help.text);
    await t.click(1, t.roster(), "ℹ️ Инструкция");
    t.ok(t.dmTo(1).pop().text.startsWith("ℹ️ Инструкция администратора"), "админу — расширенная инструкция");
    await t.click(9, t.roster(), "ℹ️ Инструкция");
    t.ok(/откройте бота/i.test(t.toast()), "не открывавшему бота — подсказка", t.toast());
    t.ok(!t.all(GROUP).some((m) => m.text.startsWith("ℹ️") || /Панель администратора/.test(m.text)), "в группе нет ни инструкций, ни панели");
    t.ok(!t.all(GROUP).some((m) => t.buttons(m, true).some((b) => /adm_|admin_restart|dm_/.test(b.payload))), "в группе нет ни одной админ-кнопки");

    await t.click(1, panel, "⏹ Закрыть запись", { dm: true });
    await t.click(1, t.find(/Закрыть её без открытия новой/, dmOf(1)), "Да, закрыть", { dm: true });
    t.ok(t.all(GROUP).find((m) => m.text.startsWith("Футбол в")).text.includes("— Запись закрыта —"), "запись закрыта из лички");
  },
};
