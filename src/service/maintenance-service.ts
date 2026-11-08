import { transition } from "../model/print-job.ts";
import type { LabelPrinter } from "../gateway/label-printer.ts";
import type { PrintJobRepository } from "../repository/print-job-repository.ts";
import type { Clock } from "../support/clock.ts";

export interface ConfirmResult {
  jobId: string;
  outcome: "confirmed" | "failed" | "pending" | "check-failed";
  detail?: string;
}

/** 定期実行・起動時の後始末 */
export class MaintenanceService {
  readonly #jobs: PrintJobRepository;
  readonly #printer: LabelPrinter;
  readonly #clock: Clock;

  constructor(deps: { jobs: PrintJobRepository; printer: LabelPrinter; clock: Clock }) {
    this.#jobs = deps.jobs;
    this.#printer = deps.printer;
    this.#clock = deps.clock;
  }

  /** sent のジョブについて、プリンターに完了を問い合わせて confirmed / failed に進める */
  async confirmCompletion(): Promise<ConfirmResult[]> {
    const results: ConfirmResult[] = [];
    for (const job of await this.#jobs.findByStatus("sent")) {
      if (!job.externalJobId) continue;
      try {
        const state = await this.#printer.getJobState(job.printer, job.externalJobId);
        if (state === "processing") {
          results.push({ jobId: job.id, outcome: "pending" });
          continue;
        }
        const done = state === "completed";
        const next = transition(job, done ? "confirmed" : "failed", this.#clock.now(), {
          statusReason: done ? "プリンターが完了を報告" : "プリンターが中止/失敗を報告",
        });
        await this.#jobs.update(next);
        results.push({ jobId: job.id, outcome: done ? "confirmed" : "failed" });
      } catch (e) {
        // 問い合わせに失敗しても状態は変えない(sent のまま。次回また確認する)
        results.push({
          jobId: job.id,
          outcome: "check-failed",
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return results;
  }

  /**
   * 起動時に 1 回呼ぶ。sending のまま残っているジョブは、送信中にプロセスが落ちたもの。
   * 印刷されたか分からないので unknown にして人の確認に回す(自動再送はしない)。
   */
  async recoverInterrupted(): Promise<string[]> {
    const recovered: string[] = [];
    for (const job of await this.#jobs.findByStatus("sending")) {
      await this.#jobs.update(
        transition(job, "unknown", this.#clock.now(), {
          statusReason: "送信中にプロセスが停止した可能性があります(印刷されたか不明)",
        }),
      );
      recovered.push(job.id);
    }
    return recovered;
  }
}
