import {
  InvalidRequestError,
  InvalidTransitionError,
  JobNotFoundError,
  LotNotFoundError,
  UnknownPrinterError,
} from "../model/errors.ts";
import {
  createJob,
  snapshotLabels,
  toLabelRecords,
  transition,
  type JobEvent,
  type JobStatus,
  type LabelContent,
  type LabelRecord,
  type PrintJob,
} from "../model/print-job.ts";
import type { LabelPrinter } from "../gateway/label-printer.ts";
import type { LotRepository } from "../repository/lot-repository.ts";
import type { PrintJobRepository } from "../repository/print-job-repository.ts";
import type { Clock, IdGenerator } from "../support/clock.ts";
import type { DispatchService } from "./dispatch-service.ts";

export const MAX_LABELS_PER_JOB = 500;

export interface PrintCommand {
  lotNo: string;
  labelCount: number;
  printer: string;
  requestedBy: string;
  /** 同じ依頼を 2 回送っても 1 回しか印刷しないためのキー。呼び出し側が依頼ごとに決める */
  idempotencyKey: string;
}

export interface ReprintCommand {
  originalJobId: string;
  reason: string;
  requestedBy: string;
  idempotencyKey: string;
}

export interface ResolveCommand {
  jobId: string;
  /** 人が現物を確認した結果 */
  decision: "printed" | "not-printed";
  resolvedBy: string;
  note?: string;
}

export interface PrintJobDetail {
  job: PrintJob;
  labels: LabelContent[];
  events: JobEvent[];
}

export interface PrintJobServiceDeps {
  lots: LotRepository;
  jobs: PrintJobRepository;
  printer: LabelPrinter;
  dispatch: DispatchService;
  clock: Clock;
  ids: IdGenerator;
}

export class PrintJobService {
  readonly #d: PrintJobServiceDeps;

  constructor(deps: PrintJobServiceDeps) {
    this.#d = deps;
  }

  /** ロットのラベルを N 枚印刷する。依頼を台帳に記録してから送信する */
  async print(cmd: PrintCommand): Promise<PrintJob> {
    const { lots, jobs, printer, clock, ids } = this.#d;

    // 同じキーの依頼がすでにあれば、新しく作らず、その結果を返す
    const existing = await jobs.findByIdempotencyKey(cmd.idempotencyKey);
    if (existing) return this.#resume(existing);

    requireText(cmd.idempotencyKey, "idempotencyKey");
    requireText(cmd.requestedBy, "依頼者");
    if (
      !Number.isInteger(cmd.labelCount) ||
      cmd.labelCount < 1 ||
      cmd.labelCount > MAX_LABELS_PER_JOB
    ) {
      throw new InvalidRequestError(`枚数は 1〜${MAX_LABELS_PER_JOB} の整数で指定してください`);
    }
    if (!printer.isKnownPrinter(cmd.printer)) {
      throw new UnknownPrinterError(`プリンター ${cmd.printer} は登録されていません`);
    }
    const lot = await lots.findByLotNo(cmd.lotNo);
    if (!lot) throw new LotNotFoundError(`ロット ${cmd.lotNo} が見つかりません`);

    const job = createJob({
      id: ids.next(),
      lotNo: lot.lotNo,
      labelCount: cmd.labelCount,
      printer: cmd.printer,
      requestedBy: cmd.requestedBy,
      idempotencyKey: cmd.idempotencyKey,
      at: clock.now(),
    });
    const labels = toLabelRecords(job.id, snapshotLabels(lot, cmd.labelCount), () => ids.next());
    return this.#register(job, labels);
  }

  /**
   * 再印刷。元のジョブと理由を紐づけた「新しいジョブ」を作る。
   * 元ジョブが終端(confirmed / failed)のときだけ許可する。
   * unknown は先に人が結論を出す必要がある(二重印刷を避けるため)。
   */
  async reprint(cmd: ReprintCommand): Promise<PrintJob> {
    const { jobs, clock, ids } = this.#d;

    const existing = await jobs.findByIdempotencyKey(cmd.idempotencyKey);
    if (existing) return this.#resume(existing);

    requireText(cmd.idempotencyKey, "idempotencyKey");
    requireText(cmd.reason, "再印刷の理由");
    requireText(cmd.requestedBy, "依頼者");

    const original = await jobs.findById(cmd.originalJobId);
    if (!original) throw new JobNotFoundError(`ジョブ ${cmd.originalJobId} が見つかりません`);
    if (original.status !== "confirmed" && original.status !== "failed") {
      throw new InvalidTransitionError(
        `ジョブ ${original.id} は ${original.status} のため再印刷できません` +
          "(unknown は先に結果を確定してください)",
      );
    }

    const job = createJob({
      id: ids.next(),
      lotNo: original.lotNo,
      labelCount: original.labelCount,
      printer: original.printer,
      requestedBy: cmd.requestedBy,
      idempotencyKey: cmd.idempotencyKey,
      at: clock.now(),
      originalJobId: original.id,
      reprintReason: cmd.reason,
    });
    // ラベルの内容は元ジョブの記録をそのまま引き継ぐ(ロットの現在値ではなく、当時の内容)
    const originalLabels = await jobs.labelsOf(original.id);
    const labels = toLabelRecords(
      job.id,
      originalLabels.map((l) => l.content),
      () => ids.next(),
    );
    return this.#register(job, labels);
  }

  /** unknown のジョブについて、人が現物を見て結論を出す */
  async resolveUnknown(cmd: ResolveCommand): Promise<PrintJob> {
    const { jobs, clock } = this.#d;
    requireText(cmd.resolvedBy, "確認者");
    const job = await jobs.findById(cmd.jobId);
    if (!job) throw new JobNotFoundError(`ジョブ ${cmd.jobId} が見つかりません`);
    if (job.status !== "unknown") {
      throw new InvalidTransitionError(`ジョブ ${job.id} は unknown ではありません(${job.status})`);
    }
    const printed = cmd.decision === "printed";
    const reason = `${printed ? "現物を確認: 印刷済み" : "現物を確認: 未印刷"}${cmd.note ? ` / ${cmd.note}` : ""}`;
    const next = transition(job, printed ? "confirmed" : "failed", clock.now(), {
      statusReason: reason,
      resolvedBy: cmd.resolvedBy,
    });
    await jobs.update(next);
    return next;
  }

  async get(id: string): Promise<PrintJobDetail> {
    const { jobs } = this.#d;
    const job = await jobs.findById(id);
    if (!job) throw new JobNotFoundError(`ジョブ ${id} が見つかりません`);
    const [labels, events] = await Promise.all([jobs.labelsOf(id), jobs.eventsOf(id)]);
    return { job, labels: labels.map((l) => l.content), events };
  }

  list(statuses: JobStatus[]): Promise<PrintJob[]> {
    return this.#d.jobs.findByStatus(...statuses);
  }

  // queued のままなら未送信なので、同じキーでの再依頼は「送信のやり直し」として扱ってよい
  #resume(existing: PrintJob): Promise<PrintJob> | PrintJob {
    return existing.status === "queued" ? this.#d.dispatch.dispatch(existing.id) : existing;
  }

  async #register(job: PrintJob, labels: readonly LabelRecord[]): Promise<PrintJob> {
    try {
      await this.#d.jobs.insert(job, labels);
    } catch (e) {
      // 同じキーの同時リクエストが先に登録された場合は、そちらを返す
      const raced = await this.#d.jobs.findByIdempotencyKey(job.idempotencyKey);
      if (raced) return this.#resume(raced);
      throw e;
    }
    return this.#d.dispatch.dispatch(job.id);
  }
}

function requireText(value: string, name: string): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new InvalidRequestError(`${name} が空です`);
  }
}
