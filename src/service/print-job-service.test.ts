import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InvalidRequestError, InvalidTransitionError, PrinterNotReadyError } from "../model/errors.ts";
import { SAMPLE_LOT, createTestContainer } from "../testing/fakes.ts";

const cmd = (key: string, labelCount = 3) => ({
  lotNo: SAMPLE_LOT.lotNo, labelCount, printer: "front-desk", requestedBy: "tanaka", idempotencyKey: key,
});

describe("PrintJobService.print", () => {
  it("台帳に記録してから送信し、sent になる(ラベルは連番付きで保存)", async () => {
    const t = await createTestContainer();
    const job = await t.printJobService.print(cmd("k1"));
    assert.equal(job.status, "sent");
    assert.equal(job.externalJobId, "100");
    assert.equal(t.printer.printCalls.length, 1);

    const detail = await t.printJobService.get(job.id);
    assert.deepEqual(detail.labels.map((l) => `${l.serial}/${l.total}`), ["1/3", "2/3", "3/3"]);
    assert.deepEqual(detail.events.map((e) => e.to), ["queued", "sending", "sent"]);
  });

  it("同じ Idempotency-Key の再送は、新しく印刷しない", async () => {
    const t = await createTestContainer();
    const a = await t.printJobService.print(cmd("same"));
    const b = await t.printJobService.print(cmd("same"));
    assert.equal(a.id, b.id);
    assert.equal(t.printer.printCalls.length, 1);
  });

  it("同じキーの同時リクエストでも 1 回しか印刷しない", async () => {
    const t = await createTestContainer();
    t.printer.printDelayMs = 20;
    const [a, b] = await Promise.all([t.printJobService.print(cmd("race")), t.printJobService.print(cmd("race"))]);
    assert.equal(a.id, b.id);
    assert.equal(t.printer.printCalls.length, 1);
  });

  it("プリンターが拒否したら failed(印刷されていない)", async () => {
    const t = await createTestContainer();
    t.printer.printOutcome = "reject";
    const job = await t.printJobService.print(cmd("k2"));
    assert.equal(job.status, "failed");
  });

  it("結果が不明なら unknown。同じキーで再送しても自動では再印刷しない", async () => {
    const t = await createTestContainer();
    t.printer.printOutcome = "uncertain";
    const job = await t.printJobService.print(cmd("k3"));
    assert.equal(job.status, "unknown");

    t.printer.printOutcome = "ok";
    const again = await t.printJobService.print(cmd("k3"));
    assert.equal(again.status, "unknown");
    assert.equal(t.printer.printCalls.length, 1);
  });

  it("用紙切れなどで送れないときは queued のまま。直したら同じキーで送り直せる", async () => {
    const t = await createTestContainer();
    t.printer.notReadyReasons = ["media-empty"];
    await assert.rejects(t.printJobService.print(cmd("k4")), PrinterNotReadyError);
    assert.equal(t.printer.printCalls.length, 0);
    const [queued] = await t.printJobService.list(["queued"]);
    assert.ok(queued);
    assert.match(queued.statusReason ?? "", /media-empty/);

    t.printer.notReadyReasons = [];
    const job = await t.printJobService.print(cmd("k4"));
    assert.equal(job.status, "sent");
    assert.equal(job.id, queued.id);
    assert.equal(t.printer.printCalls.length, 1);
  });

  it("同じプリンターへは同時に 1 ジョブずつ送る", async () => {
    const t = await createTestContainer();
    t.printer.printDelayMs = 15;
    await Promise.all([t.printJobService.print(cmd("a")), t.printJobService.print(cmd("b")), t.printJobService.print(cmd("c"))]);
    assert.equal(t.printer.printCalls.length, 3);
    assert.equal(t.printer.maxConcurrent, 1);
  });

  it("不正な依頼は拒否する", async () => {
    const t = await createTestContainer();
    await assert.rejects(t.printJobService.print(cmd("x", 0)), InvalidRequestError);
    await assert.rejects(t.printJobService.print({ ...cmd("y"), printer: "nope" }), /登録されていません/);
    await assert.rejects(t.printJobService.print({ ...cmd("z"), lotNo: "NOPE" }), /見つかりません/);
  });
});

describe("PrintJobService.resolveUnknown / reprint", () => {
  it("unknown を人が確定すると confirmed になり、確認者が残る", async () => {
    const t = await createTestContainer();
    t.printer.printOutcome = "uncertain";
    const job = await t.printJobService.print(cmd("u1"));
    const resolved = await t.printJobService.resolveUnknown({ jobId: job.id, decision: "printed", resolvedBy: "sato" });
    assert.equal(resolved.status, "confirmed");
    assert.equal(resolved.resolvedBy, "sato");
    await assert.rejects(
      t.printJobService.resolveUnknown({ jobId: job.id, decision: "printed", resolvedBy: "sato" }),
      InvalidTransitionError,
    );
  });

  it("再印刷は理由が必須で、unknown のままでは作れない", async () => {
    const t = await createTestContainer();
    t.printer.printOutcome = "uncertain";
    const unknown = await t.printJobService.print(cmd("r1"));
    await assert.rejects(
      t.printJobService.reprint({ originalJobId: unknown.id, reason: "破れた", requestedBy: "t", idempotencyKey: "rr1" }),
      InvalidTransitionError,
    );

    await t.printJobService.resolveUnknown({ jobId: unknown.id, decision: "not-printed", resolvedBy: "sato" });
    t.printer.printOutcome = "ok";
    await assert.rejects(
      t.printJobService.reprint({ originalJobId: unknown.id, reason: " ", requestedBy: "t", idempotencyKey: "rr2" }),
      InvalidRequestError,
    );
    const re = await t.printJobService.reprint({ originalJobId: unknown.id, reason: "未印刷だった", requestedBy: "t", idempotencyKey: "rr3" });
    assert.equal(re.status, "sent");
    assert.equal(re.originalJobId, unknown.id);
    assert.equal(re.reprintReason, "未印刷だった");
  });

  it("再印刷は当時のラベル内容を引き継ぐ(ロットを更新しても変わらない)", async () => {
    const t = await createTestContainer();
    const original = await t.printJobService.print(cmd("s1", 2));
    await t.maintenance.confirmCompletion(); // sent → confirmed
    await t.lotService.save({ ...SAMPLE_LOT, itemName: "名前が変わった" });

    const re = await t.printJobService.reprint({
      originalJobId: original.id, reason: "汚れ", requestedBy: "t", idempotencyKey: "s2",
    });
    assert.equal(re.status, "sent");
    const detail = await t.printJobService.get(re.id);
    assert.equal(detail.labels.length, 2);
    assert.equal(detail.labels[0]?.itemName, SAMPLE_LOT.itemName);
    assert.equal(t.printer.printCalls.length, 2);
  });
});

describe("MaintenanceService", () => {
  it("起動時、sending のまま残ったジョブを unknown にする", async () => {
    const t = await createTestContainer();
    const job = await t.printJobService.print(cmd("m1"));
    // 送信中に落ちた状態を再現: sent → 直接 sending のジョブを作る代わりに、新規 queued を sending にする
    const stuck = { ...(await t.jobs.findById(job.id))!, id: "stuck", idempotencyKey: "stuck", status: "sending" as const };
    await t.jobs.insert(stuck, []);
    const recovered = await t.maintenance.recoverInterrupted();
    assert.deepEqual(recovered, ["stuck"]);
    assert.equal((await t.jobs.findById("stuck"))?.status, "unknown");
  });

  it("sent のジョブはプリンターの報告で confirmed / failed に進む", async () => {
    const t = await createTestContainer();
    const job = await t.printJobService.print(cmd("m2"));
    t.printer.remoteState = "processing";
    assert.equal((await t.maintenance.confirmCompletion())[0]?.outcome, "pending");
    t.printer.remoteState = "completed";
    assert.equal((await t.maintenance.confirmCompletion())[0]?.outcome, "confirmed");
    assert.equal((await t.jobs.findById(job.id))?.status, "confirmed");
  });
});
