const path = require("path");
const Database = require("better-sqlite3");

const H = 3_600_000;

module.exports = {
  name: "Настройки чата: манишки выкл, напоминания об оплате только после игры",
  env: { CHAT_IDS: "-1,-2", PAYMENT_HOURS_BEFORE: "3", PAYMENT_HOURS_AFTER: "2", TICK_INTERVAL_MS: "300" },
  async run(t) {
    const L = (chat) => t.lines(t.find(/^Футбол в/, chat)).join("|");
    await t.say(1, "/оплата 350 Т-банк +7 (900) 111-22-33 Мария П."); // в новом чате оплата выключена, пока нет реквизитов
    await t.say(1, "/оплата 350 Т-банк +7 (900) 111-22-33 Мария П.", { chat: -2 });
    await t.say(1, "/манишкаНосец вкл", { chat: -2 });
    await t.say(1, "/старт", { chat: -2 });
    await t.say(2, "+", { chat: -2 });
    await t.say(3, "+", { chat: -2 });
    await t.say(1, "/манишкаНосец Ruslan", { chat: -2 });
    t.ok(L(-2) === "1. Ruslan — 👕 манишкаНосец|2. Рома", "до выключения — манишкаНосец 2-й (тут 1-й, легенды нет)", L(-2));

    await t.say(2, "/манишкаНосец выкл", { chat: -2 });
    t.ok(!!t.find(/Только для админов/, -2), "выключает только админ");
    await t.say(1, "/манишкаНосец выкл", { chat: -2 });
    t.ok(!!t.find(/^👕 Манишки выключены:/, -2) && L(-2) === "1. Ruslan|2. Рома", "выключены: пометки нет", L(-2));
    await t.say(1, "/манишкаНосец", { chat: -2 });
    t.ok(/^👕 Манишки выключены\. Включить/.test(t.all(-2).pop().text), "/манишкаНосец — подсказка, что выключено");

    await t.say(1, "/напоминания 0 2", { chat: -2 });
    t.ok(/^✅ Напоминания об оплате: до игры — нет; после игры — 2 раза \(каждый час\)/.test(t.all(-2).pop().text), "/напоминания 0 2", t.all(-2).pop().text);
    await t.say(1, "/напоминания");
    t.ok(/^Напоминания об оплате: каждый час за 3 ч до игры; после игры — 2 раза/.test(t.all().pop().text), "в первом чате — как в .env");

    await t.say(1, "/голосование", { chat: -2 });
    t.ok(!t.find(/Кто забрал манишки/, -2), "после игры кнопки манишек нет");
    await t.say(1, "/итоги", { chat: -2 });

    // Игра в обоих чатах через 2,5 ч: в первом чате — напоминание об оплате, во втором — нет.
    await t.stopBot();
    const d = new Database(path.join(t.dataDir, "bot.db"));
    const session = (chatId, at) => JSON.stringify({ chatId, messageId: null, createdAt: 0, date: new Date(at).toISOString(), players: [{ userId: 2, displayName: "Ruslan", profileName: "Ruslan", isReserve: false, joinedAt: 0 }] });
    for (const c of [-1, -2]) d.prepare("INSERT OR REPLACE INTO sessions (chat_id, data) VALUES (?, ?)").run(c, session(c, Date.now() + 2.5 * H));
    d.close();
    await t.startBot();
    await t.idle(1500);
    t.ok(t.count(/^💰/, -1) === 1 && t.count(/^💰/, -2) === 0, "до игры: в первом чате напоминание есть, в «Лиге» — нет");

    // Игра прошла 1,5 ч назад: «Лига» напоминает (после игры).
    await t.stopBot();
    const d2 = new Database(path.join(t.dataDir, "bot.db"));
    d2.prepare("INSERT OR REPLACE INTO sessions (chat_id, data) VALUES (?, ?)").run(-2, session(-2, Date.now() - 1.5 * H));
    d2.close();
    await t.startBot();
    await t.idle(1500);
    t.ok(t.count(/^💰.*игра прошла/, -2) === 1, "после игры «Лига» напоминает");
  },
};
