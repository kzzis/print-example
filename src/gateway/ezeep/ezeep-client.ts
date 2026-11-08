import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";

const AUTH_URL = "https://account.ezeep.com/oauth/access_token/";
const API = "https://printapi.ezeep.com/sfapi";
const TOKEN_FILE = new URL("../../../.refresh_token", import.meta.url);

export interface Printer {
  id: string;
  name: string;
  location: string;
}

/** POST /sfapi/Print/ の任意パラメータ(公式ドキュメントより) */
export interface PrintOptions {
  /** 拡張子("pdf" など)。"auto" か省略で自動判定 */
  type?: string;
  /** 元のファイル名 */
  alias?: string;
  printanddelete?: boolean;
  paperid?: number;
  /** 1/10 mm。paperid=256(カスタム)のとき */
  paperlength?: number;
  paperwidth?: number;
  color?: boolean;
  duplex?: boolean;
  duplexmode?: number;
  /** 1=縦, 2=横 */
  orientation?: 1 | 2;
  copies?: number;
  resolution?: string;
  trayname?: string;
  defaultsource?: number;
  /** 例: "ja-JP" */
  locale?: string;
  /** 例: "1-2,4-5" */
  pageRanges?: string;
}

export interface JobStatus {
  jobpagesprinted: number;
  jobpagestotal: number;
  jobposition: number;
  /** 0=完了, 129=実行中, 1246=ステータス未取得, その他はエラー */
  jobstatus: number;
  jobstatusstring: string;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  refresh_token?: string;
}

let accessToken: string | undefined;
let expiresAt = 0;
let refreshToken: string | undefined;

async function loadRefreshToken(): Promise<string> {
  if (refreshToken) return refreshToken;
  try {
    refreshToken = (await readFile(TOKEN_FILE, "utf8")).trim();
  } catch {
    refreshToken = process.env.EZEEP_REFRESH_TOKEN;
  }
  if (!refreshToken) throw new Error("EZEEP_REFRESH_TOKEN が未設定です");
  return refreshToken;
}

/** refresh_token → access_token (有効期限3600秒) */
async function getToken(): Promise<string> {
  if (accessToken && Date.now() < expiresAt - 60_000) return accessToken;

  const clientId = process.env.EZEEP_CLIENT_ID;
  const clientSecret = process.env.EZEEP_CLIENT_SECRET ?? "";
  if (!clientId) throw new Error("EZEEP_CLIENT_ID が未設定です");
  const basic = Buffer.from(
    `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`,
  ).toString("base64");

  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      scope: "printing",
      refresh_token: await loadRefreshToken(),
    }),
  });
  if (!res.ok) throw new Error(`token: ${res.status} ${await res.text()}`);
  const t = (await res.json()) as TokenResponse;
  accessToken = t.access_token;
  expiresAt = Date.now() + t.expires_in * 1000;
  if (t.refresh_token) {
    // ローテーション有効時は使い捨てなので必ず保存し直す
    refreshToken = t.refresh_token;
    await writeFile(TOKEN_FILE, refreshToken, { mode: 0o600 });
  }
  return accessToken;
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await getToken()}`, ...init.headers },
  });
}

/** プリンター一覧 */
export async function listPrinters(): Promise<Printer[]> {
  const res = await api("/GetPrinter/");
  if (!res.ok) throw new Error(`GetPrinter: ${res.status} ${await res.text()}`);
  return (await res.json()) as Printer[];
}

/** ファイルをアップロードして印刷。jobid を返す */
export async function printFile(
  filePath: string,
  printerid: string,
  options: PrintOptions = {},
): Promise<string> {
  const prep = await api("/PrepareUpload/");
  if (!prep.ok) throw new Error(`PrepareUpload: ${prep.status} ${await prep.text()}`);
  const { fileid, sasUri } = (await prep.json()) as { fileid: string; sasUri: string };

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(await readFile(filePath))]), basename(filePath));
  const up = await fetch(sasUri, {
    method: "PUT",
    headers: { "x-ms-blob-type": "BlockBlob" },
    body: form,
  });
  if (up.status !== 201) throw new Error(`upload: ${up.status} ${await up.text()}`);

  return submitPrint({ fileid, printerid, alias: basename(filePath), ...options });
}

/** 公開URLのファイルを印刷。jobid を返す */
export async function printUrl(
  fileurl: string,
  printerid: string,
  options: PrintOptions = {},
): Promise<string> {
  return submitPrint({ fileurl, printerid, ...options });
}

async function submitPrint(body: Record<string, unknown>): Promise<string> {
  const send = (b: Record<string, unknown>) =>
    api("/Print/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(b),
    });

  let res = await send(body);
  if (res.status === 412) {
    // データは保存済み。fileid だけで再送する(再アップロード不要)
    const { fileid } = (await res.json()) as { fileid: string };
    const { fileurl: _fileurl, ...rest } = body;
    res = await send({ ...rest, fileid });
  }
  // Print は冪等ではないため、タイムアウト等での自動リトライはしない
  if (!res.ok) throw new Error(`Print: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { jobid: string }).jobid;
}

export async function jobStatus(jobid: string): Promise<JobStatus> {
  const res = await api(`/Status/?id=${encodeURIComponent(jobid)}`);
  if (!res.ok) throw new Error(`Status: ${res.status} ${await res.text()}`);
  return (await res.json()) as JobStatus;
}

/** 完了(または失敗)までポーリング */
export async function waitForJob(
  jobid: string,
  { intervalMs = 2000, timeoutMs = 120_000 } = {},
): Promise<JobStatus> {
  const start = Date.now();
  for (;;) {
    const s = await jobStatus(jobid);
    // 129=実行中, 1246=ステータスまだ無し
    if (s.jobstatus !== 129 && s.jobstatus !== 1246) return s;
    if (Date.now() - start > timeoutMs) throw new Error("waitForJob: timeout");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
