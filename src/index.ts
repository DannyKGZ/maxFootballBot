import { startSticky } from "./stickyLogic";
import fs from "fs";
import http from "http";
import https from "https";
import { config } from "./config";
import { createWebhookApp, handleUpdate } from "./webhookServer";
import { startScheduler, stopScheduler } from "./scheduler";
import { isPollingReady, startPolling, stopPolling } from "./poller";
import { refreshRosterOnStartup } from "./sessionLogic";
import { publishVoteResults, refreshVoteMessage } from "./voteLogic";
import { loadSessionsFromDisk, flushSessionsToDiskSync, syncMatchHistory } from "./store";
import { pruneMatchHistory } from "./matchHistory";
import { pruneIncomingUpdates, startUpdateWorker, stopUpdateWorker } from "./updateQueue";
import { deleteSubscription, getSubscriptions, registerWebhook, setBotCommands } from "./maxApi";
import { USER_MENU_COMMANDS } from "./actions";
import { initChatSettings } from "./settingsStore";

async function main(): Promise<void> {
  if (config.updatesMode === "webhook" && (!/^[A-Za-z0-9_-]{5,256}$/.test(config.webhookSecret) || config.webhookSecret === "change_me_please")) {
    throw new Error("В режиме webhook задайте собственный WEBHOOK_SECRET длиной 5–256 символов");
  }
  loadSessionsFromDisk();
  initChatSettings(config.chatIds); // настройки чатов в базе: прежние чаты — как были, новые — по умолчанию
  syncMatchHistory();
  pruneMatchHistory();
  pruneIncomingUpdates();

  let started = false;
  let stopping = false;
  let webhookCheckedAt = 0;
  let webhookCheck: NodeJS.Timeout | undefined;
  const app = createWebhookApp(() => started && !stopping && (config.updatesMode === "polling"
    ? isPollingReady()
    : webhookCheckedAt > 0 && Date.now() - webhookCheckedAt < 90_000));

  // Если заданы TLS_CERT_PATH/TLS_KEY_PATH — поднимаем HTTPS напрямую.
  // Иначе — обычный HTTP-сервер (для случая, когда TLS терминируется на
  // reverse-proxy вроде nginx/Caddy/Traefik перед этим процессом).
  //
  // Начиная с 25 мая 2026 MAX принимает вебхуки только по HTTPS (порт 443) с
  // сертификатом от доверенного центра или Минцифры — самоподписанные
  // сертификаты и голый HTTP на стороне MAX больше не поддерживаются.
  let server: http.Server | https.Server;
  if (config.updatesMode === "webhook" && config.tlsCertPath && config.tlsKeyPath) {
    server = https.createServer(
      {
        cert: fs.readFileSync(config.tlsCertPath),
        key: fs.readFileSync(config.tlsKeyPath),
      },
      app,
    );
    console.log("[server] запущен в режиме HTTPS");
  } else {
    server = http.createServer(app);
    console.log(
      "[server] запущен в режиме HTTP — предполагается TLS-терминация на reverse-proxy",
    );
  }

  // В режиме polling снаружи к боту никто не ходит — слушаем только localhost (для /health).
  const host = config.updatesMode === "polling" ? "127.0.0.1" : undefined;
  server.listen(config.port, host, () => {
    console.log(`[server] слушаю ${host ?? "все адреса"}:${config.port}, путь вебхука: /webhook`);
  });

  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[server] получен ${signal}, завершаю обработку события`);
    stopPolling();
    stopScheduler();
    clearTimeout(webhookCheck);
    server.close();
    setTimeout(() => process.exit(0), 15_000).unref();
    void stopUpdateWorker().finally(() => {
      flushSessionsToDiskSync();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  if (config.updatesMode === "webhook" && config.autoRegisterWebhook) {
    if (!config.publicWebhookUrl) {
      console.warn("[webhook] AUTO_REGISTER_WEBHOOK=true, но PUBLIC_WEBHOOK_URL не задан");
    } else {
      try {
        const res = await registerWebhook(
          config.publicWebhookUrl,
          ["message_created", "message_callback", "bot_started"],
          config.webhookSecret || undefined,
        );
        console.log("[webhook] регистрация подписки:", res);

        // У quick tunnel новый адрес при каждом запуске — старые подписки указывают
        // в пустоту и могут мешать доставке. Оставляем только текущий адрес.
        const { subscriptions } = await getSubscriptions();
        for (const sub of subscriptions) {
          if (sub.url === config.publicWebhookUrl) continue;
          await deleteSubscription(sub.url);
          console.log(`[webhook] удалена старая подписка: ${sub.url}`);
        }
      } catch (err) {
        console.error("[webhook] не удалось зарегистрировать вебхук:", err);
      }
    }
  }

  // Меню «/» в MAX общее для всех — показываем в нём только команды участников.
  setBotCommands(USER_MENU_COMMANDS)
    .then(() => console.log("[bot] меню команд обновлено"))
    .catch((err) => console.warn("[bot] не удалось обновить меню команд:", err instanceof Error ? err.message : err));

  startScheduler();
  startSticky();
  console.log(`[bot] чаты: ${config.chatIds.join(", ") || "не заданы (CHAT_IDS)"}`);
  for (const chatId of config.chatIds) {
    void refreshRosterOnStartup(chatId);
    void refreshVoteMessage(chatId); // текст и кнопки голосования — по текущей версии бота
    void publishVoteResults(chatId);
  }
  startUpdateWorker(handleUpdate);
  started = true;
  if (config.updatesMode === "polling") {
    void startPolling().catch((err) => console.error("[poller] не удалось запустить приём:", err));
  } else {
    const check = async () => {
      try {
        const { subscriptions } = await getSubscriptions();
        const registered = config.publicWebhookUrl
          ? subscriptions.some((sub) => sub.url === config.publicWebhookUrl)
          : subscriptions.length > 0;
        webhookCheckedAt = registered ? Date.now() : 0;
      } catch (err) {
        console.warn("[webhook] не удалось проверить подписку:", err);
      } finally {
        if (!stopping) webhookCheck = setTimeout(() => void check(), 30_000);
      }
    };
    void check();
  }
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
