import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  InvalidRequestError,
  InvalidTransitionError,
  JobNotFoundError,
  LotNotFoundError,
  PrinterNotReadyError,
  UnknownPrinterError,
} from "../model/errors.ts";

type ErrorStatus = 400 | 404 | 409 | 500 | 503;

function classify(err: unknown): { status: ErrorStatus; code: string } {
  if (err instanceof InvalidRequestError) return { status: 400, code: "invalid_request" };
  if (err instanceof UnknownPrinterError) return { status: 400, code: "unknown_printer" };
  if (err instanceof LotNotFoundError) return { status: 404, code: "lot_not_found" };
  if (err instanceof JobNotFoundError) return { status: 404, code: "job_not_found" };
  if (err instanceof InvalidTransitionError) return { status: 409, code: "invalid_state" };
  if (err instanceof PrinterNotReadyError) return { status: 503, code: "printer_not_ready" };
  return { status: 500, code: "internal_error" };
}

/** モデル/サービスの例外を HTTP レスポンスに変換する */
export function handleError(err: Error, c: Context) {
  // 認証ミドルウェア(401)など、Hono 自身が投げる例外はそのまま返す
  if (err instanceof HTTPException) return err.getResponse();

  const { status, code } = classify(err);
  if (status === 500) console.error(err);
  // printer_not_ready: ジョブは queued のまま残る。同じ Idempotency-Key で再送すれば送信をやり直せる
  if (status === 503) c.header("Retry-After", "30");
  return c.json(
    { error: { code, message: status === 500 ? "内部エラーが発生しました" : err.message } },
    status,
  );
}
