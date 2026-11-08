import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { handleError } from "./controller/error-handler.ts";
import type { LotController } from "./controller/lot-controller.ts";
import type { PrintJobController } from "./controller/print-job-controller.ts";

export interface AppControllers {
  lots: LotController;
  printJobs: PrintJobController;
}

export interface AppOptions {
  /** 指定すると /health 以外すべてで `Authorization: Bearer <token>` を要求する */
  apiToken?: string;
}

export function createApp(controllers: AppControllers, options: AppOptions = {}): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ status: "ok" }));
  if (options.apiToken) app.use("*", bearerAuth({ token: options.apiToken }));

  app.route("/lots", controllers.lots.routes());
  app.route("/print-jobs", controllers.printJobs.routes());

  app.onError(handleError);
  app.notFound((c) => c.json({ error: { code: "not_found", message: "パスが見つかりません" } }, 404));
  return app;
}
