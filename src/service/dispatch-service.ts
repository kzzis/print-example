import {
  DeliveryRejectedError,
  JobNotFoundError,
  PrinterNotReadyError,
} from "../model/errors.ts";
import { annotate, transition, type PrintJob } from "../model/print-job.ts";
import type { LabelPrinter } from "../gateway/label-printer.ts";
import type { PrintJobRepository } from "../repository/print-job-repository.ts";
import type { LabelRenderer } from "../renderer/label-renderer.ts";
import type { Clock } from "../support/clock.ts";
import type { KeyedMutex } from "./keyed-mutex.ts";

export interface DispatchServiceDeps {
  jobs: PrintJobRepository;
  printer: LabelPrinter;
  renderer: LabelRenderer;
  clock: Clock;
  locks: KeyedMutex;
}

/** queued のジョブをプリンターへ送り、結果に応じて状態を進める */
export class DispatchService {
  readonly #d: DispatchServiceDeps;

  constructor(deps: DispatchServiceDeps) {
    this.#d = deps;
  }

  /**
   * ジョブを送信する。すでに queued でなければ(他のリクエストが送信済み)何もせず現在の状態を返す。
   * そのため同じ依頼を何度呼んでも、実際に送られるのは 1 回だけ。
   */
  async dispatch(jobId: string): Promise<PrintJob> {
    const found = await this.#d.jobs.findById(jobId);
    if (!found) throw new JobNotFoundError(`ジョブ ${jobId} が見つかりません`);
    // 1 台のプリンターには同時に 1 ジョブだけ送る
    return this.#d.locks.run(found.printer, () => this.#run(jobId));
  }

  async #run(jobId: string): Promise<PrintJob> {
    const { jobs, printer, renderer, clock } = this.#d;
    let job = await jobs.findById(jobId);
    if (!job) throw new JobNotFoundError(`ジョブ ${jobId} が見つかりません`);
    if (job.status !== "queued") return job;

    // 送る前の確認。失敗してもジョブは queued のまま(未送信なので再試行しても安全)
    try {
      await printer.checkReady(job.printer);
    } catch (e) {
      if (e instanceof PrinterNotReadyError) {
        await jobs.update(annotate(job, e.message, clock.now()));
      }
      throw e;
    }

    const labels = await jobs.labelsOf(job.id);
    const doc = renderer.render(labels.map((l) => l.content));

    // 通信の「前」に sending を保存する。
    // 保存後〜結果記録の間にプロセスが落ちても sending が残り、再起動時に unknown へ回せる
    job = transition(job, "sending", clock.now());
    await jobs.update(job);

    try {
      const { externalJobId } = await printer.print(job.printer, doc, {
        jobName: `lot-${job.lotNo}-${job.id}`,
      });
      job = transition(job, "sent", clock.now(), { externalJobId });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      job =
        e instanceof DeliveryRejectedError
          ? transition(job, "failed", clock.now(), { statusReason: message })
          : // 不明なエラーは「届いたかもしれない」側に倒す。自動再送はしない
            transition(job, "unknown", clock.now(), {
              statusReason: `送信結果が不明: ${message}`,
            });
    }
    await jobs.update(job);
    return job;
  }
}
