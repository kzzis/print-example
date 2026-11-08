// レイヤーの依存方向を守っているかを、import 文から検査する。
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, it } from "node:test";

const SRC = resolve(import.meta.dirname);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) yield p;
  }
}

function localImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const found = [...text.matchAll(/from\s+"(\.[^"]+)"/g)].map((m) => m[1]!);
  return found.map((spec) => relative(SRC, resolve(dirname(file), spec)));
}

// [対象, 禁止する import 先]。パスは src からの相対(前方一致)
const RULES: { name: string; from: string; forbidden: string[] }[] = [
  { name: "model は何にも依存しない", from: "model/",
    forbidden: ["service/", "controller/", "repository/", "gateway/", "renderer/", "support/", "app.ts", "container.ts"] },
  { name: "service は具体実装(sqlite / ipp / ezeep)と controller を知らない", from: "service/",
    forbidden: ["controller/", "repository/sqlite/", "gateway/ipp/", "gateway/ezeep/", "renderer/plain-text", "app.ts"] },
  { name: "controller は repository / gateway / renderer を直接使わない", from: "controller/",
    forbidden: ["repository/", "gateway/", "renderer/", "app.ts", "container.ts"] },
  { name: "repository は service / controller に依存しない", from: "repository/",
    forbidden: ["service/", "controller/", "gateway/", "app.ts"] },
  { name: "gateway は service / controller / repository に依存しない", from: "gateway/",
    forbidden: ["service/", "controller/", "repository/", "app.ts"] },
];

describe("レイヤーの依存方向", () => {
  for (const rule of RULES) {
    it(rule.name, () => {
      const violations: string[] = [];
      for (const file of walk(SRC)) {
        const rel = relative(SRC, file);
        if (!rel.startsWith(rule.from)) continue;
        for (const target of localImports(file)) {
          // 自分と同じ層への import(例: repository/sqlite → repository/lot-repository)は対象外
          if (rule.forbidden.some((f) => target.startsWith(f)) && !target.startsWith(rule.from)) {
            violations.push(`${rel} → ${target}`);
          }
        }
      }
      assert.deepEqual(violations, []);
    });
  }
});
