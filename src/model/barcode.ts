import type { Lot } from "./lot.ts";

/**
 * ラベルに載せるバーコードの値。
 * 形式(GS1-128 / DataMatrix など)は未決のため、暫定でロット番号+連番とする。
 * 形式が決まったらここだけを差し替える。
 */
export function barcodeValue(lot: Lot, serial: number): string {
  return `${lot.lotNo}/${serial}`;
}
