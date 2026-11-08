import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createContainer } from "./container.ts";
import { IppLabelPrinter } from "./gateway/ipp/ipp-label-printer.ts";
import { PlainTextLabelRenderer } from "./renderer/plain-text-renderer.ts";
import { openDatabase } from "./repository/sqlite/database.ts";
import { SqliteLotRepository } from "./repository/sqlite/sqlite-lot-repository.ts";
import { SqlitePrintJobRepository } from "./repository/sqlite/sqlite-print-job-repository.ts";
import { systemClock, uuidGenerator } from "./support/clock.ts";

const config = loadConfig(process.env.LABEL_CONFIG ?? "labels.config.json");
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
const apiToken = process.env.API_TOKEN || undefined;

// 印刷を実行できる API なので、外部に公開するなら認証を必須にする
if (!["127.0.0.1", "localhost", "::1"].includes(host) && !apiToken) {
  throw new Error(`HOST=${host} で公開するには API_TOKEN の設定が必要です`);
}

mkdirSync(dirname(config.dbPath), { recursive: true });
const db = openDatabase(config.dbPath);

const { controllers, maintenance } = createContainer({
  lots: new SqliteLotRepository(db),
  jobs: new SqlitePrintJobRepository(db),
  printer: new IppLabelPrinter(config.printers),
  renderer: new PlainTextLabelRenderer(),
  clock: systemClock,
  ids: uuidGenerator,
});

// 起動時: 送信中に止まったジョブを unknown に回す(自動再送はしない)
const recovered = await maintenance.recoverInterrupted();
if (recovered.length > 0) {
  console.warn(`送信中だった ${recovered.length} 件を unknown にしました: ${recovered.join(", ")}`);
}

const server = serve({ fetch: createApp(controllers, { apiToken }).fetch, hostname: host, port });
console.log(`listening on http://${host}:${port}`);

// 定期: sent のジョブの完了確認
const timer = setInterval(() => {
  maintenance.confirmCompletion().catch((e: unknown) => console.error("confirmCompletion failed", e));
}, Number(process.env.CONFIRM_INTERVAL_MS ?? 30_000));

function shutdown() {
  clearInterval(timer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
