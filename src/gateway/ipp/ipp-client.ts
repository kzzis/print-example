// 依存ライブラリなしの最小 IPP/1.1 クライアント。
// アプリ → (HTTP POST, Content-Type: application/ipp) → プリンター へ直接送る。
import http from "node:http";
import https from "node:https";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

// ---- 型 ----
export interface IppRange {
  lower: number;
  upper: number;
}
export interface IppResolution {
  x: number;
  y: number;
  units: number;
}
export type IppScalar =
  string | number | boolean | null | IppRange | IppResolution;
export interface IppCollection {
  [member: string]: IppValue;
}
/** 配列は「同名の複数値」を表す */
export type IppValue = IppScalar | IppCollection | IppValue[];
export type IppAttrs = Record<string, IppValue>;

export type Sides =
  "one-sided" | "two-sided-long-edge" | "two-sided-short-edge";

export interface PrintOptions {
  /** 省略時は拡張子から推定。不明なら application/octet-stream */
  mime?: string;
  jobName?: string;
  copies?: number;
  sides?: Sides;
  /** 例: "iso_a4_210x297mm" / "na_letter_8.5x11in" */
  media?: string;
  color?: boolean;
  orientation?: "portrait" | "landscape";
  /** 例: "1-2,4-5" */
  pageRanges?: string;
}

export interface IppPrinterOptions {
  user?: string;
  timeoutMs?: number;
  /** ipps:// で自己署名証明書を許可する場合のみ true */
  insecure?: boolean;
}

export type JobInfo = IppAttrs & { stateName: string };

/** 通信エラー。maybeDelivered=false は「プリンターに届く前に失敗した」ことが確実な場合のみ */
export class IppTransportError extends Error {
  readonly maybeDelivered: boolean;
  constructor(message: string, maybeDelivered: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = "IppTransportError";
    this.maybeDelivered = maybeDelivered;
  }
}
/** HTTP 200 以外の応答 */
export class IppHttpError extends Error {
  readonly httpStatus: number;
  constructor(httpStatus: number, message: string) {
    super(message);
    this.name = "IppHttpError";
    this.httpStatus = httpStatus;
  }
}
/** プリンターが IPP のエラーステータスを返した(ジョブは作られていない) */
export class IppStatusError extends Error {
  readonly ippStatus: number;
  constructor(ippStatus: number, message: string) {
    super(message);
    this.name = "IppStatusError";
    this.ippStatus = ippStatus;
  }
}

// 接続前に失敗したことが確実なエラーコード
const NOT_SENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
]);

// ---- タグ定義 (RFC 8010) ----
const OP = {
  PrintJob: 0x0002,
  ValidateJob: 0x0004,
  GetJobAttributes: 0x0009,
  GetPrinterAttributes: 0x000b,
} as const;
const GROUP = { operation: 0x01, job: 0x02, end: 0x03, printer: 0x04 } as const;
const TAG = {
  integer: 0x21,
  boolean: 0x22,
  enum: 0x23,
  range: 0x33,
  text: 0x41,
  name: 0x42,
  keyword: 0x44,
  uri: 0x45,
  charset: 0x47,
  language: 0x48,
  mime: 0x49,
} as const;

export const JOB_STATE: Record<number, string> = {
  3: "pending",
  4: "pending-held",
  5: "processing",
  6: "processing-stopped",
  7: "canceled",
  8: "aborted",
  9: "completed",
};

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".txt": "text/plain",
  ".ps": "application/postscript",
};

// ---- エンコード ----
type AttrInput = string | number | boolean | IppRange;
type AttrEntry = readonly [
  tag: number,
  name: string,
  value: AttrInput | AttrInput[],
];

const u16 = (n: number): Buffer => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

function encodeValue(tag: number, v: AttrInput): Buffer {
  switch (tag) {
    case TAG.integer:
    case TAG.enum: {
      const b = Buffer.alloc(4);
      b.writeInt32BE(v as number);
      return b;
    }
    case TAG.boolean:
      return Buffer.from([v ? 1 : 0]);
    case TAG.range: {
      const r = v as IppRange;
      const b = Buffer.alloc(8);
      b.writeInt32BE(r.lower, 0);
      b.writeInt32BE(r.upper, 4);
      return b;
    }
    default:
      return Buffer.from(String(v), "utf8");
  }
}

// 同名の複数値は、2つ目以降の name-length を 0 にする
function encodeAttr([tag, name, values]: AttrEntry): Buffer {
  const list = Array.isArray(values) ? values : [values];
  return Buffer.concat(
    list.map((v, i) => {
      const n = Buffer.from(i === 0 ? name : "", "utf8");
      const val = encodeValue(tag, v);
      return Buffer.concat([
        Buffer.from([tag]),
        u16(n.length),
        n,
        u16(val.length),
        val,
      ]);
    }),
  );
}

let requestCounter = 1;

function buildRequest(
  operationId: number,
  opAttrs: AttrEntry[],
  jobAttrs: AttrEntry[] = [],
  data?: Buffer,
): Buffer {
  const parts: Buffer[] = [
    Buffer.from([0x01, 0x01]),
    u16(operationId),
    u32(requestCounter++),
  ];
  parts.push(Buffer.from([GROUP.operation]), ...opAttrs.map(encodeAttr));
  if (jobAttrs.length)
    parts.push(Buffer.from([GROUP.job]), ...jobAttrs.map(encodeAttr));
  parts.push(Buffer.from([GROUP.end]));
  if (data) parts.push(data);
  return Buffer.concat(parts);
}

// ---- デコード ----
function decodeScalar(tag: number, raw: Buffer): IppScalar {
  if (tag >= 0x10 && tag <= 0x1f) return null; // unsupported / no-value などの out-of-band
  switch (tag) {
    case TAG.integer:
    case TAG.enum:
      return raw.length === 4 ? raw.readInt32BE(0) : raw.toString("hex");
    case TAG.boolean:
      return raw[0] === 1;
    case TAG.range:
      return { lower: raw.readInt32BE(0), upper: raw.readInt32BE(4) };
    case 0x32: // resolution
      return { x: raw.readInt32BE(0), y: raw.readInt32BE(4), units: raw[8]! };
    case 0x30: // octetString
    case 0x31: // dateTime
      return raw.toString("hex");
    default:
      return raw.toString("utf8");
  }
}

function addValue(obj: IppAttrs, key: string, value: IppValue): void {
  const cur = obj[key];
  if (cur === undefined) obj[key] = value;
  else if (Array.isArray(cur)) cur.push(value);
  else obj[key] = [cur, value];
}

function readValue(
  buf: Buffer,
  start: number,
  tag: number,
): { value: IppValue; pos: number } {
  let pos = start;
  const len = buf.readUInt16BE(pos);
  pos += 2;
  if (tag === 0x34) {
    // begCollection
    pos += len;
    const obj: IppAttrs = {};
    let member = "";
    for (;;) {
      const t = buf[pos++]!;
      const nl = buf.readUInt16BE(pos);
      pos += 2 + nl;
      if (t === 0x37) {
        // endCollection
        pos += 2 + buf.readUInt16BE(pos);
        break;
      }
      if (t === 0x4a) {
        // memberAttrName
        const vl = buf.readUInt16BE(pos);
        member = buf.toString("utf8", pos + 2, pos + 2 + vl);
        pos += 2 + vl;
        continue;
      }
      const r = readValue(buf, pos, t);
      pos = r.pos;
      addValue(obj, member, r.value);
    }
    return { value: obj, pos };
  }
  const raw = buf.subarray(pos, pos + len);
  return { value: decodeScalar(tag, raw), pos: pos + len };
}

interface IppGroup {
  group: number;
  attrs: IppAttrs;
}

function parseResponse(buf: Buffer): { status: number; groups: IppGroup[] } {
  if (buf.length < 8) throw new Error("IPP応答が短すぎます");
  const status = buf.readUInt16BE(2);
  const groups: IppGroup[] = [];
  let cur: IppGroup | undefined;
  let lastName = "";
  let pos = 8;
  while (pos < buf.length) {
    const tag = buf[pos++]!;
    if (tag === GROUP.end) break;
    if (tag <= 0x05) {
      cur = { group: tag, attrs: {} };
      groups.push(cur);
      lastName = "";
      continue;
    }
    if (!cur) throw new Error("不正なIPP応答(グループ開始前に属性)");
    const nl = buf.readUInt16BE(pos);
    pos += 2;
    const name = buf.toString("utf8", pos, pos + nl);
    pos += nl;
    const r = readValue(buf, pos, tag);
    pos = r.pos;
    if (nl) lastName = name;
    addValue(cur.attrs, nl ? name : lastName, r.value);
  }
  return { status, groups };
}

const statusHex = (s: number): string => `0x${s.toString(16).padStart(4, "0")}`;

function parsePageRanges(s: string): IppRange[] {
  return s.split(",").map((p) => {
    const [a, b = a] = p.trim().split("-").map(Number);
    return { lower: a!, upper: b! };
  });
}

/** 例: new IppPrinter("ipp://192.168.1.50/ipp/print") / "ipps://host:631/ipp/print" */
export class IppPrinter {
  readonly printerUri: string;
  readonly user: string;
  readonly timeoutMs: number;
  readonly insecure: boolean;
  readonly #secure: boolean;
  readonly #host: string;
  readonly #port: number;
  readonly #path: string;

  constructor(
    printerUri: string,
    {
      user = "ipp-client",
      timeoutMs = 30_000,
      insecure = false,
    }: IppPrinterOptions = {},
  ) {
    this.printerUri = printerUri;
    this.user = user;
    this.timeoutMs = timeoutMs;
    this.insecure = insecure;

    const u = new URL(
      printerUri.replace(/^ipp(s?):/, (_m, s: string) => `http${s}:`),
    );
    this.#secure = u.protocol === "https:";
    this.#host = u.hostname;
    this.#port = Number(u.port) || 631;
    this.#path = u.pathname + u.search;
  }

  // 注意: fetch は 631 番ポートをブロックするため node:http(s) を直接使う
  #post(body: Buffer): Promise<Buffer> {
    const request: typeof https.request = this.#secure
      ? https.request
      : (http.request as typeof https.request);
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: this.#host,
          port: this.#port,
          path: this.#path,
          method: "POST",
          headers: {
            "Content-Type": "application/ipp",
            "Content-Length": body.length,
          },
          rejectUnauthorized: !this.insecure,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            if (res.statusCode !== 200) {
              reject(
                new IppHttpError(
                  res.statusCode ?? 0,
                  `HTTP ${res.statusCode} (パスやポートを確認: ${this.printerUri})`,
                ),
              );
              return;
            }
            resolve(Buffer.concat(chunks));
          });
        },
      );
      req.setTimeout(this.timeoutMs, () =>
        req.destroy(new Error(`timeout (${this.timeoutMs}ms)`)),
      );
      req.on("error", (e: NodeJS.ErrnoException) =>
        reject(
          new IppTransportError(e.message, !NOT_SENT_CODES.has(e.code ?? ""), {
            cause: e,
          }),
        ),
      );
      req.end(body);
    });
  }

  #opAttrs(extra: AttrEntry[] = []): AttrEntry[] {
    return [
      [TAG.charset, "attributes-charset", "utf-8"],
      [TAG.language, "attributes-natural-language", "en"],
      [TAG.uri, "printer-uri", this.printerUri],
      [TAG.name, "requesting-user-name", this.user],
      ...extra,
    ];
  }

  async #call(
    op: number,
    opExtra: AttrEntry[],
    jobAttrs?: AttrEntry[],
    data?: Buffer,
  ): Promise<IppGroup[]> {
    const body = buildRequest(op, this.#opAttrs(opExtra), jobAttrs, data);
    const res = parseResponse(await this.#post(body));
    if (res.status >= 0x0100) {
      const msg = res.groups.find((g) => g.group === GROUP.operation)?.attrs[
        "status-message"
      ];
      throw new IppStatusError(
        res.status,
        `IPPエラー ${statusHex(res.status)}${msg ? `: ${String(msg)}` : ""}`,
      );
    }
    return res.groups;
  }

  /** プリンター情報。names を渡すと必要な属性だけ取得 */
  async getAttributes(names?: string[]): Promise<IppAttrs> {
    const extra: AttrEntry[] = names
      ? [[TAG.keyword, "requested-attributes", names]]
      : [];
    const groups = await this.#call(OP.GetPrinterAttributes, extra);
    return groups.find((g) => g.group === GROUP.printer)?.attrs ?? {};
  }

  /** Buffer を印刷して jobId を返す */
  async printBuffer(data: Buffer, opts: PrintOptions = {}): Promise<number> {
    const { mime = "application/octet-stream", jobName = "print-job" } = opts;
    const jobAttrs: AttrEntry[] = [];
    if (opts.copies) jobAttrs.push([TAG.integer, "copies", opts.copies]);
    if (opts.sides) jobAttrs.push([TAG.keyword, "sides", opts.sides]);
    if (opts.media) jobAttrs.push([TAG.keyword, "media", opts.media]);
    if (opts.color !== undefined) {
      jobAttrs.push([
        TAG.keyword,
        "print-color-mode",
        opts.color ? "color" : "monochrome",
      ]);
    }
    if (opts.orientation) {
      jobAttrs.push([
        TAG.enum,
        "orientation-requested",
        opts.orientation === "landscape" ? 4 : 3,
      ]);
    }
    if (opts.pageRanges)
      jobAttrs.push([
        TAG.range,
        "page-ranges",
        parsePageRanges(opts.pageRanges),
      ]);

    // Print-Job は冪等ではないため、自動リトライしない
    const groups = await this.#call(
      OP.PrintJob,
      [
        [TAG.name, "job-name", jobName],
        [TAG.mime, "document-format", mime],
      ],
      jobAttrs,
      data,
    );
    const jobId = groups.find((g) => g.group === GROUP.job)?.attrs["job-id"];
    if (typeof jobId !== "number")
      throw new Error("応答に job-id がありません");
    return jobId;
  }

  async printFile(filePath: string, opts: PrintOptions = {}): Promise<number> {
    const mime =
      opts.mime ??
      MIME_BY_EXT[extname(filePath).toLowerCase()] ??
      "application/octet-stream";
    return this.printBuffer(await readFile(filePath), {
      jobName: basename(filePath),
      ...opts,
      mime,
    });
  }

  async getJob(jobId: number): Promise<JobInfo> {
    const groups = await this.#call(OP.GetJobAttributes, [
      [TAG.integer, "job-id", jobId],
    ]);
    const attrs = groups.find((g) => g.group === GROUP.job)?.attrs ?? {};
    const state = attrs["job-state"];
    return {
      ...attrs,
      stateName:
        (typeof state === "number" ? JOB_STATE[state] : undefined) ?? "unknown",
    };
  }

  /** completed / canceled / aborted になるまで待つ */
  async waitForJob(
    jobId: number,
    { intervalMs = 2000, timeoutMs = 120_000 } = {},
  ): Promise<JobInfo> {
    const start = Date.now();
    for (;;) {
      const j = await this.getJob(jobId);
      const state = j["job-state"];
      if (state === 7 || state === 8 || state === 9) return j;
      if (Date.now() - start > timeoutMs)
        throw new Error("waitForJob: timeout");
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }
}
