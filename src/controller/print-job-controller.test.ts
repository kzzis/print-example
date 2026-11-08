import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Hono } from "hono";
import { createApp } from "../app.ts";
import { SAMPLE_LOT, createTestContainer } from "../testing/fakes.ts";

async function setup(apiToken?: string) {
  const t = await createTestContainer();
  const app: Hono = createApp(t.controllers, { apiToken });
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { t, app, call };
}

const printBody = { lotNo: SAMPLE_LOT.lotNo, labelCount: 2, printer: "front-desk", requestedBy: "tanaka" };

describe("POST /print-jobs", () => {
  it("印刷依頼を受け付け、ジョブを返す", async () => {
    const { call } = await setup();
    const res = await call("POST", "/print-jobs", printBody, { "Idempotency-Key": "h1" });
    assert.equal(res.status, 200);
    const job = (await res.json()) as { status: string; labelCount: number };
    assert.equal(job.status, "sent");
    assert.equal(job.labelCount, 2);
  });

  it("Idempotency-Key がないと 400", async () => {
    const { call } = await setup();
    const res = await call("POST", "/print-jobs", printBody);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "invalid_request");
  });

  it("同じ Idempotency-Key の再送では印刷が増えない", async () => {
    const { t, call } = await setup();
    await call("POST", "/print-jobs", printBody, { "Idempotency-Key": "h2" });
    await call("POST", "/print-jobs", printBody, { "Idempotency-Key": "h2" });
    assert.equal(t.printer.printCalls.length, 1);
  });

  it("存在しないロットは 404、壊れた JSON は 400", async () => {
    const { call, app } = await setup();
    const notFound = await call("POST", "/print-jobs", { ...printBody, lotNo: "NOPE" }, { "Idempotency-Key": "h3" });
    assert.equal(notFound.status, 404);
    const broken = await app.request("/print-jobs", {
      method: "POST",
      headers: { "Idempotency-Key": "h4", "Content-Type": "application/json" },
      body: "{oops",
    });
    assert.equal(broken.status, 400);
  });

  it("プリンターが未準備なら 503(Retry-After 付き)。直したら同じキーで送り直せる", async () => {
    const { t, call } = await setup();
    t.printer.notReadyReasons = ["media-empty"];
    const res = await call("POST", "/print-jobs", printBody, { "Idempotency-Key": "h5" });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("Retry-After"), "30");

    t.printer.notReadyReasons = [];
    const retry = await call("POST", "/print-jobs", printBody, { "Idempotency-Key": "h5" });
    assert.equal(retry.status, 200);
    assert.equal(t.printer.printCalls.length, 1);
  });
});

describe("unknown の確定と再印刷", () => {
  it("unknown 一覧 → resolve → 再印刷の流れ", async () => {
    const { t, call } = await setup();
    t.printer.printOutcome = "uncertain";
    const created = (await (await call("POST", "/print-jobs", printBody, { "Idempotency-Key": "u1" })).json()) as { id: string; status: string };
    assert.equal(created.status, "unknown");

    const list = (await (await call("GET", "/print-jobs?status=unknown")).json()) as { id: string }[];
    assert.deepEqual(list.map((j) => j.id), [created.id]);

    const early = await call("POST", `/print-jobs/${created.id}/reprint`, { reason: "r", requestedBy: "t" }, { "Idempotency-Key": "u2" });
    assert.equal(early.status, 409);

    const resolved = await call("POST", `/print-jobs/${created.id}/resolve`, { decision: "not-printed", resolvedBy: "sato", note: "現物なし" });
    assert.equal(resolved.status, 200);
    assert.equal(((await resolved.json()) as { status: string }).status, "failed");

    t.printer.printOutcome = "ok";
    const re = await call("POST", `/print-jobs/${created.id}/reprint`, { reason: "未印刷だった", requestedBy: "t" }, { "Idempotency-Key": "u3" });
    assert.equal(re.status, 200);
    assert.equal(((await re.json()) as { originalJobId: string }).originalJobId, created.id);
  });

  it("resolve の decision が不正なら 400、unknown でないジョブは 409", async () => {
    const { call } = await setup();
    const job = (await (await call("POST", "/print-jobs", printBody, { "Idempotency-Key": "u4" })).json()) as { id: string };
    const bad = await call("POST", `/print-jobs/${job.id}/resolve`, { decision: "maybe", resolvedBy: "s" });
    assert.equal(bad.status, 400);
    const conflict = await call("POST", `/print-jobs/${job.id}/resolve`, { decision: "printed", resolvedBy: "s" });
    assert.equal(conflict.status, 409);
  });

  it("GET /print-jobs/:id は状態の履歴とラベル内容を返す", async () => {
    const { call } = await setup();
    const job = (await (await call("POST", "/print-jobs", printBody, { "Idempotency-Key": "g1" })).json()) as { id: string };
    const detail = (await (await call("GET", `/print-jobs/${job.id}`)).json()) as {
      labels: unknown[]; events: { to: string }[];
    };
    assert.equal(detail.labels.length, 2);
    assert.deepEqual(detail.events.map((e) => e.to), ["queued", "sending", "sent"]);
    assert.equal((await call("GET", "/print-jobs/none")).status, 404);
  });
});

describe("POST /print-jobs/confirm と /lots", () => {
  it("confirm で sent が confirmed になる", async () => {
    const { call } = await setup();
    const job = (await (await call("POST", "/print-jobs", printBody, { "Idempotency-Key": "c1" })).json()) as { id: string };
    const results = (await (await call("POST", "/print-jobs/confirm")).json()) as { jobId: string; outcome: string }[];
    assert.deepEqual(results, [{ jobId: job.id, outcome: "confirmed" }]);
  });

  it("ロットの登録・取得と入力検証", async () => {
    const { call } = await setup();
    const body = { itemCode: "B-1", itemName: "新製品", manufacturedOn: "2026-07-01", expiresOn: null, quantity: 10 };
    assert.equal((await call("PUT", "/lots/L777", body)).status, 200);
    const got = (await (await call("GET", "/lots/L777")).json()) as { itemName: string; expiresOn: null };
    assert.equal(got.itemName, "新製品");
    assert.equal(got.expiresOn, null);
    assert.equal((await call("PUT", "/lots/L778", { ...body, expiresOn: "2026-06-01" })).status, 400); // 期限が製造日より前
    assert.equal((await call("PUT", "/lots/bad lot", body)).status, 400);
    assert.equal((await call("GET", "/lots/NOPE")).status, 404);
  });
});

describe("認証", () => {
  it("API_TOKEN があれば /health 以外は Bearer 必須", async () => {
    const { app } = await setup("secret");
    assert.equal((await app.request("/health")).status, 200);
    assert.equal((await app.request("/print-jobs")).status, 401);
    assert.equal((await app.request("/print-jobs", { headers: { Authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await app.request("/print-jobs", { headers: { Authorization: "Bearer secret" } })).status, 200);
  });
});
