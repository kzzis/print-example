import type { LabelPrinter, RemoteJobState } from "../gateway/label-printer.ts";
import {
  DeliveryRejectedError,
  DeliveryUncertainError,
  PrinterNotReadyError,
} from "../model/errors.ts";
import type { Lot } from "../model/lot.ts";
import type {
  JobEvent,
  JobStatus,
  LabelRecord,
  PrintJob,
} from "../model/print-job.ts";
import type { RenderedDocument } from "../model/rendered-document.ts";
import { createContainer } from "../container.ts";
import { PlainTextLabelRenderer } from "../renderer/plain-text-renderer.ts";
import type { LotRepository } from "../repository/lot-repository.ts";
import type { PrintJobRepository } from "../repository/print-job-repository.ts";
import type { Clock, IdGenerator } from "../support/clock.ts";

export class InMemoryLotRepository implements LotRepository {
  readonly #lots = new Map<string, Lot>();
  async findByLotNo(lotNo: string) {
    return this.#lots.get(lotNo);
  }
  async save(lot: Lot) {
    this.#lots.set(lot.lotNo, { ...lot });
  }
}

export class InMemoryPrintJobRepository implements PrintJobRepository {
  readonly #jobs = new Map<string, PrintJob>();
  readonly #labels = new Map<string, LabelRecord[]>();
  readonly #events = new Map<string, JobEvent[]>();

  async insert(job: PrintJob, labels: readonly LabelRecord[]) {
    for (const j of this.#jobs.values()) {
      if (j.idempotencyKey === job.idempotencyKey) throw new Error("UNIQUE constraint failed: idempotency_key");
    }
    this.#jobs.set(job.id, { ...job });
    this.#labels.set(job.id, [...labels]);
    this.#events.set(job.id, [
      { jobId: job.id, at: job.updatedAt, from: null, to: job.status, reason: job.statusReason },
    ]);
  }
  async update(job: PrintJob) {
    const before = this.#jobs.get(job.id);
    if (!before) throw new Error("not found");
    this.#jobs.set(job.id, { ...job });
    if (before.status !== job.status) {
      this.#events.get(job.id)!.push({
        jobId: job.id, at: job.updatedAt, from: before.status, to: job.status, reason: job.statusReason,
      });
    }
  }
  async findById(id: string) {
    const j = this.#jobs.get(id);
    return j && { ...j };
  }
  async findByIdempotencyKey(key: string) {
    for (const j of this.#jobs.values()) if (j.idempotencyKey === key) return { ...j };
    return undefined;
  }
  async findByStatus(...statuses: JobStatus[]) {
    return [...this.#jobs.values()].filter((j) => statuses.includes(j.status)).map((j) => ({ ...j }));
  }
  async labelsOf(jobId: string) {
    return [...(this.#labels.get(jobId) ?? [])];
  }
  async eventsOf(jobId: string) {
    return [...(this.#events.get(jobId) ?? [])];
  }
}

/** 振る舞いをテストから切り替えられる偽プリンター */
export class FakeLabelPrinter implements LabelPrinter {
  readonly printCalls: { printer: string; doc: RenderedDocument; jobName: string }[] = [];
  /** 空でなければ checkReady が PrinterNotReadyError を投げる */
  notReadyReasons: string[] = [];
  printOutcome: "ok" | "reject" | "uncertain" = "ok";
  printDelayMs = 0;
  remoteState: RemoteJobState = "completed";
  maxConcurrent = 0;
  #active = 0;
  #seq = 100;

  isKnownPrinter(name: string) {
    return name === "front-desk" || name === "warehouse";
  }
  async checkReady(printer: string) {
    if (this.notReadyReasons.length > 0) throw new PrinterNotReadyError(printer, this.notReadyReasons);
  }
  async print(printer: string, doc: RenderedDocument, meta: { jobName: string }) {
    this.#active++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.#active);
    try {
      if (this.printDelayMs) await new Promise((r) => setTimeout(r, this.printDelayMs));
      this.printCalls.push({ printer, doc, jobName: meta.jobName });
      if (this.printOutcome === "reject") throw new DeliveryRejectedError("プリンターが拒否");
      if (this.printOutcome === "uncertain") throw new DeliveryUncertainError("timeout");
      return { externalJobId: String(this.#seq++) };
    } finally {
      this.#active--;
    }
  }
  async getJobState() {
    return this.remoteState;
  }
}

export class SequentialIds implements IdGenerator {
  #n = 0;
  next() {
    return `id-${++this.#n}`;
  }
}

/** 呼ぶたびに 1 秒進む時計 */
export class TickingClock implements Clock {
  #t = Date.parse("2026-11-07T09:00:00.000Z");
  now() {
    const d = new Date(this.#t);
    this.#t += 1000;
    return d;
  }
}

export const SAMPLE_LOT: Lot = {
  lotNo: "L240601",
  itemCode: "A-100",
  itemName: "テスト品",
  manufacturedOn: "2026-06-01",
  expiresOn: "2027-06-01",
  quantity: 120,
};

/** 偽の部品で全体を組み立てる(サービス・HTTP のテスト用) */
export async function createTestContainer() {
  const lots = new InMemoryLotRepository();
  const jobs = new InMemoryPrintJobRepository();
  const printer = new FakeLabelPrinter();
  await lots.save(SAMPLE_LOT);
  const container = createContainer({
    lots, jobs, printer,
    renderer: new PlainTextLabelRenderer(),
    clock: new TickingClock(),
    ids: new SequentialIds(),
  });
  return { ...container, lots, jobs, printer };
}
