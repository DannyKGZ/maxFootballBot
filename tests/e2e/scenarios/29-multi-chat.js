const { dmOf } = require("../harness");

const LEAGUE = -2;

module.exports = {
  name: "Два чата: своя запись, расписание и админы; выбор чата в личке",
  env: { CHAT_IDS: "-1,-2", CRON_SCHEDULE: "0 9 * * 1,5" },
  async run(t) {
    const st = t.mock.state;
    st.chatAdmins = { [LEAGUE]: [5] }; // в «Лиге» свой админ — Пятый; в первом чате — Админ (1)
    st.chatMembers = { "-1": [1, 2, 3, 4], [LEAGUE]: [2, 5, 6] }; // Ruslan (2) — в обоих

    t.ok(/чат -1: запись по расписанию "0 9 \* \* 1,5"/.test(t.log) && /чат -2: запись по расписанию "0 9 \* \* 1,5"/.test(t.log), "у каждого чата своя задача публикации");

    // Свои админы
    await t.say(5, "/старт");
    t.ok(!t.roster(), "в первом чате админ «Лиги» не может открыть запись");
    await t.say(5, "/старт", { chat: LEAGUE });
    t.ok(!!t.find(/^Футбол в/, LEAGUE), "во втором чате админ «Лиги» открыл запись");
    await t.say(1, "/старт", { chat: LEAGUE });
    t.ok(t.count(/^Футбол в/, LEAGUE) === 1 && !t.roster(), "админ первого чата во втором — не админ");
    await t.say(1, "/старт");
    t.ok(!!t.roster(), "в первом чате — своя запись");

    // Записи раздельные
    await t.say(6, "+", { chat: LEAGUE });
    await t.say(3, "+");
    const lg = t.lines(t.find(/^Футбол в/, LEAGUE));
    const first = t.lines(t.roster());
    t.ok(lg.length === 1 && lg[0].includes("Шестой") && first.length === 1 && first[0].includes("Рома"), "у каждого чата свой список", { lg, first });

    // Своё расписание
    await t.say(5, "/расписание", { chat: LEAGUE });
    await t.click(5, t.find(/Выберите дни/, LEAGUE), "Пт", { chat: LEAGUE });
    await t.click(5, t.find(/Выберите дни/, LEAGUE), "Готово", { chat: LEAGUE });
    await t.click(5, t.find(/Во сколько публиковать/, LEAGUE), "10:00", { chat: LEAGUE });
    const rows = t.query("SELECT chat_id, cron FROM chat_schedule");
    t.ok(rows.length === 1 && rows[0].chat_id === LEAGUE && rows[0].cron === "0 0 10 * * 5", "расписание «Лиги» сохранено отдельно, первого чата — не тронуто", rows);
    t.ok(/чат -2: запись по расписанию "0 0 10 \* \* 5"/.test(t.log), "задача публикации «Лиги» перезапущена");
    await t.say(6, "/статус", { chat: LEAGUE });
    await t.say(3, "/статус");
    const sLg = t.find(/Расписание/, LEAGUE);
    const sFirst = t.find(/Расписание/);
    t.ok(sLg && /10:00/.test(sLg.text) && sFirst && /09:00/.test(sFirst.text), "в /статус у каждого чата своё расписание", [sLg && sLg.text, sFirst && sFirst.text]);

    // Чужой чат бот не обслуживает
    await t.say(1, "/старт", { chat: -3 });
    t.ok(t.all(-3).length === 0 && /chat_id=-3 — его нет в CHAT_IDS/.test(t.log), "в чате не из CHAT_IDS бот молчит и пишет его chat_id в лог");

    // Личка: выбор чата
    await t.botStarted(4); // Влад — только в первом чате
    const m4 = t.all(dmOf(4)).pop();
    t.ok(m4 && /^Чат: Работяги/.test(m4.text) && !t.buttons(m4).some((b) => b.startsWith("🔁")), "кто в одном чате — видит его, без переключателя", m4 && [m4.text, t.buttons(m4)]);
    await t.botStarted(2); // Ruslan — в обоих
    let m2 = t.all(dmOf(2)).pop();
    t.ok(m2 && /^Чат: Работяги/.test(m2.text) && t.buttons(m2)[0] === "🔁 Чат: Работяги", "кто в двух чатах — видит текущий чат и переключатель", m2 && t.buttons(m2));
    await t.click(2, m2, "🔁 Чат", { dm: true });
    const choice = t.find(/Каким чатом управлять/, dmOf(2));
    t.ok(t.buttons(choice).join("|") === "✅ Работяги|Лига Джентельменов", "выбор из своих чатов", t.buttons(choice));
    await t.click(2, choice, "Лига", { dm: true });
    m2 = t.all(dmOf(2)).filter((m) => /^Чат: Лига Джентельменов\n/.test(m.text)).pop();
    t.ok(!!m2, "меню переключилось на «Лигу»", t.all(dmOf(2)).map((m) => m.text.slice(0, 40)));
    await t.click(2, m2, "➕ Записаться", { dm: true });
    t.ok(t.lines(t.find(/^Футбол в/, LEAGUE)).some((l) => l.includes("Ruslan")) && !t.lines(t.roster()).some((l) => l.includes("Ruslan")), "«Записаться» из лички — в выбранный чат");
    await t.say(2, "/статус", { dm: true });
    t.ok(/10:00/.test(t.all(dmOf(2)).pop().text), "/статус в личке — по выбранному чату");

    await t.botStarted(5); // админ «Лиги» — панель именно «Лиги»
    t.ok(!!t.find(/Панель администратора — Лига Джентельменов/, dmOf(5)), "админ «Лиги» в личке — панель своего чата");
    await t.botStarted(1);
    t.ok(!!t.find(/Панель администратора — Работяги/, dmOf(1)), "админ первого чата — панель первого чата");
  },
};
