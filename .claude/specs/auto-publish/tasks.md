# 公開版（docs/）の自動コミット・プッシュ — タスク

検証用の作業リポジトリ: スクラッチパッドに bare リポジトリ（origin 役）と、それを clone した
作業リポジトリを作る。T1・T3 の確認はここで行い、本番の public リポジトリには触らない。
`publish.js` はリポジトリの場所を引数（既定は `ROOT`）で受け、タイムアウトも引数で縮められるようにする。

## T1 publish.js を作る
- 触るファイル: `scripts/lib/publish.js`（新規）、`config.json`
- やること: `startPublish` / `schedulePublish` / `isCommitting` / `idle` を実装する。
  git は `spawn` で非同期に呼び、対話禁止の環境変数と呼び出しごとのタイムアウトを付ける。直列化する。
  `config.json` に `publish.auto_push: true` を足す
- **完了条件（すべて作業リポジトリで確認）:**
  - 許可リストのファイルだけを変えて呼ぶと `pushed`、bare 側の `main` が進む
  - `scripts/x.js` を変更・ステージした状態で呼んでも、そのファイルはコミットに入らない（ステージは残る）
  - 何も変えずに呼ぶと `no_change`、コミットが増えない
  - `main` 以外のブランチで呼ぶと `not_main`
  - `scripts/x.js` を変えるコミットを手で作って未プッシュにした状態で呼ぶと `blocked`、bare 側は進まない
  - origin を存在しないパスに向けて呼ぶと `push_failed`、ローカルのコミットは残る。
    origin を戻して再度呼ぶと、そのコミットが push されて `pushed`
  - 何も返さない TCP サーバ（`net.createServer` で接続を受けて放置）を origin の URL にし、
    タイムアウトを 3 秒にして呼ぶと、約 3 秒で `push_failed` が返る（止まり続けない）
  - push 区間の最中に `isCommitting()` が false、コミット区間の最中は true
  - `auto_push: false` で `disabled`

## T2 build-web.js の点検を書き出しの前へ移す
- 触るファイル: `scripts/build-web.js`
- やること: 平文混入チェックを `docs/` への書き出しより前に移し、落ちたら何も書かずに exit 1 する
- **完了条件:**
  - `npm run build:web` が通り、出力の末尾に「平文混入チェック」の ✅ が出る
  - `npm run restore`（確認のみ）で復号でき、件数が直前と同じ
  - 点検に落ちる状況（`ui/app.js` に `1,234` を一時的に書く）で実行すると exit 1、
    `docs/index.html` の更新時刻が変わらない。確認後に一時変更を戻す

## T3 ウォッチャと確定パネルに組み込む
- 触るファイル: `scripts/watch.js`、`scripts/lib/panel-server.js`
- やること: 設計の「呼び出し元」表のとおり。ログの `publish`、起動2分後の catchup、失敗トースト、
  パネルの `schedulePublish` と受付判定
- **完了条件:**
  - `node --check` が両ファイルで通る
  - 作業リポジトリで `schedulePublish` を 2 回続けて呼ぶと、コミットが 1 つだけ増える
  - `scripts/close.js` に差分が無い（`git diff --stat scripts/close.js` が空）

## T4 本番で確かめる（常駐タスクのまま）
- 触るファイル: なし
- やること: 常駐タスクを再起動して新しいコードを載せ（`schtasks /End` → `/Run`）、
  `imports/` の既存 CSV の更新時刻だけを変えて自動反映を起こす。
  **タスクスケジューラ起動の環境で git の資格情報が使えるかも、これで同時に確かめる**
- **完了条件:**
  - `git log origin/main -1 --format=%s` が `自動反映（取込）`、変更は許可リストのファイルだけ
  - `data/watch_log.json` の最後のエントリが `"ok": true, "publish": "pushed"`
  - 取り込み〜ビルドの失敗経路（`skipped`）と push 失敗のトーストは作業リポジトリ側で確認済みのため、本番では起こさない
  - パネル経由の push は、実データを変えずに確定する手段が無いため、**実運用の最初の確定で確かめる**

## T5 ドキュメントを実装に合わせる
- 触るファイル: `CLAUDE.md`、`.claude/specs/auto-ingest/requirements.md`
- やること: `CLAUDE.md` の「自動反映」節に自動公開の説明と「触るときに壊しやすいところ」
  （許可リスト・pathspec 付き commit・`blocked`・対話禁止・pull しない・コミット区間の排他・
  build-web の点検順序）を足し、月次運用の手順 7 を改める。auto-ingest の非目標に注記する
- **完了条件:** `CLAUDE.md` に「自動でプッシュ」の記述があり、月次運用の手順と矛盾しない。
  実データ（金額・店名・件数）を書いていない
