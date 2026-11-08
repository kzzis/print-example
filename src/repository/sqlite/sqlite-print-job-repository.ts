import type { DatabaseSync } from "node:sqlite";
import type { PrintJobRepository } from "../print-job-repository.ts";
import type {
  JobEvent,
  JobStatus,
  LabelContent,
  LabelRecord,
  PrintJob,
} from "../../model/print-job.ts";
import { inTransaction } from "./database.ts";

interface JobRow {
  id: string;
  lot_no: string;
  label_count: number;
  printer: string;
  status: JobStatus;
  requested_by: string;
  requested_at: string;
  updated_at: string;
  idempotency_key: string;
  original_job_id: string | null;
  reprint_reason: string | null;
  external_job_id: string | null;
  status_reason: string | null;
  resolved_by: string | null;
}

const toJob = (r: JobRow): PrintJob => ({
  id: r.id,
  lotNo: r.lot_no,
  labelCount: r.label_count,
  printer: r.printer,
  status: r.status,
  requestedBy: r.requested_by,
  requestedAt: r.requested_at,
  updatedAt: r.updated_at,
  idempotencyKey: r.idempotency_key,
  originalJobId: r.original_job_id,
  reprintReason: r.reprint_reason,
  externalJobId: r.external_job_id,
  statusReason: r.status_reason,
  resolvedBy: r.resolved_by,
});

export class SqlitePrintJobRepository implements PrintJobRepository {
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  async insert(job: PrintJob, labels: readonly LabelRecord[]): Promise<void> {
    inTransaction(this.#db, () => {
      this.#db
        .prepare(
          `INSERT INTO print_job (id, lot_no, label_count, printer, status, requested_by, requested_at,
             updated_at, idempotency_key, original_job_id, reprint_reason, external_job_id, status_reason, resolved_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          job.id, job.lotNo, job.labelCount, job.printer, job.status, job.requestedBy, job.requestedAt,
          job.updatedAt, job.idempotencyKey, job.originalJobId, job.reprintReason, job.externalJobId,
          job.statusReason, job.resolvedBy,
        );
      const insertLabel = this.#db.prepare(
        "INSERT INTO label (id, job_id, serial, total, content_json) VALUES (?, ?, ?, ?, ?)",
      );
      for (const l of labels) {
        insertLabel.run(l.id, l.jobId, l.serial, l.total, JSON.stringify(l.content));
      }
      this.#recordEvent(job.id, job.updatedAt, null, job.status, job.statusReason);
    });
  }

  async update(job: PrintJob): Promise<void> {
    inTransaction(this.#db, () => {
      const before = this.#db.prepare("SELECT status FROM print_job WHERE id = ?").get(job.id) as
        | { status: JobStatus }
        | undefined;
      if (!before) throw new Error(`ジョブ ${job.id} が存在しません`);
      this.#db
        .prepare(
          `UPDATE print_job SET status = ?, updated_at = ?, external_job_id = ?, status_reason = ?, resolved_by = ?
           WHERE id = ?`,
        )
        .run(job.status, job.updatedAt, job.externalJobId, job.statusReason, job.resolvedBy, job.id);
      // 状態が変わったときだけ監査ログに残す
      if (before.status !== job.status) {
        this.#recordEvent(job.id, job.updatedAt, before.status, job.status, job.statusReason);
      }
    });
  }

  #recordEvent(jobId: string, at: string, from: JobStatus | null, to: JobStatus, reason: string | null) {
    this.#db
      .prepare("INSERT INTO job_event (job_id, at, from_status, to_status, reason) VALUES (?, ?, ?, ?, ?)")
      .run(jobId, at, from, to, reason);
  }

  async findById(id: string): Promise<PrintJob | undefined> {
    const row = this.#db.prepare("SELECT * FROM print_job WHERE id = ?").get(id) as JobRow | undefined;
    return row && toJob(row);
  }

  async findByIdempotencyKey(key: string): Promise<PrintJob | undefined> {
    const row = this.#db.prepare("SELECT * FROM print_job WHERE idempotency_key = ?").get(key) as
      | JobRow
      | undefined;
    return row && toJob(row);
  }

  async findByStatus(...statuses: JobStatus[]): Promise<PrintJob[]> {
    if (statuses.length === 0) return [];
    const marks = statuses.map(() => "?").join(", ");
    const rows = this.#db
      .prepare(`SELECT * FROM print_job WHERE status IN (${marks}) ORDER BY requested_at`)
      .all(...statuses) as unknown as JobRow[];
    return rows.map(toJob);
  }

  async labelsOf(jobId: string): Promise<LabelRecord[]> {
    const rows = this.#db
      .prepare("SELECT id, job_id, serial, total, content_json FROM label WHERE job_id = ? ORDER BY serial")
      .all(jobId) as unknown as {
      id: string;
      job_id: string;
      serial: number;
      total: number;
      content_json: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      jobId: r.job_id,
      serial: r.serial,
      total: r.total,
      content: JSON.parse(r.content_json) as LabelContent,
    }));
  }

  async eventsOf(jobId: string): Promise<JobEvent[]> {
    const rows = this.#db
      .prepare("SELECT job_id, at, from_status, to_status, reason FROM job_event WHERE job_id = ? ORDER BY seq")
      .all(jobId) as unknown as {
      job_id: string;
      at: string;
      from_status: JobStatus | null;
      to_status: JobStatus;
      reason: string | null;
    }[];
    return rows.map((r) => ({
      jobId: r.job_id,
      at: r.at,
      from: r.from_status,
      to: r.to_status,
      reason: r.reason,
    }));
  }
}
