module.exports = {
  name: "Часовой пояс: сервер в UTC, игра считается по TIMEZONE",
  env: { TZ: "UTC", TIMEZONE: "Europe/Moscow", GAME_DAY_OF_WEEK: "3", GAME_TIME: "21:30" },
  async run(t) {
    await t.say(1, "/старт");
    const date = JSON.parse(t.query("SELECT data FROM sessions WHERE chat_id = -1")[0].data).date;
    t.ok(date.endsWith("T18:30:00.000Z"), "21:30 по Москве = 18:30 UTC, а не 21:30 UTC", date);
    const moscowDay = new Date(date).toLocaleDateString("ru-RU", { timeZone: "Europe/Moscow", weekday: "long" });
    t.ok(moscowDay === "среда" && t.roster().text.startsWith("Футбол в Среда"), "день недели — среда по Москве", moscowDay);
  },
};
