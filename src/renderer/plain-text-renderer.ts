import type { RenderedDocument } from "../model/rendered-document.ts";
import type { LabelRenderer } from "./label-renderer.ts";
import type { LabelContent } from "../model/print-job.ts";

/**
 * 暫定のレンダラー(text/plain)。パイプライン全体を通すための仮実装で、
 * バーコードは描画しない。機種と形式(PDF か ZPL か)が決まったら、
 * LabelRenderer を実装した PdfLabelRenderer / ZplLabelRenderer に差し替える。
 */
export class PlainTextLabelRenderer implements LabelRenderer {
  render(labels: readonly LabelContent[]): RenderedDocument {
    const pages = labels.map((l) =>
      [
        `${l.itemName} (${l.itemCode})`,
        `LOT: ${l.lotNo}`,
        `製造日: ${l.manufacturedOn}`,
        `期限: ${l.expiresOn ?? "-"}`,
        `数量: ${l.quantity}`,
        `[${l.serial}/${l.total}] ${l.barcode}`,
      ].join("\n"),
    );
    return { mime: "text/plain", data: new TextEncoder().encode(pages.join("\f")) };
  }
}
