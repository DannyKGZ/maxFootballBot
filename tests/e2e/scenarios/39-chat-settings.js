const path = require("path");
const Database = require("better-sqlite3");
const { dmOf } = require("../harness");

const DETAILS = "Т-банк +7 (900) 111-22-33, Мария П.";

module.exports = {
  name: "⚙️ Настройки чата: новый чат — легенда и манишки выкл; прежний чат — всё как было",
  env: { CHAT_IDS: "-1,-2", PAYMENT_DETAILS: DETAILS, REMINDER_HOURS_BEFORE: "5" },
  async run(t) {
    const opts = () => {
      const d = new Database(path.join(t.dataDir, "bot.db"), { readonly: true });
      const get = (k) => d.prepare("SELECT value FROM meta WHERE key = ?").get(k)?.value;
      const r = { "-1": JSON.parse(get("chat_opts:-1") || "{}"), "-2": JSON.parse(get("chat_opts:-2") || "{}"), pay1: get("payment:-1"), max1: get("max_players:-1") };
      d.close();
      return r;
    };

    // Новые чаты: легенда и манишки выключены.
    await t.say(1, "/легенда");
    t.ok(/^🏆 Легенда в этом чате выключена/.test(t.all().pop().text), "в новом чате легенда выключена");
    await t.say(2, "/настройки");
    t.ok(!!t.find(/Только для админов/), "настройки — только админ");

    await t.botStarted(1);
    await t.click(1, t.find(/Панель администратора/, dmOf(1)), "⚙️ Настройки", { dm: true });
    const screen = () => t.find(/^⚙️ Настройки/, dmOf(1));
    t.ok(screen() && /🏆 Легенда .*: выкл/.test(screen().text) && /👕 Манишки .*: выкл/.test(screen().text), "экран настроек в личке", screen() && screen().text);
    t.ok(t.buttons(screen()).join("|") === "❌ 🏆 Легенда|❌ 👕 Манишки|✅ 💰 Оплата|❌ 📄 Чеки|✅ 🎉 Поздравления|✅ 📌 Внизу|⏰ 5 ч|🗳 вручную|⏱ вручную", "кнопки-переключатели", t.buttons(screen()));

    await t.click(1, screen(), "❌ 🏆 Легенда", { dm: true });
    t.ok(t.toast() === "🏆 Легенда включена." && t.buttons(screen())[0] === "✅ 🏆 Легенда" && /🏆 Легенда .*: вкл/.test(screen().text), "легенда включена кнопкой, экран обновился");
    await t.click(1, screen(), "⏰ 5 ч", { dm: true });
    t.ok(t.buttons(screen()).includes("⏰ 6 ч") && opts()["-1"].reminderBefore === 6, "напоминание: следующее значение по кругу");
    await t.click(1, screen(), "❌ 📄 Чеки", { dm: true });
    t.ok(/^Включить: \/чеки/.test(t.toast()), "чеки без реквизитов — подсказка");
    await t.say(1, "/чеки +7 (900) 111-22-33 Мария П.");
    t.ok(/^✅ Чеки проверяются: перевод на \+7 \(900\) 111-22-33, получатель Мария П\./.test(t.all().pop().text) && opts()["-1"].receipts.recipient === "Мария П.", "/чеки — включает проверку");
    await t.say(1, "/оплата выкл");
    t.ok(opts()["-1"].payment === false, "/оплата выкл");
    t.ok(opts()["-2"].legend === false && opts()["-2"].maniska === false, "второй чат — свои настройки, не тронуты");

    // Прежний чат (есть рейтинг, настроек нет): при запуске получает всё как было.
    await t.stopBot();
    const d = new Database(path.join(t.dataDir, "bot.db"));
    d.prepare("DELETE FROM meta WHERE key IN ('chat_opts:-2', 'payment:-2', 'max_players:-2')").run();
    d.prepare("INSERT INTO mvp_players (chat_id, name_key, name, count, season_count, year_count) VALUES (-2, 'рома', 'Рома', 3, 1, 3)").run();
    d.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('chat_opts:-2', ?)").run(JSON.stringify({ maniska: false, paymentBefore: 0, paymentAfter: 2 }));
    d.close();
    await t.startBot();
    const o = opts();
    const legacy = o["-2"];
    t.ok(legacy.legend === true && legacy.maniska === false && legacy.payment === true && legacy.reminderBefore === 5 && legacy.paymentBefore === 0 && legacy.paymentAfter === 2, "прежний чат: легенда вкл, манишки и напоминания — как были", legacy);
    const d2 = new Database(path.join(t.dataDir, "bot.db"), { readonly: true });
    const pay2 = d2.prepare("SELECT value FROM meta WHERE key = 'payment:-2'").get()?.value;
    d2.close();
    t.ok(pay2 && JSON.parse(pay2).details === DETAILS, "прежнему чату реквизиты из .env записаны в базу", pay2);
    t.ok(o["-1"].legend === true && o["-1"].reminderBefore === 6, "уже настроенный чат при запуске не меняется");
    t.ok(/\[settings\] чат -2: настройки сохранены в базе как были/.test(t.log), "перенос — в логе");
  },
};
