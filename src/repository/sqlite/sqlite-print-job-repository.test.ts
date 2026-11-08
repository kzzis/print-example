import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createJob,
  snapshotLabels,
  toLabelRecords,
  transition,
} from "../../model/print-job.ts";
import { SAMPLE_LOT } from "../../testing/fakes.ts";
import { openDatabase } from "./database.ts";
import { SqliteLotRepository } from "./sqlite-lot-repository.ts";
import { SqlitePrintJobRepository } from "./sqlite-print-job-repository.ts";

async function setup() {
  const db = openDatabase(":memory:");
  const lots = new SqliteLotRepository(db);
  const jobs = new SqlitePrintJobRepository(db);
  await lots.save(SAMPLE_LOT);
  const make = (id: string, key: string) => {
    const job = createJob({
      id, lotNo: SAMPLE_LOT.lotNo, labelCount: 2, printer: "front-desk",
      requestedBy: "tanaka", idempotencyKey: key, at: new Date("2026-11-07T09:00:00Z"),
    });
    let n = 0;
    return { job, labels: toLabelRecords(id, snapshotLabels(SAMPLE_LOT, 2), () => `${id}-l${++n}`) };
  };
  return { db, lots, jobs, make };
}

describe("SqlitePrintJobRepository", () => {
  it("ジョブとラベルを保存して読み戻せる(NULL・JSON も往復)", async () => {
    const { jobs, lots, make } = await setup();
    const { job, labels } = make("j1", "k1");
    await jobs.insert(job, labels);
    assert.deepEqual(await jobs.findById("j1"), job);
    assert.deepEqual(await jobs.findByIdempotencyKey("k1"), job);
    assert.deepEqual((await jobs.labelsOf("j1")).map((l) => l.content.barcode), ["L240601/1", "L240601/2"]);
    assert.deepEqual(await lots.findByLotNo("L240601"), SAMPLE_LOT);
  });

  it("状態が変わったときだけ監査ログ(job_event)を残す", async () => {
    const { jobs, make } = await setup();
    const { job, labels } = make("j2", "k2");
    await jobs.insert(job, labels);
    const sending = transition(job, "sending", new Date("2026-11-07T09:00:01Z"));
    await jobs.update(sending);
    await jobs.update({ ...sending, statusReason: "メモだけ変更" }); // 状態は同じ
    const sent = transition(sending, "sent", new Date("2026-11-07T09:00:02Z"), { externalJobId: "42" });
    await jobs.update(sent);

    const events = await jobs.eventsOf("j2");
    assert.deepEqual(events.map((e) => `${e.from ?? "-"}>${e.to}`), ["-" + ">queued", "queued>sending", "sending>sent"]);
    assert.equal((await jobs.findById("j2"))?.externalJobId, "42");
  });

  it("idempotency_key が重複する登録は失敗し、ジョブもラベルも残らない", async () => {
    const { jobs, make } = await setup();
    const a = make("j3", "dup");
    await jobs.insert(a.job, a.labels);
    const b = make("j4", "dup");
    await assert.rejects(jobs.insert(b.job, b.labels));
    assert.equal(await jobs.findById("j4"), undefined);
    assert.deepEqual(await jobs.labelsOf("j4"), []);
  });

  it("状態で絞り込める", async () => {
    const { jobs, make } = await setup();
    const a = make("j5", "k5");
    const b = make("j6", "k6");
    await jobs.insert(a.job, a.labels);
    await jobs.insert(b.job, b.labels);
    await jobs.update(transition(b.job, "sending", new Date()));
    assert.deepEqual((await jobs.findByStatus("queued")).map((j) => j.id), ["j5"]);
    assert.deepEqual((await jobs.findByStatus("queued", "sending")).map((j) => j.id).sort(), ["j5", "j6"]);
    assert.deepEqual(await jobs.findByStatus(), []);
  });
});
