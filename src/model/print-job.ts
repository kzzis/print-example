import { barcodeValue } from "./barcode.ts";
import { InvalidTransitionError } from "./errors.ts";
import type { Lot } from "./lot.ts";

export const JOB_STATUSES = [
  "queued",
  "sending",
  "sent",
  "confirmed",
  "unknown",
  "failed",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * 許可する状態遷移。
 * - sending → unknown: 送信したが受理されたか不明(自動再送しない)
 * - unknown → confirmed/failed: 人が現物を確認して決める
 * - confirmed / failed は終端。やり直しは「再印刷」で新しいジョブを作る
 */
const ALLOWED: Record<JobStatus, readonly JobStatus[]> = {
  queued: ["sending"],
  sending: ["sent", "failed", "unknown"],
  sent: ["confirmed", "failed"],
  unknown: ["confirmed", "failed"],
  confirmed: [],
  failed: [],
};

export const canTransition = (from: JobStatus, to: JobStatus): boolean =>
  ALLOWED[from].includes(to);

/** 印刷した時点の内容(元データが後で変わっても残る) */
export interface LabelContent {
  lotNo: string;
  itemCode: string;
  itemName: string;
  manufacturedOn: string;
  expiresOn: string | null;
  quantity: number;
  /** 連番(1 始まり) */
  serial: number;
  total: number;
  barcode: string;
}

export interface LabelRecord {
  id: string;
  jobId: string;
  serial: number;
  total: number;
  content: LabelContent;
}

export interface PrintJob {
  id: string;
  lotNo: string;
  labelCount: number;
  printer: string;
  status: JobStatus;
  requestedBy: string;
  /** ISO 8601 */
  requestedAt: string;
  updatedAt: string;
  /** 同じ依頼の二重登録を防ぐキー(一意) */
  idempotencyKey: string;
  originalJobId: string | null;
  reprintReason: string | null;
  /** プリンター側のジョブID(IPP の job-id など) */
  externalJobId: string | null;
  statusReason: string | null;
  resolvedBy: string | null;
}

export interface JobEvent {
  jobId: string;
  at: string;
  from: JobStatus | null;
  to: JobStatus;
  reason: string | null;
}

export interface NewJobInput {
  id: string;
  lotNo: string;
  labelCount: number;
  printer: string;
  requestedBy: string;
  idempotencyKey: string;
  at: Date;
  originalJobId?: string;
  reprintReason?: string;
}

export function createJob(input: NewJobInput): PrintJob {
  const at = input.at.toISOString();
  return {
    id: input.id,
    lotNo: input.lotNo,
    labelCount: input.labelCount,
    printer: input.printer,
    status: "queued",
    requestedBy: input.requestedBy,
    requestedAt: at,
    updatedAt: at,
    idempotencyKey: input.idempotencyKey,
    originalJobId: input.originalJobId ?? null,
    reprintReason: input.reprintReason ?? null,
    externalJobId: null,
    statusReason: null,
    resolvedBy: null,
  };
}

export function snapshotLabels(lot: Lot, count: number): LabelContent[] {
  return Array.from({ length: count }, (_, i) => ({
    lotNo: lot.lotNo,
    itemCode: lot.itemCode,
    itemName: lot.itemName,
    manufacturedOn: lot.manufacturedOn,
    expiresOn: lot.expiresOn,
    quantity: lot.quantity,
    serial: i + 1,
    total: count,
    barcode: barcodeValue(lot, i + 1),
  }));
}

export function toLabelRecords(
  jobId: string,
  contents: readonly LabelContent[],
  newId: () => string,
): LabelRecord[] {
  return contents.map((content) => ({
    id: newId(),
    jobId,
    serial: content.serial,
    total: content.total,
    content,
  }));
}

export interface TransitionPatch {
  externalJobId?: string;
  statusReason?: string;
  resolvedBy?: string;
}

export function transition(
  job: PrintJob,
  to: JobStatus,
  at: Date,
  patch: TransitionPatch = {},
): PrintJob {
  if (!canTransition(job.status, to)) {
    throw new InvalidTransitionError(
      `ジョブ ${job.id}: ${job.status} → ${to} は許可されていません`,
    );
  }
  return {
    ...job,
    status: to,
    updatedAt: at.toISOString(),
    externalJobId: patch.externalJobId ?? job.externalJobId,
    statusReason: patch.statusReason ?? null,
    resolvedBy: patch.resolvedBy ?? job.resolvedBy,
  };
}

/** 状態を変えずに理由だけ記録する(例: 用紙切れで送れなかった) */
export function annotate(job: PrintJob, reason: string, at: Date): PrintJob {
  return { ...job, statusReason: reason, updatedAt: at.toISOString() };
}
