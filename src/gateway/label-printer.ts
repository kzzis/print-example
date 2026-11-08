import type { RenderedDocument } from "../model/rendered-document.ts";

export type RemoteJobState = "processing" | "completed" | "failed";

/** ラベルプリンター(外部システム)への入口 */
export interface LabelPrinter {
  isKnownPrinter(name: string): boolean;
  /** 送れる状態か確認する。送れないなら PrinterNotReadyError */
  checkReady(printer: string): Promise<void>;
  /**
   * 送信する。受理されなかったことが確実なら DeliveryRejectedError、
   * 受理されたか分からないなら DeliveryUncertainError を投げる。
   */
  print(
    printer: string,
    doc: RenderedDocument,
    meta: { jobName: string },
  ): Promise<{ externalJobId: string }>;
  getJobState(printer: string, externalJobId: string): Promise<RemoteJobState>;
}
