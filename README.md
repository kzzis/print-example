# ezeep-print — ロットトレーサビリティ ラベル印刷 API

社内サーバーから、ネットワーク内のラベルプリンターへ IPP で直接印刷する HTTP API。
Hono + Node.js (>=22.18, `.ts` を直接実行) + SQLite (`node:sqlite`)。

## 構成 (Controller / Service / Repository / Model)

```
controller/   HTTP の入口 (Hono)。入力検証と、例外 → HTTP ステータスの変換だけ行う
service/      業務ロジック。印刷依頼・送信・再印刷・unknown の確定・完了確認
repository/   永続化。interface と sqlite/ の実装
model/        エンティティと状態遷移 (PrintJob, Lot, LabelContent, エラー型)
gateway/      外部システム。LabelPrinter interface と ipp/ (IPP クライアント), ezeep/
renderer/     ラベルの描画。LabelRenderer interface と暫定の plain-text 実装
app.ts        Hono アプリの組み立て (認証・ルーティング)
container.ts  依存の注入。interface だけを受け取るのでテストで差し替え可能
server.ts     本番の起動 (SQLite・IPP を接続)
```

依存の向きは `controller → service → (repository / gateway / renderer の interface) → model`。
`src/architecture.test.ts` が import 文を検査して、逆向きの依存を弾く。

## 使い方

```
cp labels.config.example.json labels.config.json   # プリンターの URI を編集
npm start                                          # http://127.0.0.1:3000
npm test && npm run typecheck
```

環境変数: `PORT` / `HOST`(既定 127.0.0.1) / `API_TOKEN` / `LABEL_CONFIG` / `CONFIRM_INTERVAL_MS`。
`HOST` を 127.0.0.1 以外にする場合、`API_TOKEN` がないと起動しない (Bearer 認証)。

## API

| メソッド・パス | 内容 |
|---|---|
| `PUT /lots/:lotNo` / `GET /lots/:lotNo` | ロットの登録・取得 |
| `POST /print-jobs` | 印刷依頼 (`Idempotency-Key` ヘッダー必須) |
| `GET /print-jobs?status=unknown,sent` | 状態で一覧 (既定 unknown) |
| `GET /print-jobs/:id` | ジョブ・ラベル内容・状態履歴 |
| `POST /print-jobs/:id/resolve` | unknown を人が確定 (`printed` / `not-printed`) |
| `POST /print-jobs/:id/reprint` | 再印刷 (理由必須、`Idempotency-Key` 必須) |
| `POST /print-jobs/confirm` | sent のジョブをプリンターに問い合わせて完了確認 |
| `GET /health` | 死活確認 (認証なし) |

## 二重印刷を防ぐ設計

- 状態: `queued → sending → sent → confirmed` / `failed` / `unknown`。遷移は `model/print-job.ts` に集約。
- `sending` は通信の**前**に保存する。落ちたら起動時に `unknown` へ回す。
- 届いたか不明な失敗 (タイムアウト等) は `unknown`。**自動再送しない**。人が現物を見て `resolve` する。
- 同じ `Idempotency-Key` の再送は、新しいジョブを作らない。未送信 (`queued`) なら送信をやり直す。
- 再印刷は新しいジョブとして、元ジョブ ID と理由を記録する。元ジョブが `unknown` の間は不可。
- すべての状態変化は `job_event` に記録される。

## 未実装・要確認

- ラベルの描画は暫定の text/plain。機種が決まったら `LabelRenderer` を PDF / ZPL で実装する。
- ラベルプリンターが IPP 対応か (ZPL を TCP 9100 に直接送る方式ではないか) は未確認。
- IPP アダプターは偽のプリンターでのみ検証済み。実機では未検証。
