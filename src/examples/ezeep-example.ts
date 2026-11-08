import { listPrinters, printFile, waitForJob } from "../gateway/ezeep/ezeep-client.ts";

const [file, printerArg] = process.argv.slice(2);
if (!file) {
  console.error("usage: npm run example -- <file.pdf> [printerId]");
  process.exit(1);
}

const printers = await listPrinters();
console.table(printers);

const printerId = printerArg ?? printers[0]?.id;
if (!printerId) throw new Error("利用可能なプリンターがありません");

const jobid = await printFile(file, printerId, { type: "pdf", copies: 1 });
console.log("jobid:", jobid);

const s = await waitForJob(jobid);
console.log(s.jobstatus === 0 ? "完了" : `エラー: ${s.jobstatus} ${s.jobstatusstring}`);
