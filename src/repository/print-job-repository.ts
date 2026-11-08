import type {
  JobEvent,
  JobStatus,
  LabelRecord,
  PrintJob,
} from "../model/print-job.ts";

export interface PrintJobRepository {
  /** ジョブとラベルを同時に保存する。idempotencyKey が重複したら例外 */
  insert(job: PrintJob, labels: readonly LabelRecord[]): Promise<void>;
  /** 保存と同時に、状態が変わっていれば JobEvent(監査ログ)を記録する */
  update(job: PrintJob): Promise<void>;
  findById(id: string): Promise<PrintJob | undefined>;
  findByIdempotencyKey(key: string): Promise<PrintJob | undefined>;
  findByStatus(...statuses: JobStatus[]): Promise<PrintJob[]>;
  labelsOf(jobId: string): Promise<LabelRecord[]>;
  eventsOf(jobId: string): Promise<JobEvent[]>;
}
