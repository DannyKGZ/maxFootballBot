const path = require("path");
const Database = require("better-sqlite3");
const { dmOf } = require("../harness");

module.exports = {
  name: "Легенда (1-й, на год) и манишкаНосец (2-й, кнопка после игры)",
  async run(t) {
    const L = (msg = t.roster()) => t.lines(msg).join("|");
    await t.say(1, "/старт");
    for (const uid of [2, 3, 4, 5]) await t.say(uid, "+");

    await t.say(2, "/легенда");
    t.ok(!!t.find(/только администраторам/), "назначает только админ");
    await t.say(1, "/легенда");
    const choice = t.find(/^🏆 Легенда — сейчас: никто/);
    t.ok(choice && t.buttons(choice).join("|") === "Админ|Влад Тюев|Пятый|Рома Власенко|Чужой|Шестой|Ruslan|Отмена", "легенда — из всех участников чата (без бота)", choice && t.buttons(choice));
    await t.click(2, choice, "Рома");
    t.ok(t.toast() === "Назначает только админ", "чужое нажатие не действует");
    await t.click(1, choice, "Рома");
    t.ok(L() === "1. Рома — Легенда 🏆🏅⚽|2. Ruslan|3. Влад|4. Пятый", "легенда сразу 1-й с пометкой", L());
    t.ok(/^✅ 🏆 Легенда: Рома \(до \d\d\.\d\d\.\d{4}\)/.test(choice.text), "в сообщении — до какой даты", choice.text);

    await t.say(1, "/манишкаНосец");
    const mChoice = t.find(/^👕 манишкаНосец — сейчас: никто/);
    t.ok(t.buttons(mChoice).join("|") === "Рома|Ruslan|Влад|Пятый|Отмена", "манишкаНосец — только из записавшихся", t.buttons(mChoice));
    await t.click(1, mChoice, "Влад");
    t.ok(L() === "1. Рома — Легенда 🏆🏅⚽|2. Влад — 👕 манишкаНосец|3. Ruslan|4. Пятый", "манишкаНосец — 2-й", L());

    // Новая запись: легенда и манишкаНосец записаны сразу.
    await t.say(1, "/старт");
    await t.click(1, t.find(/Точно начать новую/), "Да, начать новую");
    t.ok(L() === "1. Рома Власенко — Легенда 🏆🏅⚽|2. Влад — 👕 манишкаНосец", "в новой записи — сразу оба (легенда — с фамилией из профиля)", L());
    await t.say(3, "-");
    await t.click(3, t.find(/Удалить из списка: Рома\?/), "Да");
    t.ok(L() === "1. Влад — 👕 манишкаНосец", "легенда может удалиться сам", L());
    await t.say(2, "+");
    await t.say(3, "+");
    t.ok(L() === "1. Рома — Легенда 🏆🏅⚽|2. Влад — 👕 манишкаНосец|3. Ruslan", "записался снова — опять 1-й", L());

    // После игры: кнопка «Я забрал манишки» (нажать может только игравший).
    await t.say(1, "/голосование");
    const prompt = () => t.find(/^👕 Кто забрал манишки\?$/);
    t.ok(!!prompt() && /^🏆 Голосование/.test(t.all().pop().text), "кнопка манишек рядом с голосованием, голосование — последним");
    await t.click(5, prompt(), "👕 Я забрал");
    t.ok(t.toast() === "Нажать может только тот, кто играл", "не игравший нажать не может");
    await t.click(2, prompt(), "👕 Я забрал");
    t.ok(t.buttons(prompt()).join("|") === "👕 Ruslan", "Ruslan забрал — на кнопке его имя, текст тот же", t.buttons(prompt()));
    t.ok(L() === "1. Рома — Легенда 🏆🏅⚽|2. Ruslan — 👕 манишкаНосец", "открытая запись: Ruslan 2-й, Влад (был записан только из-за манишек) убран", L());
    await t.click(3, prompt(), "👕 Ruslan");
    t.ok(t.toast() === "Манишки забрал Ruslan", "другим нажатие на имя — подсказка, кто забрал");
    await t.click(2, prompt(), "👕 Ruslan");
    t.ok(t.buttons(prompt()).join("|") === "👕 Я забрал манишки" && L() === "1. Рома — Легенда 🏆🏅⚽|2. Влад — 👕 манишкаНосец|3. Ruslan", "«Я ошибся» — манишки снова у Влада, можно нажать заново", L());
    await t.click(3, prompt(), "👕 Я забрал");
    t.ok(t.buttons(prompt()).join("|") === "👕 Рома", "другой игрок может нажать");
    t.ok(L() === "1. Рома — Легенда 🏆🏅⚽|2. Ruslan", "легенда сам забрал манишки: он один раз, 1-м; Влад (записан из-за манишек) убран", L());

    await t.say(4, "/статус");
    t.ok(/🏆 Легенда: Рома \(до /.test(t.find(/^📋|Расписание:/).text), "/статус показывает легенду");
    await t.say(1, "/итоги");
    t.ok(!!prompt(), "сообщение манишек не удалено после итогов");

    // Панель админа в личке: кнопка «👕 МанишкаНосец» → выбор там же.
    await t.botStarted(1);
    await t.click(1, t.find(/Панель администратора/, dmOf(1)), "👕 МанишкаНосец", { dm: true });
    const dmChoice = t.find(/^👕 манишкаНосец — сейчас: Рома/, dmOf(1));
    t.ok(!!dmChoice, "из панели в личке — выбор манишкаНосца", t.all(dmOf(1)).map((m) => m.text.slice(0, 40)));
    t.ok(t.buttons(dmChoice).join("|") === "✅ Рома|Ruslan|✖️ Снять роль|Отмена", "в выборе — только записавшиеся", t.buttons(dmChoice));
    await t.click(1, dmChoice, "Ruslan", { dm: true });
    t.ok(L() === "1. Рома — Легенда 🏆🏅⚽|2. Ruslan — 👕 манишкаНосец" && /^✅ 👕 манишкаНосец: Ruslan/.test(dmChoice.text), "назначен из лички — сразу 2-й в открытой записи", [L(), dmChoice.text]);

    // Через год легенда истекает.
    await t.stopBot();
    const d = new Database(path.join(t.dataDir, "bot.db"));
    const row = d.prepare("SELECT value FROM meta WHERE key = 'role_legend:-1'").get();
    const h = JSON.parse(row.value);
    h.since -= 366 * 86_400_000;
    d.prepare("UPDATE meta SET value = ? WHERE key = 'role_legend:-1'").run(JSON.stringify(h));
    d.close();
    await t.startBot();
    await t.say(4, "+Новичок");
    t.ok(!L().includes("Легенда"), "через год пометки «Легенда» нет", L());
  },
};
