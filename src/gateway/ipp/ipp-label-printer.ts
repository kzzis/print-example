import {
  DeliveryRejectedError,
  DeliveryUncertainError,
  PrinterNotReadyError,
  UnknownPrinterError,
} from "../../model/errors.ts";
import type { RenderedDocument } from "../../model/rendered-document.ts";
import type { LabelPrinter, RemoteJobState } from "../label-printer.ts";
import {
  IppHttpError,
  IppPrinter,
  IppStatusError,
  IppTransportError,
} from "./ipp-client.ts";

export interface IppPrinterConfig {
  uri: string;
  insecure?: boolean;
  timeoutMs?: number;
}

// 印刷を送ってはいけない printer-state-reasons(接尾辞 -error / -warning / -report は無視して比較)
const BLOCKING_REASONS = [
  "media-empty",
  "media-needed",
  "media-jam",
  "cover-open",
  "door-open",
  "offline",
  "shutdown",
];
const PRINTER_STATE_STOPPED = 5;

const asList = (v: unknown): string[] =>
  v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]).map(String);

const baseReason = (r: string): string => r.replace(/-(error|warning|report)$/, "");

/** domain の LabelPrinter ポートを、IPP クライアントで実装する */
export class IppLabelPrinter implements LabelPrinter {
  readonly #printers = new Map<string, IppPrinter>();

  constructor(configs: Record<string, IppPrinterConfig>) {
    for (const [name, c] of Object.entries(configs)) {
      this.#printers.set(
        name,
        new IppPrinter(c.uri, { insecure: c.insecure, timeoutMs: c.timeoutMs }),
      );
    }
  }

  isKnownPrinter(name: string): boolean {
    return this.#printers.has(name);
  }

  #get(name: string): IppPrinter {
    const p = this.#printers.get(name);
    if (!p) throw new UnknownPrinterError(`プリンター ${name} は登録されていません`);
    return p;
  }

  async checkReady(name: string): Promise<void> {
    const ipp = this.#get(name);
    let attrs;
    try {
      attrs = await ipp.getAttributes(["printer-state", "printer-state-reasons"]);
    } catch (e) {
      // 状態取得の失敗は「まだ何も送っていない」ので、未準備として扱ってよい
      throw new PrinterNotReadyError(name, [e instanceof Error ? e.message : String(e)]);
    }
    const reasons = asList(attrs["printer-state-reasons"]).filter((r) => r !== "none");
    const blocking = reasons.filter((r) => BLOCKING_REASONS.includes(baseReason(r)));
    if (attrs["printer-state"] === PRINTER_STATE_STOPPED && blocking.length === 0) {
      blocking.push("stopped");
    }
    if (blocking.length > 0) throw new PrinterNotReadyError(name, blocking);
  }

  async print(
    name: string,
    doc: RenderedDocument,
    meta: { jobName: string },
  ): Promise<{ externalJobId: string }> {
    const ipp = this.#get(name);
    try {
      const jobId = await ipp.printBuffer(Buffer.from(doc.data), {
        mime: doc.mime,
        jobName: meta.jobName,
      });
      return { externalJobId: String(jobId) };
    } catch (e) {
      throw classifyPrintError(e);
    }
  }

  async getJobState(name: string, externalJobId: string): Promise<RemoteJobState> {
    const job = await this.#get(name).getJob(Number(externalJobId));
    const state = job["job-state"];
    if (state === 9) return "completed";
    if (state === 7 || state === 8) return "failed";
    return "processing";
  }
}

/** IPP の例外を「確実に未受理」か「不明」かに分ける。迷ったら不明に倒す */
function classifyPrintError(e: unknown): Error {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof IppTransportError && !e.maybeDelivered) {
    return new DeliveryRejectedError(message, { cause: e });
  }
  if (e instanceof IppStatusError) {
    return new DeliveryRejectedError(message, { cause: e }); // プリンターがエラーを返した = ジョブは作られていない
  }
  if (e instanceof IppHttpError && e.httpStatus >= 400 && e.httpStatus < 500) {
    return new DeliveryRejectedError(message, { cause: e });
  }
  return new DeliveryUncertainError(message, { cause: e });
}
