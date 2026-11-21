module.exports = {
  name: "Очередь событий: запись до 200, повтор после ошибки и защита от дублей",
  async run(t) {
    const update = t.messageUpdate(2, "/история");
    t.mock.state.failOnce.add("POST /messages");
    const accepted = await t.post(update);
    t.ok(accepted.ok && t.query("SELECT id FROM incoming_updates").length === 1, "вебхук подтверждает событие после сохранения");
    await t.waitFor(() => t.query("SELECT attempts FROM incoming_updates")[0].attempts === 1);
    await t.restartBot();
    await t.post(update);
    await t.waitFor(() => t.query("SELECT payload FROM incoming_updates")[0].payload === null);
    const responses = t.count(/^За последние полгода/);
    await t.post(update);
    await t.idle();
    t.ok(responses === 1 && t.count(/^За последние полгода/) === 1, "после рестарта событие обработано один раз");
    t.ok(t.query("SELECT id FROM incoming_updates").length === 1, "повторная доставка не создаёт второе задание");

    await t.say(1, "/старт");
    t.mock.state.failOnce.add("POST /messages");
    await t.post(t.messageUpdate(2, "+Друг"));
    await t.waitFor(() => t.lines(t.roster()).includes("1. Друг"));
    t.ok(t.lines(t.roster()).length === 1, "после ошибки публикации игрок добавлен ровно один раз");
  },
};
