const path = require("path");
const Database = require("better-sqlite3");
const { dmOf } = require("../harness");

const H = 3_600_000;
const ENV = {
  CHAT_IDS: "-1,-2",
  PAYMENT_HOURS_BEFORE: "0",
  PAYMENT_HOURS_AFTER: "2",
  PAYMENT_AMOUNT: "350",
  PAYMENT_DETAILS: "Т-банк +7 (900) 111-22-33, получатель Мария П.",
  TICK_INTERVAL_MS: "300",
};

module.exports = {
  name: "Оплата с PDF-чеками: проверка суммы и получателя, список, /должники, /оплатил",
  env: ENV,
  async run(t) {
    // Разбор чека (чистые функции).
    const { CHAT_IDS, ...envForDist } = ENV;
    Object.assign(process.env, envForDist, { BOT_TOKEN: "test", DOTENV_CONFIG_PATH: "/nonexistent" });
    const { findAmount, recipientMatches } = require("../../../dist/receiptLogic");
    t.ok(findAmount("Итого\n1 050 ₽\nСумма 1 050 ₽") === 1050 && findAmount("Сумма перевода 700,00 ₽") === 700 && findAmount("Итого\n350 ₽") === 350 && findAmount("без суммы") === null, "сумма из текста чека");
    const exp = { phone: "+7 (900) 111-22-33", recipient: "Мария П." };
    t.ok(recipientMatches("Телефон получателя +7 (900) 111-22-33", exp) && recipientMatches("Получатель Мария П.", exp) && !recipientMatches("Получатель Иван И. +7 (900) 000-00-00", exp), "получатель: по телефону или имени");

    // «Лига» (-2): проверка чеков включена; игра была 1,5 ч назад.
    await t.stopBot();
    const d = new Database(path.join(t.dataDir, "bot.db"));
    d.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('chat_opts:-2', ?)").run(JSON.stringify({ receipts: exp, paymentBefore: 0, paymentAfter: 2 }));
    const p = (userId, displayName, extra = {}) => ({ userId, displayName, profileName: displayName, isReserve: false, joinedAt: 0, ...extra });
    const players = [p(2, "Ruslan"), p(3, "Рома"), p(4, "Влад"), p(5, "Пятый"), p(6, "Шестой"), { userId: 6, displayName: "Петя", addedByName: "Шестой", isReserve: false, joinedAt: 0 }];
    d.prepare("INSERT OR REPLACE INTO sessions (chat_id, data) VALUES (?, ?)").run(-2, JSON.stringify({ chatId: -2, messageId: null, createdAt: 0, date: new Date(Date.now() - 1.5 * H).toISOString(), players }));
    d.close();
    await t.startBot();
    await t.idle(1500);
    const pay = () => t.find(/^💰 Оплата за игру/, -2);
    t.ok(pay() && pay().text.includes("Оплатили: 0 из 5") && pay().text.includes("PDF-чек") && (pay().text.match(/max:\/\/user\//g) || []).length === 5, "список оплаты: все 5 с упоминаниями и просьбой прислать PDF", pay() && pay().text);
    t.ok(pay().text.includes('<a href="max://user/6">Шестой</a> — 700 ₽ (Шестой, Петя)'), "кто записывал друга — платит за двоих");

    await t.sendFile(2, "receipt-350.pdf");
    t.ok(/^✅ Оплата 350 ₽ за игру .* принята/.test(t.all(dmOf(2)).pop().text), "PDF на 350 ₽ — принят", t.all(dmOf(2)).pop().text);
    t.ok(pay().text.includes("✅ Ruslan — 350 ₽") && pay().text.includes("Оплатили: 1 из 5") && !pay().text.includes("max://user/2"), "список обновился, Ruslan больше не упоминается");

    await t.sendFile(3, "photo.jpg", "image");
    t.ok(/^Нужен PDF-файл с чеком/.test(t.all(dmOf(3)).pop().text) && pay().text.includes("📎 Рома — 350 ₽ — ждём PDF-чек") && !pay().text.includes("max://user/3"), "не PDF — просим PDF и больше не упоминаем");

    await t.sendFile(4, "receipt-1050.pdf");
    const ask = t.all(dmOf(4)).pop();
    t.ok(/Осталось 700 ₽ — за кого ещё/.test(ask.text) && t.buttons(ask).join("|") === "Рома — 350 ₽|Пятый — 350 ₽|Шестой — 700 ₽|Готово", "1050 ₽ — свои 350 и выбор, за кого ещё", t.buttons(ask));
    await t.click(4, ask, "Пятый", { dm: true });
    await t.click(4, ask, "Рома", { dm: true });
    t.ok(/^✅ Готово: отмечены вы и Рома/.test(ask.text), "остаток распределён", ask.text);
    t.ok(pay().text.includes("✅ Влад") && pay().text.includes("✅ Пятый") && pay().text.includes("✅ Рома") && pay().text.includes("Оплатили: 4 из 5"), "Влад, Пятый и Рома отмечены", pay().text);

    await t.sendFile(6, "receipt-300.pdf");
    t.ok(/передал админу на ручную проверку/i.test(t.all(dmOf(6)).pop().text) && pay().text.includes("⏳ Шестой — 700 ₽ (Шестой, Петя) — чек на проверке"), "300 ₽ — на ручную проверку", t.all(dmOf(6)).pop().text);
    t.ok(t.dmTo(1).some((m) => /Чек на ручную проверку: Шестой/.test(m.text) && /сумма 300 ₽/.test(m.text)), "админу пришло, почему");
    await t.sendFile(6, "receipt-300.pdf");
    t.ok(t.dmTo(1).some((m) => /этот чек уже присылали/.test(m.text)), "повторный чек — тоже на проверку");

    await t.sendFile(2, "receipt-350-b.pdf");
    t.ok(/^Неоплаченных игр за вами не нашёл/.test(t.all(dmOf(2)).pop().text), "всё оплачено — так и отвечает");

    await t.say(3, "/должники", { chat: -2 });
    t.ok(!!t.find(/только администраторам/, -2), "/должники — только админ");
    await t.say(1, "/должники", { chat: -2 });
    const debt = t.all(-2).pop().text;
    t.ok(/^💰 Должники — [а-я]+ \d{4}: 1, на 700 ₽/.test(debt) && /\n1\. Шестой \(Шестой\) — 700 ₽, за: Шестой, Петя — \d\d\.\d\d · ⏳ чек на проверке/.test(debt), "/должники: имя (ник), сумма, дата игры, статус", debt);
    await t.say(1, "/оплатил 1", { chat: -2 });
    t.ok(/^✅ Отмечено как оплачено:\nШестой \(Шестой\) — 700 ₽/.test(t.all(-2).pop().text) && pay().text.includes("Оплатили: 5 из 5"), "/оплатил 1 — отмечен, список обновлён");
    await t.say(1, "/должники", { chat: -2 });
    t.ok(/^💰 Должников нет/.test(t.all(-2).pop().text), "должников нет");
    await t.say(1, "/должники");
    t.ok(/учёт оплаты .* не включён/.test(t.all().pop().text), "в первом чате учёта нет");
  },
};
