import type { LabelContent } from "../model/print-job.ts";
import type { RenderedDocument } from "../model/rendered-document.ts";

export interface LabelRenderer {
  render(labels: readonly LabelContent[]): RenderedDocument;
}
