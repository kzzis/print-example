import type { Context } from "hono";
import { InvalidRequestError } from "../model/errors.ts";
import { JOB_STATUSES, type JobStatus } from "../model/print-job.ts";

export type JsonObject = Record<string, unknown>;

export async function readJsonObject(c: Context): Promise<JsonObject> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new InvalidRequestError("リクエストボディが JSON ではありません");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InvalidRequestError("JSON オブジェクトを送ってください");
  }
  return body as JsonObject;
}

export function str(o: JsonObject, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || !v.trim()) throw new InvalidRequestError(`${key} は文字列で必須です`);
  return v;
}

export function optStr(o: JsonObject, key: string): string | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new InvalidRequestError(`${key} は文字列で指定してください`);
  return v;
}

/** キーは必須で、値は文字列または null */
export function strOrNull(o: JsonObject, key: string): string | null {
  const v = o[key];
  if (v === null) return null;
  if (typeof v !== "string") throw new InvalidRequestError(`${key} は文字列または null で必須です`);
  return v;
}

export function int(o: JsonObject, key: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new InvalidRequestError(`${key} は整数で必須です`);
  }
  return v;
}

export function oneOf<T extends string>(o: JsonObject, key: string, allowed: readonly T[]): T {
  const v = str(o, key);
  if (!(allowed as readonly string[]).includes(v)) {
    throw new InvalidRequestError(`${key} は ${allowed.join(" / ")} のいずれかです`);
  }
  return v as T;
}

/** 二重印刷を防ぐため、印刷を伴うリクエストでは必須 */
export function idempotencyKey(c: Context): string {
  const key = c.req.header("Idempotency-Key");
  if (!key || !key.trim()) {
    throw new InvalidRequestError("Idempotency-Key ヘッダーが必要です(依頼ごとに一意な値)");
  }
  return key.trim();
}

export function parseStatuses(query: string | undefined): JobStatus[] {
  const values = (query ?? "unknown").split(",").map((s) => s.trim()).filter(Boolean);
  for (const v of values) {
    if (!(JOB_STATUSES as readonly string[]).includes(v)) {
      throw new InvalidRequestError(`status は ${JOB_STATUSES.join(" / ")} のいずれかです`);
    }
  }
  return values as JobStatus[];
}
