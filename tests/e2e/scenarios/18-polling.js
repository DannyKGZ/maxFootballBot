module.exports = {
  name: "Режим polling (для сервера): приём без вебхука и туннеля",
  env: { UPDATES_MODE: "polling" },
  async run(t) {
    t.ok(t.mock.state.deletedSubscriptions.includes("https://old-tunnel.trycloudflare.com/webhook"), "старая подписка на вебхук снята — иначе polling не работает");
    t.ok(t.log.includes("приём сообщений через long polling"), "бот перешёл в режим long polling");
    t.ok(t.log.includes("127.0.0.1:"), "HTTP-порт слушается только локально (снаружи бот не нужен)");

    await t.say(1, "/старт");
    await t.say(2, "+");
    await t.say(3, "+Петя +Коля");
    t.ok(t.lines(t.roster()).length === 3, "команды доходят через GET /updates", t.lines(t.roster()));
    await t.click(3, t.roster(), "➖ Убрать себя");
    await t.click(3, t.find(/Кого удалить/), "Коля");
    t.ok(t.lines(t.roster()).length === 2 && !t.lines(t.roster()).some((l) => l.includes("Коля")), "кнопки тоже работают");

    const before = t.lines(t.roster()).length;
    await t.restartBot();
    await t.idle();
    t.ok(t.lines(t.roster()).length === before, "после перезапуска старые события не обрабатываются повторно (marker в базе)");
    t.ok(Number(t.query("SELECT value FROM meta WHERE key = 'updates_marker'")[0].value) === t.mock.state.updates.length, "marker сохранён в базе");
    await t.say(4, "+");
    t.ok(t.lines(t.roster()).some((l) => l.includes("Влад")), "после перезапуска новые события принимаются");
  },
};
