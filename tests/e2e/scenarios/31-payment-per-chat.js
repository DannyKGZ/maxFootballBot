const path = require("path");
const Database = require("better-sqlite3");
const { dmOf } = require("../harness");

const H = 3_600_000;

module.exports = {
  name: "/оплата и /лимит: свои сумма, реквизиты и размер основы у каждого чата",
  env: { CHAT_IDS: "-1,-2", PAYMENT_HOURS_AFTER: "2", PAYMENT_AMOUNT: "300", PAYMENT_DETAILS: "Сбер 0000", TICK_INTERVAL_MS: "300" },
  async run(t) {
    t.mock.state.chatAdmins = { "-2": [5] };
    t.mock.state.chatMembers = { "-1": [1, 2, 3, 4], "-2": [2, 5, 6] };
    await t.say(1, "/оплата 400 Т-банк 1111 Иван", { chat: -2 });
    t.ok(!!t.find(/только администраторам/, -2), "админ другого чата не меняет оплату");
    await t.say(5, "/оплата 350₽ Т-банк 8999 Екатерина М.Г", { chat: -2 });
    t.ok(!!t.find(/^✅ Оплата этого чата: 350 ₽ с игрока на Т-банк 8999 Екатерина М\.Г/, -2), "оплата «Лиги» сохранена", t.all(-2).map((m) => m.text));
    await t.say(5, "/оплата", { dm: true });
    t.ok(/Сейчас: 350 ₽ с игрока на Т-банк 8999 Екатерина М\.Г\./.test(t.all(dmOf(5)).pop().text), "/оплата в личке — оплата своего чата");
    await t.say(1, "/оплата");
    t.ok(/Сейчас: 300 ₽ с игрока на Сбер 0000 \(по умолчанию из \.env\)/.test(t.all().pop().text), "в первом чате — из .env");

    // /лимит: в «Лиге» основа своя.
    await t.say(5, "/старт", { chat: -2 });
    for (const uid of [2, 5, 6]) await t.say(uid, "+", { chat: -2 });
    t.ok(t.lines(t.find(/^Футбол в/, -2)).join("|") === "1. Ruslan|2. Пятый|3. Шестой", "до лимита — все в основе");
    await t.say(1, "/лимит 2", { chat: -2 });
    t.ok(!!t.find(/только администраторам/, -2), "/лимит — только админ этого чата");
    await t.say(5, "/лимит 2", { chat: -2 });
    t.ok(t.lines(t.find(/^Футбол в/, -2)).join("|") === "1. Ruslan|2. Пятый|3. Шестой (Резерв)" && !!t.find(/^✅ В основе теперь 2 человек/, -2), "/лимит 2 — список сразу пересчитан");
    await t.say(5, "/лимит 15", { chat: -2 });
    t.ok(!t.lines(t.find(/^Футбол в/, -2)).some((l) => l.includes("Резерв")), "/лимит 15 — резервист снова в основе");
    await t.say(1, "/лимит");
    t.ok(/^Сейчас в основе 15 человек/.test(t.all().pop().text), "в первом чате лимит из .env (MAX_PLAYERS)");

    // Игра в обоих чатах прошла 1,5 ч назад → напоминание об оплате.
    await t.stopBot();
    const d = new Database(path.join(t.dataDir, "bot.db"));
    const session = (chatId) => JSON.stringify({ chatId, messageId: null, createdAt: 0, date: new Date(Date.now() - 1.5 * H).toISOString(), players: [{ userId: 2, displayName: "Ruslan", profileName: "Ruslan", isReserve: false, joinedAt: 0 }] });
    for (const c of [-1, -2]) d.prepare("INSERT OR REPLACE INTO sessions (chat_id, data) VALUES (?, ?)").run(c, session(c));
    d.close();
    await t.startBot();
    await t.idle(1500);
    const p1 = t.find(/^💰/, -1);
    const p2 = t.find(/^💰/, -2);
    t.ok(p1 && p1.text.includes("За игру 300 ₽ с игрока на Сбер 0000") && p1.text.includes("— 300 ₽"), "первый чат — сумма и реквизиты из .env", p1 && p1.text);
    t.ok(p2 && p2.text.includes("За игру 350 ₽ с игрока на Т-банк 8999 Екатерина М.Г") && p2.text.includes("— 350 ₽"), "«Лига» — свои сумма и реквизиты", p2 && p2.text);
  },
};
