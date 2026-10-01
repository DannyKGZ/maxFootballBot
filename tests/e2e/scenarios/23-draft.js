module.exports = {
  name: "Дележка: админ назначает капитанов, капитаны выбирают по очереди",
  env: { MAX_PLAYERS: "6" },
  async run(t) {
    const draft = () => t.find(/^⚽/);
    await t.say(1, "/старт");
    await t.say(2, "+"); // Ruslan — капитан 1
    await t.say(3, "+"); // Рома — капитан 2
    await t.say(4, "+Андрей +Борис +Вадим +Гена +Резервист"); // Резервист — 7-й, резерв

    await t.say(4, "/дележка");
    t.ok(!!t.find(/только администраторам/) && !draft(), "не-админ не может начать дележку");
    await t.say(1, "/дележка");
    let m = draft();
    t.ok(m && t.buttons(m).join("|") === "👑 Ruslan|👑 Рома|👑 Андрей|👑 Борис|👑 Вадим|👑 Гена|✖️ Отменить дележку (админ)", "капитанов выбирают из основы (резерв не участвует)", m && t.buttons(m));
    await t.click(2, m, "👑 Ruslan");
    t.ok(t.toast() === "Капитанов назначает админ", "капитанов назначает только админ");
    await t.click(1, m, "👑 Ruslan");
    await t.click(1, draft(), "👑 Рома");
    m = draft();
    t.ok(m.text.includes("Выбирает ⚪ Ruslan") && t.buttons(m).join("|") === "Андрей|Борис|Вадим|Гена|✖️ Отменить дележку (админ)", "капитаны назначены, первым выбирает ⚪", m.text);

    await t.click(3, m, "Андрей");
    t.ok(t.toast() === "Сейчас выбирает ⚪ Ruslan", "не в свою очередь — нельзя");
    await t.click(2, draft(), "Андрей");
    t.ok(draft().text.includes("Выбирает ⚫ Рома"), "очередь перешла ко второму капитану");
    await t.click(3, draft(), "Борис");
    await t.click(1, draft(), "Вадим"); // админ выбирает за капитана ⚪
    t.ok(draft().text.includes("⚪ Команда Ruslan (3): Ruslan, Андрей, Вадим"), "админ может выбрать за капитана", draft().text);
    await t.click(3, draft(), "Гена");
    m = draft();
    t.ok(m.text.startsWith("⚽ Составы готовы!") && m.attachments.length === 0, "все разобраны — составы готовы", m.text);
    t.ok(m.text.includes("⚫ Команда Рома (3): Рома, Борис, Гена") && !m.text.includes("Резервист"), "3 на 3, резерв не в командах");

    await t.say(5, "/составы");
    t.ok(t.find(/^⚽ Составы:/) && t.find(/^⚽ Составы:/).text.includes("Команда Ruslan"), "/составы показывает команды любому");
    await t.say(5, "/статус");
    t.ok(t.find(/^📋 Статус/).text.includes("⚫ Команда Рома"), "составы видны в /статус");

    await t.say(1, "/дележка 3 4");
    m = draft();
    t.ok(m.text.includes("⚪ Команда Андрей (1)") && m.text.includes("⚫ Команда Борис (1)") && m.text.includes("Выбирает ⚪ Андрей"), "/дележка 3 4 — капитаны по номерам сразу", m.text);
    await t.say(1, "/дележка сброс");
    t.ok(!!t.find(/Дележка отменена/) && !t.find(/^⚽ Дележка/), "/дележка сброс — отменена, сообщение убрано");
  },
};
