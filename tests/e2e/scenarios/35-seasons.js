const path = require("path");
const Database = require("better-sqlite3");

module.exports = {
  name: "Сезоны по временам года, игровой год с декабря, легенда года",
  env: { TICK_INTERVAL_MS: "300" },
  async run(t) {
    // Календарь (чистая функция).
    const { seasonOf, seasonLabel } = require("../../../dist/gameSeasons");
    const s = (y, m, d) => seasonOf(new Date(y, m - 1, d));
    t.ok(
      s(2026, 11, 30).key === "2026-Осень" && s(2026, 12, 1).key === "2027-Зима" && s(2027, 2, 28).key === "2027-Зима" &&
        s(2027, 3, 1).key === "2027-Весна" && s(2027, 6, 1).key === "2027-Лето" && s(2027, 9, 1).key === "2027-Осень",
      "сезоны: зима дек–фев, весна, лето, осень; игровой год — с 1 декабря",
    );
    t.ok(seasonLabel(s(2026, 12, 5)) === "Зима 2026/27" && seasonLabel(s(2026, 10, 1)) === "Осень 2026" && s(2026, 12, 5).start.getMonth() === 11, "названия сезонов");

    // MVP: Ruslan (2 голоса).
    await t.say(1, "/старт");
    for (const uid of [2, 3, 4]) await t.say(uid, "+");
    await t.say(1, "/голосование");
    await t.click(3, t.find(/Голосование за MVP/), "Ruslan");
    await t.click(4, t.find(/Голосование за MVP/), "Ruslan");
    await t.click(2, t.find(/Голосование за MVP/), "Рома");
    t.ok(!!t.find(/^🏆 MVP матча/), "голосование закрылось");
    const u = t.query("SELECT holder FROM mvp_users WHERE chat_id = -1 AND name_key = 'ruslan'")[0];
    t.ok(u && JSON.parse(u.holder).userId === 2 && JSON.parse(u.holder).self === true, "запомнен аккаунт победителя", u);
    await t.say(5, "/mvp");
    const now = seasonOf(new Date());
    const r = t.find(/^🏆 Рейтинг MVP/).text;
    t.ok(r.includes(`Сезон «${seasonLabel(now)}»`) && r.includes(`Игровой год ${now.gameYear} (с 01.12.${now.gameYear - 1})`) && r.includes("🥇 Ruslan — 1"), "/mvp: сезон, игровой год и всё время", r);

    // Смена игрового года (как 1 декабря): делаем вид, что прошлая проверка была в прошлом игровом году.
    const setPeriod = async (key) => {
      await t.stopBot();
      const d = new Database(path.join(t.dataDir, "bot.db"));
      d.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('mvp_period:-1', ?)").run(key);
      d.close();
      await t.startBot();
      await t.idle(1500);
    };
    await setPeriod(`${now.gameYear - 1}-Осень`);
    const legend = t.find(/^🏆 Легенда \d{4} года — Ruslan: 1 MVP за игровой год/);
    t.ok(!!legend && /всегда 1-й в каждой записи — до \d\d\.\d\d\.\d{4}/.test(legend.text), "конец года: лучший по MVP — легенда года", legend && legend.text);
    t.ok(!!t.find(/^🗓 Начался сезон «/), "объявлен новый сезон");
    const role = t.query("SELECT value FROM meta WHERE key = 'role_legend:-1'")[0];
    t.ok(role && JSON.parse(role.value).userId === 2, "роль легенды назначена Ruslan");
    t.ok(t.lines(t.roster())[0] === "1. Ruslan — Легенда 🏆🏅⚽", "в открытой записи легенда сразу 1-й", t.lines(t.roster()));
    const row = t.query("SELECT count, season_count, year_count FROM mvp_players WHERE name_key = 'ruslan'")[0];
    t.ok(row.count === 1 && row.season_count === 0 && row.year_count === 0, "сезонный и годовой счёт с нуля, общий сохранён", row);

    // Смена сезона внутри года — без легенды.
    const before = t.count(/^🏆 Легенда/);
    await setPeriod(`${now.gameYear}-Лето`);
    t.ok(t.count(/^🏆 Легенда/) === before && t.count(/^🗓 Начался сезон/) === 2, "новый сезон в том же году — только объявление сезона");
    await t.restartBot();
    await t.idle(1000);
    t.ok(t.count(/^🗓 Начался сезон/) === 2, "повторно не объявляет");
  },
};
