# フォルダ投入だけで家計アプリへ自動反映する — タスク

上から順に実装する。各タスクは単体で動作確認できる粒度にしてある。

## T0 `.claude/CLAUDE.md` の矛盾を直す

既存仕様 `.claude/specs/fix-claude-md-contradiction.md` / 改善候補 `ops--kakei-manager--5a94b864` を消化する。
**最初にやる。** 以降の実装が誤った前提（`data/` は Git 管理・Pages は使わない）を読まないため。

- 触るファイル: `.claude/CLAUDE.md`
- やること: ルートの `CLAUDE.md` が正。`data/` は Git 管理外で `docs/index.html`（暗号化）が
  唯一のバックアップである旨に直す。重複している章はルート版へ寄せ、
  このファイルには残す価値のあるものだけを残す
- **完了条件:** `.claude/CLAUDE.md` を読んで「`data/` は Git 管理されている」「Pages は使わない」と
  誤読できる記述が1つも残っていない。`.gitignore` と `build-web.js` の実装と矛盾しない

## T1 `writeJson` をアトミックにする

- 触るファイル: `scripts/lib/io.js`
- やること: `.tmp` に書いてから `renameSync` で置き換える。失敗時は `.tmp` を残さない
- **完了条件:** `npm run build` が通り、`data/` の JSON が従来と同じ内容・同じ整形で出力される。書き込み後に `data/*.tmp` が1つも残っていない

## T2 パイプラインを関数に切り出す

- 触るファイル: `scripts/lib/pipeline.js`（新規）、`scripts/close.js`
- やること: 取込4本＋`build.js`＋`build-web.js` を順に実行する `runPipeline()` を作り、
  close.js のステップ1〜4・7をこれに置き換える。build-web の失敗を握りつぶさず結果に含める
- **完了条件:** `npm run close -- --yes` が従来と同じ出力・同じ結果で完走する。
  `.webpass` を一時的に退避した状態で実行すると、build-web の失敗が
  「⚠」ではなく明確な失敗として報告される（取込結果は保持される）

## T3 Windows トースト通知

- 触るファイル: `scripts/lib/notify.js`（新規）
- やること: 環境変数でタイトル・本文を渡し、PowerShell の WinRT API でトーストを出す。
  失敗しても例外を投げずコンソール出力にフォールバックする
- **完了条件:** `node -e "import('./scripts/lib/notify.js').then(m=>m.notify('テスト',['本文1','本文2']))"` で
  デスクトップ右下に通知が出る。店名に `&` `<` `'` を含む文字列を渡しても崩れず表示される

## T4 分類の書き戻しを1か所にまとめる

- 触るファイル: `scripts/lib/classify-apply.js`（新規）、`scripts/close.js`、`scripts/set-category.js`
- やること: 「ルールを追加する（先勝ちを崩さない位置に挿入）」「1件だけ確定する」を関数化し、
  close.js と set-category.js をこれを呼ぶ形に置き換える
- **完了条件:** `npm run close` の対話でルールを1件追加したとき、
  従来と同じ位置（既存ヒットルールの直前）に挿入される。
  `node scripts/set-category.js --dry` が従来と同じ対象一覧を表示する

## T5 ロックを共通化する

- 触るファイル: `scripts/lib/lock.js`（新規）、`scripts/close.js`、`.gitignore`
- やること: `.watch.lock` の取得・解放・生存判定（PID の生存 **かつ** 鼓動が3分以内）・
  1分ごとの鼓動更新を関数にする。close.js の冒頭でロックを見て、
  稼働中なら中止する（`--force` で続行）
- **完了条件:**
  (a) ロックが無い状態で `npm run close -- --yes` が従来どおり完走する、
  (b) 手で `.watch.lock` に自分以外の生きた PID と現在時刻の鼓動を書くと
      `npm run close` が中止し、`--force` を付けると実行される、
  (c) 鼓動が 10 分前のロックは「死んでいる」と判定され、奪って起動できる

## T6 常駐ウォッチャ

- 触るファイル: `scripts/watch.js`（新規）、`package.json`、`config.json`
- やること: 3フォルダを `fs.watch` し、デバウンス3秒 → サイズ安定待ち → `runPipeline()` →
  通知 → `data/watch_log.json` 追記（直近200件で打ち切り）。
  `lock.js` で二重起動を防ぎ、鼓動を打つ。実行中のイベントは完了後に1回だけ再実行する
- **完了条件:** `npm run watch` を起動した状態で
  (a) `imports/` に既存 CSV をコピーし直すと数秒後にパイプラインが走り通知が出る、
  (b) 3ファイルを同時にコピーしても実行は1回、
  (c) 2つ目の `npm run watch` は「既に動いています」と出て即座に終了する、
  (d) `data/watch_log.json` に成否と件数が追記され、201件目で最古が落ちる、
  (e) 空のファイルを作ってから中身を書き込むと、空の状態では取り込まれない

## T7 確定パネルのサーバ

- 触るファイル: `scripts/lib/panel-server.js`（新規）、`scripts/panel.js`（新規）、`package.json`
- やること: 127.0.0.1 限定の HTTP サーバ。`GET /` で `dist/index.html` にトークンを注入して配り、
  `POST /api/classify` で `classify-apply.js` を呼んで再ビルドする。
  Host ヘッダ検証・トークン照合・64KB 上限・直列化を入れる。
  単体起動時はロックを見て、ウォッチャ稼働中なら内蔵パネルの URL を案内して終了する
- **完了条件:** `npm run panel` 起動後、
  (a) `http://127.0.0.1:4649/` でダッシュボードが表示される、
  (b) `curl` でトークン無しの POST が 403 で拒否される、
  (c) PC の LAN IP（`http://192.168.x.x:4649/`）では接続できない、
  (d) 正しいトークン付きの POST で `category_rules.json` が更新され `dist/index.html` が再生成される、
  (e) ウォッチャを起動した状態で `npm run panel` を叩くと、二重に listen せず案内を出して終了する

## T8 ウォッチャとパネルを同居させる

- 触るファイル: `scripts/watch.js`、`scripts/lib/panel-server.js`
- やること: ウォッチャ起動時にパネルも同じプロセスで listen する。
  パイプライン実行中は `/api/classify` が 409 を返すようにする
- **完了条件:** `npm run watch` だけで `http://127.0.0.1:4649/` が開ける。
  パイプライン実行中に POST すると 409 が返り、完了後は成功する

## T9 ダッシュボードに確定 UI を足す

- 触るファイル: `ui/app.js`、`ui/style.css`、`scripts/build.js`
- やること: `renderReview` に `canEdit` 分岐を入れ、真のときだけ
  「ルールにする / この1件だけ / 後で」＋カテゴリ選択＋中分類＋確定ボタンを描く。
  バナーの案内文をパネルの URL に差し替える。
  `build.js` が `DATA` に載せる「最後の自動反映」の日時をヘッダに出す
- **完了条件:**
  (a) `dist/index.html` を `file://` で開くと従来と寸分違わぬ読み取り専用テーブルが出る、
  (b) `http://127.0.0.1:4649/` で開くと確定 UI が出て、選んで確定すると
      ページが再読込され、その店が要確認から消える、
  (c) `docs/index.html`（https）では確定 UI が出ない、
  (d) **PC のブラウザの開発者ツールで幅を 375px にしても**操作できる
      （パネルは 127.0.0.1 限定のためスマホ実機では開けない）、
  (e) ヘッダに「最後の自動反映」の日時が出る

## T10 スタートアップ登録

- 触るファイル: `scripts/install-watcher.js`（新規）、`package.json`、`.gitignore`
- やること: タスク定義 XML を生成し、`schtasks /create /xml` でログオン時タスクを登録する。
  XML には失敗時の再起動（1分後・3回まで）、バッテリ駆動でも止めない、
  実行時間の上限なしを入れる。`--uninstall` / `--status` も実装する
- **完了条件:** `npm run watch:install` 後に
  (a) `npm run watch:status` が「タスク登録済み」と「鼓動 N秒前」の両方を表示する、
  (b) ログオフ→ログオンでウォッチャが動いている（コンソールウィンドウは出ない）、
  (c) ウォッチャのプロセスを強制終了すると、1〜2分後に自動で立ち上がり直す、
  (d) `npm run watch:uninstall` でタスクが消え、`watch:status` が「未登録」を表示する

## T11 バックアップ対象とドキュメント

- 触るファイル: `scripts/build-web.js`、`README.md`、`CLAUDE.md`
- やること: `backup` に `watch_log.json` を追加。README に自動反映の章
  （導入・止め方・動かないときの確認順）を書く。CLAUDE.md に前提と逃げ道を追記
- **完了条件:** `npm run build:web` 後に `npm run restore -- --out ./check` を実行すると
  `watch_log.json` が復元対象に含まれている。README だけを読んで
  導入から停止までを一通り実行できる

## T12 通しの動作確認

- 触るファイル: なし（確認のみ）
- やること: ウォッチャを起動した状態で、`imports/` に CSV、`給与明細/` に PDF、
  `d-カード/` に txt をそれぞれ置き、通知 → パネルで要確認を確定 → 再ビルドまでを通す
- **完了条件:** 一度も `npm run close` を叩かずに、置いたデータがダッシュボードへ反映され、
  要確認が 0 件になる。`data/watch_log.json` に一連の記録が残っている
