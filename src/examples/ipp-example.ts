import { IppPrinter } from "../gateway/ipp/ipp-client.ts";

const [uri, file] = process.argv.slice(2);
if (!uri) {
  console.error("usage: npm run ipp -- <ipp://host/ipp/print> [file.pdf]");
  process.exit(1);
}

const printer = new IppPrinter(uri);

if (!file) {
  // ファイル未指定ならプリンター情報を表示(対応形式・両面・用紙の確認用)
  const a = await printer.getAttributes();
  for (const k of [
    "printer-make-and-model",
    "printer-state",
    "printer-state-reasons",
    "document-format-supported",
    "sides-supported",
    "media-supported",
    "print-color-mode-supported",
  ]) {
    console.log(`${k}:`, a[k]);
  }
} else {
  const jobId = await printer.printFile(file, { copies: 1 });
  console.log("job-id:", jobId);
  const j = await printer.waitForJob(jobId);
  console.log("結果:", j.stateName, j["job-state-reasons"]);
}
