# Slotly

スタートアップや小規模サービスのための、軽量なマルチテナント広告配信サーバー。

自社の Web サイトやアプリに広告枠を持ち、提携先への直接販売と、空き枠のバックフィル（Google Ad Manager など）を、ひとつの管理画面で運用できます。配信モデルは Revive Adserver 型（枠 × キャンペーン種別 × 優先度）で、動作基盤は Cloudflare Workers（D1 / KV / Queues）です。基盤側が広告費の資金を預かることはありません。

## 特徴

- **マルチテナント** — テナントごとに枠・広告主・集計が分離され、各テナントが自分のサイト/アプリに枠を埋め込めます
- **配信ルール** — 優先度（Override / Contract / Remnant）、重み付け、地域、曜日・時間帯、日次上限、フリークエンシーキャップ、目標インプレッション
- **クリエイティブ2形式** — HTML（Web 向け）と構造化形式（画像 URL + タイトル + 本文。アプリでネイティブ描画できます）
- **審査フロー** — バナーは承認されるまで配信されません
- **販売フロー** — プランと申込を管理し、承認すると契約キャンペーンを自動生成します
- **レポート** — 期間指定レポート（CSV 対応）と、広告主ごとの月次レポート（総表示回数 / キャンペーン別内訳 / 日別）
- **アプリ SDK** — Expo / React Native 用コンポーネントを別リポジトリ（slotly-sdk）で提供
- **バックフィル** — 枠ごとに外部タグを設定でき、直接販売のない枠・時間帯を埋められます

## クイックスタート（ローカル）

依存は Node.js のみです。

```sh
node server.mjs
```

- デモページ: http://localhost:8788/demo
- 管理画面: http://localhost:8788/admin
- レポート: http://localhost:8788/admin/report
- 月次レポート: http://localhost:8788/admin/monthly

ローカルではデータは `data-prod.json`（自動生成、git 管理外）に保存されます。管理画面にトークン認証を付ける場合は `ADMIN_TOKEN=<任意の文字列> node server.mjs` とし、リクエストヘッダ `x-admin-token` で認証します。

## Cloudflare へのデプロイ

1. D1 データベース、KV 名前空間、Queues を作成し、`wrangler.toml` の ID を差し替えます
   ```sh
   npx wrangler d1 create slotly
   npx wrangler kv namespace create SNAP
   npx wrangler queues create ad-events
   ```
2. スキーマを適用します
   ```sh
   npx wrangler d1 execute slotly --remote --file=schema.sql
   ```
3. 管理トークンを設定します
   ```sh
   npx wrangler secret put ADMIN_TOKEN
   ```
4. デプロイします
   ```sh
   npx wrangler deploy
   ```
5. 管理画面（`/admin`）の前段に Cloudflare Access を置くことを推奨します
6. テナント・枠・広告主は管理画面の追加フォームから登録します

本番では、配信は KV スナップショットを参照し、計測イベントは Queues 経由で D1 に取り込まれます。毎時の Cron でスナップショット再発行と時間次集計が走ります。

## 枠の埋め込み

### Web（タグ）

```html
<script src="https://<your-domain>/tag/<zone-id>.js"></script>
```

または配信エンドポイントを直接読み込んでください。

```
GET /ad/<zone-id>            → HTML（広告表記付き）
GET /ad/<zone-id>?format=json → 構造化レスポンス（creative / imp・click URL を含む）
```

地域ルールを使う場合は `?region=<値>` または `x-region` ヘッダで地域を渡します。

### アプリ（Expo / React Native）

クライアント SDK は別リポジトリ [bannerly/sdk](https://github.com/bannerly/sdk) で提供しています。構造化クリエイティブをネイティブ描画する `AdSlot` コンポーネントが含まれます。

## 配信仕様

- 優先度は **Override > Contract > Remnant**。同優先度内は重み付きで選択されます
- Contract は目標インプレッション到達で止まります。管理画面に進捗と到達予測（未達アラート）が表示されます
- バックフィルは、配信可能なキャンペーンがない場合に枠ごとの設定 HTML を返します
- インプレッションは配信トークン単位で重複排除され、クリックは計測後にリンク先へリダイレクトします

## データモデル

`schema.sql` を参照してください。主要テーブル: `tenants` / `zones` / `advertisers` / `campaigns` / `banners`（`review_status` を持ちます）/ `plans` / `orders` / `events_raw` / `stats_hourly`。

## 状態

Phase 1（実用化）まで実装済みです。ローカル構成（JSON リポジトリ）での通し検証は完了しています。D1 構成はコード完成済みで、初回デプロイ時の動作確認を前提としています。決済連携（Stripe）と GAM 実連携は今後の段階です。

## ライセンス

MIT License
