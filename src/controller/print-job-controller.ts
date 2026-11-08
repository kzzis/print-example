import { Hono } from "hono";
import type { MaintenanceService } from "../service/maintenance-service.ts";
import type { PrintJobService } from "../service/print-job-service.ts";
import {
  idempotencyKey,
  int,
  oneOf,
  optStr,
  parseStatuses,
  readJsonObject,
  str,
} from "./validation.ts";

export class PrintJobController {
  readonly #jobs: PrintJobService;
  readonly #maintenance: MaintenanceService;

  constructor(jobs: PrintJobService, maintenance: MaintenanceService) {
    this.#jobs = jobs;
    this.#maintenance = maintenance;
  }

  routes(): Hono {
    const r = new Hono();

    // 印刷依頼。Idempotency-Key が同じ依頼は、何度送っても 1 回しか印刷しない
    r.post("/", async (c) => {
      const b = await readJsonObject(c);
      const job = await this.#jobs.print({
        lotNo: str(b, "lotNo"),
        labelCount: int(b, "labelCount"),
        printer: str(b, "printer"),
        requestedBy: str(b, "requestedBy"),
        idempotencyKey: idempotencyKey(c),
      });
      return c.json(job);
    });

    // ?status=unknown,sent のように絞り込み(既定は unknown)
    r.get("/", async (c) => c.json(await this.#jobs.list(parseStatuses(c.req.query("status")))));

    // sent のジョブをプリンターへ問い合わせて完了確認する
    r.post("/confirm", async (c) => c.json(await this.#maintenance.confirmCompletion()));

    r.get("/:id", async (c) => c.json(await this.#jobs.get(c.req.param("id"))));

    // unknown のジョブを、人が現物を見て確定する
    r.post("/:id/resolve", async (c) => {
      const b = await readJsonObject(c);
      const job = await this.#jobs.resolveUnknown({
        jobId: c.req.param("id"),
        decision: oneOf(b, "decision", ["printed", "not-printed"] as const),
        resolvedBy: str(b, "resolvedBy"),
        note: optStr(b, "note"),
      });
      return c.json(job);
    });

    // 再印刷(理由必須)。元ジョブは confirmed / failed のみ
    r.post("/:id/reprint", async (c) => {
      const b = await readJsonObject(c);
      const job = await this.#jobs.reprint({
        originalJobId: c.req.param("id"),
        reason: str(b, "reason"),
        requestedBy: str(b, "requestedBy"),
        idempotencyKey: idempotencyKey(c),
      });
      return c.json(job);
    });

    return r;
  }
}
