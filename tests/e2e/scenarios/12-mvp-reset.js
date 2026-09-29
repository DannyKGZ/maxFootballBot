const path = require("path");
const Database = require("better-sqlite3");
const { dmOf, GROUP } = require("../harness");

module.exports = {
  name: "Рейтинг MVP: сезонный и общий счёт, сбросы",
  preload(dir) {
    // База в том виде, как она была до появления сезонного счёта.
    const d = new Database(path.join(dir, "bot.db"));
    d.exec(`CREATE TABLE mvp_players (chat_id INTEGER NOT NULL, name_key TEXT NOT NULL, name TEXT NOT NULL,
            count INTEGER NOT NULL, PRIMARY KEY (chat_id, name_key));
            CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            INSERT INTO mvp_players VALUES (-1, 'рус', 'Рус', 3);
            INSERT INTO meta VALUES ('json_migrated', 'x');`);
    d.close();
  },
  async run(t) {
    const season = (name) => (t.query("SELECT season_count s FROM mvp_players WHERE name_key = ?", name.toLowerCase())[0] || {}).s;
    const win = async (uid, name) => {
      await t.say(1, "/голосование");
      await t.click(uid, t.find(/Голосование за MVP/), name);
      await t.say(1, "/итоги");
    };

    t.ok(t.log.includes("добавлен сезонный счёт"), "старая база дополнена сезонным счётом");
    t.ok(t.mvpCount("Рус") === 3 && season("Рус") === 3, "прошлые победы засчитаны и в сезон");
    await t.say(2, "/mvp");
    const r1 = t.find(/^🏆 Рейтинг MVP/).text;
    t.ok(r1.includes("Сезон:\n🥇 Рус — 3") && r1.includes("За всё время:\n🥇 Рус — 3"), "/mvp показывает сезон и всё время", r1);

    await t.say(1, "/старт");
    await t.say(2, "+");
    await win(2, "Ruslan");
    t.ok(t.mvpCount("Ruslan") === 1 && season("Ruslan") === 1, "победа идёт и в общий, и в сезонный счёт");

    await t.say(4, "/мвпСезонныйСброс");
    t.ok(!!t.find(/только администраторам/) && !t.find(/Обнулить сезонный/), "не-админ не может сбросить");
    await t.say(1, "/мвпСезонныйСброс");
    const q = t.find(/Обнулить сезонный рейтинг MVP\?/);
    t.ok(!!q, "админу — вопрос с подтверждением");
    await t.click(4, q, "Да");
    t.ok(t.toast().includes("не участвуете") && season("Рус") === 3, "чужое «Да» не срабатывает");
    await t.click(1, q, "Нет");
    t.ok(season("Рус") === 3 && !t.find(/Обнулить сезонный/), "«Нет» — ничего не сброшено, вопрос убран");

    await t.say(1, "/мвп_сезонный_сброс");
    await t.click(1, t.find(/Обнулить сезонный/), "Да, обнулить сезон");
    t.ok(!!t.find(/Сезонный рейтинг MVP обнулён/), "объявление о новом сезоне в чате");
    t.ok(season("Рус") === 0 && season("Ruslan") === 0 && t.mvpCount("Рус") === 3 && t.mvpCount("Ruslan") === 1, "сезон обнулён, общий счёт сохранён");
    await t.say(2, "/mvp");
    const r2 = t.find(/^🏆 Рейтинг MVP/).text;
    t.ok(/Сезон \(с \d\d\.\d\d\.\d{4}\):\nпока никого/.test(r2) && r2.includes("🥇 Рус — 3\n🥈 Ruslan — 1"), "/mvp: новый сезон пуст, всё время на месте", r2);

    await win(2, "Ruslan");
    t.ok(season("Ruslan") === 1 && t.mvpCount("Ruslan") === 2, "в новом сезоне счёт идёт с нуля, общий растёт");

    await t.botStarted(1);
    await t.click(1, t.find(/Панель администратора/, dmOf(1)), "🗑 Сброс всего MVP", { dm: true });
    const q2 = t.find(/Обнулить ВЕСЬ рейтинг MVP/, dmOf(1));
    t.ok(!!q2 && !t.find(/Обнулить ВЕСЬ/, GROUP), "кнопка в панели — подтверждение в личке, не в группе");
    await t.click(1, q2, "Да, обнулить всё", { dm: true });
    t.ok(t.query("SELECT count(*) n FROM mvp_players")[0].n === 0, "весь рейтинг удалён");
    t.ok(!!t.find(/Рейтинг MVP полностью обнулён/, GROUP), "объявление в общем чате");
    await t.say(2, "/mvp");
    t.ok(t.find(/^🏆 Рейтинг MVP/).text.includes("пока пуст"), "/mvp: рейтинг пуст");
  },
};
