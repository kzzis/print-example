import { readFileSync } from "node:fs";
import type { IppPrinterConfig } from "./gateway/ipp/ipp-label-printer.ts";

export interface AppConfig {
  /** SQLite のファイルパス */
  dbPath: string;
  /** プリンター名 → 接続先 */
  printers: Record<string, IppPrinterConfig>;
}

export function loadConfig(path: string): AppConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AppConfig>;
  if (typeof raw.dbPath !== "string" || !raw.dbPath) {
    throw new Error(`${path}: dbPath が必要です`);
  }
  if (!raw.printers || Object.keys(raw.printers).length === 0) {
    throw new Error(`${path}: printers が必要です`);
  }
  for (const [name, p] of Object.entries(raw.printers)) {
    if (typeof p?.uri !== "string" || !/^ipps?:\/\//.test(p.uri)) {
      throw new Error(`${path}: printers.${name}.uri は ipp:// か ipps:// で始めてください`);
    }
  }
  return { dbPath: raw.dbPath, printers: raw.printers };
}
