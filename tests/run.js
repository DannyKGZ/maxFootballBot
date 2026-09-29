// Сквозные тесты бота против подставного MAX API: `npm test`.
// Запуск одного сценария: `node tests/run.js vote`.
const fs = require("fs");
const path = require("path");
const { Harness } = require("./e2e/harness");

async function main() {
  const dir = path.join(__dirname, "e2e/scenarios");
  const only = process.argv[2];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js") && (!only || f.startsWith(only))).sort();
  let pass = 0;
  let fail = 0;
  for (const file of files) {
    const scenario = require(path.join(dir, file));
    console.log(`\n▶ ${scenario.name}`);
    const h = new Harness(scenario);
    try {
      await h.start();
      await scenario.run(h);
    } catch (err) {
      h.fail++;
      console.log(`  ✗ сценарий упал: ${err.stack || err}\n--- лог бота ---\n${h.log}`);
    } finally {
      await h.stop();
    }
    pass += h.pass;
    fail += h.fail;
  }
  console.log(`\nИтого: ${pass} прошло, ${fail} упало (сценариев: ${files.length})`);
  process.exit(fail ? 1 : 0);
}

main();
