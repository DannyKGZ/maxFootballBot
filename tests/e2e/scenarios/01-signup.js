module.exports = {
  name: "Запись: +, +Имя, лимиты, удаление, переход из резерва",
  env: { MAX_PLAYERS: "3" },
  async run(t) {
    await t.say(9, "/старт");
    t.ok(!t.roster(), "не-админ не может /старт");
    await t.say(1, "/старт");
    let r = t.roster();
    t.ok(!!r, "админ /старт публикует запись");
    t.ok(!t.mock.calls.some((c) => c.includes("/pin")), "запись не закрепляется");
    t.ok(t.buttons(r).join("|") === "➕ Записаться|➖ Убрать себя|🏆 Рейтинг MVP|ℹ️ Инструкция", "под записью только кнопки участников", t.buttons(r));

    await t.say(2, "+");
    t.ok(t.lines(t.roster()).join("|") === "1. Ruslan", "голый «+» — имя из профиля, без скобок", t.lines(t.roster()));
    await t.click(3, t.roster(), "➕ Записаться");
    await t.say(3, "+Руслан");
    t.ok(t.lines(t.roster()).length === 3, "кнопка «Записаться» и «+Руслан» без подтверждения");

    await t.say(4, "+А +Б +В +Г +Д +Е");
    t.ok(!!t.find(/не больше 5 игроков/) && t.lines(t.roster()).length === 3, "6 имён одним сообщением — отказ, никто не добавлен");
    await t.say(4, "+" + "Очень".repeat(10));
    t.ok(!!t.find(/слишком длинное/), "слишком длинное имя — отказ");
    await t.say(4, "+123");
    t.ok(!!t.find(/хотя бы одну букву/), "имя без букв — отказ");

    await t.say(4, "+Сергей +Владимир");
    r = t.roster();
    t.ok(t.lines(r).length === 5 && t.lines(r)[3].includes("Сергей (Резерв)"), "массовый ввод; после 3 мест — резерв", t.lines(r));

    await t.say(3, "-Руслан");
    t.ok(!t.lines(t.roster()).some((l) => l.includes("Руслан")) && !t.find(/Кого убрать|Удалить из списка/), "«-Руслан» — убран сразу, без вопроса");
    t.ok(!!t.find(/^➖ Руслан убран из записи \(записывал Рома\)\n⬆️ Сергей \(записал Влад\) заменил Руслана \(из резерва\)$/), "в чате — кто ушёл и кто встал из резерва", t.all().map((m) => m.text).slice(-3));
    t.ok(!t.lines(t.roster()).find((l) => l.includes("Сергей")).includes("Резерв"), "в списке Сергей уже в основе");

    await t.say(3, "-");
    t.ok(!t.lines(t.roster()).some((l) => l.includes("Рома")) && !!t.find(/^➖ Рома ушёл из записи/), "«-» — своя запись убрана сразу, в чате «➖ Рома ушёл из записи»");

    await t.say(4, "-");
    const choice = t.find(/Кого убрать из записи\?/);
    t.ok(choice && t.buttons(choice).join("|") === "Сергей|Владимир|Отмена", "сам не записан, записал двоих — выбор кнопками", choice && t.buttons(choice));
    await t.click(4, choice, "Владимир");
    t.ok(!t.lines(t.roster()).some((l) => l.includes("Владимир")) && !t.find(/Кого убрать из записи/), "выбранный убран, вопрос удалён");

    await t.say(1, "/Всем Проверка");
    t.ok(!!t.find(/^📢 Проверка/) && !t.dmTo(2).some((m) => m.text.startsWith("📢 Объявление")), "по умолчанию /Всем только в чат, без копий в личку");

    const before = t.all().length;
    await t.say(9, "-");
    t.ok(t.all().length === before, "«-» от незаписанного ничего не делает");
  },
};
