# フォルダ投入だけで家計アプリへ自動反映する — 設計

## 全体像

```
imports/ 給与明細/ d-カード/
        │ ファイル追加
        ▼
  scripts/watch.js（常駐・1プロセス）
        ├─ ① fs.watch → デバウンス3秒 → サイズ安定待ち
        ├─ ② lib/pipeline.js を実行（取込〜build〜build:web）
        ├─ ③ lib/notify.js でトースト通知
        ├─ ④ data/watch_log.json に追記
        └─ ⑤ lib/panel-server.js を 127.0.0.1 で常時listen
                  │
                  ▼  ブラウザ http://127.0.0.1:4649/
           dist/index.html（トークンを注入して配る）
                  │  要確認カードで分類を選ぶ
                  ▼  POST /api/classify
           data/category_rules.json / transactions/*.json を更新 → 再ビルド
```

`npm run close`（対話版）は従来どおり残る。`pipeline.js` を共用するだけ。

## データ構造

### 新規：`data/watch_state.json`（実装中に追加）

```jsonc
{ "files": { "imports/xxxx.csv": "4016:1789366345732" }, "updatedAt": "…" }
```

値は「サイズ:更新時刻」。**イベントではなく中身で実行を判断する。**

実装して動かしたところ、`fs.watch` は取り込みがフォルダを読んだだけで
全ファイル分のイベントを出し、**1回の投入が次の実行を呼ぶ**状態になった
（実測：1ファイルの投入で全22ファイルが再検知された）。
署名が前回と同じファイルは無視することで止めている。

同じ仕組みが「止まっている間に置かれたファイル」を起動時に拾う役目も果たす。

> Windows の `copyFile` は最終更新時刻も引き継ぐ。そのため
> 「同じファイルを同じ場所にコピーし直す」と署名が変わらず、実行されない。
> 中身が同じなら取り込む必要がないので、これは意図どおり。

### 新規：`data/watch_log.json`

実行の履歴。追記のみ。

```jsonc
[
  {
    "at": "2026-09-14T10:32:05.123Z",   // 実行開始時刻（ISO8601・UTC）
    "trigger": ["imports/xxxx.csv"],    // 検知したファイル（相対パス）
    "seconds": 12,                      // 所要秒（整数）
    "ok": true,                         // 全ステップ成功したか
    "failed_step": null,                // 失敗したスクリプト名（成功時 null）
    "added": 37,                        // 新規に増えた取引件数
    "pending": 2,                       // 実行後に残る要確認件数
    "mismatch": 0                       // 検算不一致のファイル数
  }
]
```

`build-web.js` の `backup` 対象にこのファイルを**追加する**
（入れ忘れると `npm run restore` で復元できない）。

**直近 200 件で打ち切る**（追記時に古いものから捨てる）。
`close_log.json` と違って投入のたびに増えるうえ、この JSON は
暗号化バックアップに毎回同梱されるため、無制限に伸ばすと `docs/index.html` が太る。
200 件あれば数か月分の履歴が残り、「いつから動いていないか」の判断には足りる。

### 新規：`config.json` に `panel` を追加

```jsonc
"panel": {
  "port": 4649,         // 使用中なら +1 を最大10回試す
  "open_browser": false // 起動時にブラウザを開くか
}
```

### 新規：`.watch.lock`（リポジトリ直下・`.gitignore`）

```jsonc
{ "pid": 12345, "startedAt": "2026-09-14T10:30:00.000Z", "port": 4649,
  "beatAt": "2026-09-14T10:41:00.000Z", "busy": false }
```

起動時に既存ロックを読み、`process.kill(pid, 0)` で生存を確認する。
生きていれば「既に動いています」と出して終了、死んでいればロックを奪う
（PC の強制終了後に起動できなくなるのを防ぐ）。

`beatAt` は**1分ごとに更新する鼓動**。`pid` の生存確認だけでは、PID が別プロセスに
再利用された場合に誤判定するため、「鼓動が3分以内か」も併せて見る。
`busy` はパイプライン実行中に立てる。

**このロックは 3 つの入口すべてが参照する。**

| 入口 | ロックが生きているときの動き |
|---|---|
| `npm run watch` | 「既に動いています（PID / URL）」と出して終了 |
| `npm run panel` | 「ウォッチャに内蔵のパネルがあります → http://127.0.0.1:4649/」と案内して終了 |
| `npm run close` | **中止する。** 「ウォッチャが動いています。止めてから実行するか `--force` を付けてください」と出す |

**なぜ close.js まで止めるのか** — `writeJson` をアトミックにしてもファイル破損が
防げるだけで、2 つのプロセスが同時に「読む → 変える → 書き戻す」と
後から書いた方が相手の変更を消す（ロストアップデート）。
両者とも `readAllTransactions()` → `writeTransactionsByMonth()` を行うため、
これは実際に起こりうる。`--force` は逃げ道として残すが、既定では止める。

### 変更：既存の取引レコード

**フィールドは増やさない。** パネルからの確定は、既存の
`category` / `subcategory` / `needs_review` / `confidence` / `manual_override`
を `set-category.js` と同じ形で書き換えるだけ。既存データの移行は不要。

## 処理の流れ

### ① 検知（`scripts/watch.js`）

```
fs.watch(dir) × 3
  → 対象拡張子か判定（imports=.csv / 給与明細=.pdf / d-カード=.txt）
  → 候補セットに追加、デバウンスタイマを3秒に再設定
  → タイマ発火：候補それぞれをサイズ安定待ち
       700ms 間隔でサイズを見て、2回連続で同値なら「安定」
       30秒たっても安定しなければその回は見送る（次のイベントで拾う）
  → パイプライン実行
```

**なぜ安定待ちが要るか** — ブラウザのダウンロードやエクスプローラのコピーは
サイズ0のファイルを先に作る。そのまま読むと空の CSV を
「0行・検算不一致」として取り込んでしまう。

`fs.watch` は Windows で同一操作に対して複数回発火する。デバウンスで1回にまとめる。

**実行中に来たイベント** — `running` フラグが立っている間はキューに積むだけにし、
完了後に1回だけ再実行する（`rerun` フラグ）。何度置かれても再実行は1回。

### ② 実行（`scripts/lib/pipeline.js` ← 新規）

`close.js` のステップ1〜4・7を関数として切り出す。close.js と watch.js が共用する。

```js
runPipeline(scripts, { onStep })
  → import-card.js → import-payslip.js → import-dcard.js → generate-fixed.js   (IMPORT_STEPS)
  → build.js → build-web.js                                                     (BUILD_STEPS)
  → { ok, failedStep, exitCode, steps: [...] } を返す
```

**ウォッチャは2段に分けて呼び、間で `watch_log.json` を書く。**
`build.js` は画面に出す「最後の自動反映」をこのファイルから読むため、
一息に流すと**毎回1回ぶん古い日時**が表示される（実装中に発覚）。

- **途中で失敗したら、そこで止めて結果を返す**（後続は走らせない）
- **`build-web.js` の失敗も `ok: false` として扱う。** 現在の `close.js` は
  ここを握りつぶしており、唯一のバックアップが黙って古くなる
  （改善候補 `data--kakei-manager--03bd7fd3`）。無人運用ではこれが致命的になるため
  通知に出す。ただし**取込結果は失われないので、前段の成功は成功として記録する**

### ③ 件数の算出

各スクリプトの標準出力を parse しない（書式に依存すると静かに壊れる）。
**実行の前後で `data/` を読み直して差分を取る。**

```
実行前： before = readAllTransactions().length
実行後： after  = readAllTransactions().length
         pending  = after のうち needs_review の件数
         mismatch = import_log.json の status === 'MISMATCH' の件数
added = after - before
```

### ④ 通知（`scripts/lib/notify.js` ← 新規）

PowerShell の WinRT トースト API を使う。外部モジュール（BurntToast 等）は入れない。

```
node → spawn('powershell', ['-NoProfile','-NonInteractive','-Command','-'])
     → スクリプトを stdin で流し込む
```

- **値は引数や文字列補間で渡さず、環境変数で渡す**
  （`$env:KAKEI_TOAST_TITLE` / `$env:KAKEI_TOAST_BODY`）。
  グローバル規約「PowerShell の二重引用符に `$()` を埋めない」に従い、
  店名に含まれる記号でスクリプトが壊れるのを防ぐ
- XML に入れる前に `[System.Security.SecurityElement]::Escape()` を通す
- AppId は PowerShell 既定の
  `{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe`
- **通知に失敗してもウォッチャは止めない。** コンソールに同じ内容を出し、
  `watch_log.json` には残す（通知が出ないことより、取込が止まる方が損害が大きい）

通知の文面:

| 状況 | タイトル | 本文 |
|---|---|---|
| 成功・要確認なし | 家計に反映しました | 新規 37件 / 要確認 なし |
| 成功・要確認あり | 家計に反映しました | 新規 37件 / 要確認 2件 — http://127.0.0.1:4649/ |
| 検算不一致 | 家計に反映しました（検算 ⚠） | 新規 37件 / 不一致 1ファイル |
| 失敗 | 家計への反映に失敗 | import-card.js が終了コード 1 で停止 |

### ⑤ 確定パネル（`scripts/lib/panel-server.js` ← 新規）

`http` モジュールのみ。`claude-manager/src/serve/server.ts` のトークン方式と
`readBody`、`weather-analysis/scripts/serve.js` の静的配信を参考に、素の JS で書く。

**配信**

- `127.0.0.1` にのみ bind（`server.listen(port, '127.0.0.1')`）。LAN からは繋がらない
- `Host` ヘッダが `127.0.0.1:<port>` / `localhost:<port>` 以外なら 403
  （DNS rebinding 対策）
- `GET /` → `dist/index.html` を読み、`</head>` の直前に
  `<script>window.PANEL = { token: "…", port: … };</script>` を**注入して**返す
  - **トークンはファイルに書かない。** プロセス起動ごとに `randomUUID()` で作る。
    よって `dist/index.html` 自体は今までどおり `file://` で開け、git にも載らない
- それ以外のパスは 404（単一 HTML なので静的ファイルを配る必要がない）

**API**

```
POST /api/classify
  { token, mode: "rule" | "once", key, category, subcategory, display?, pattern?, note? }
```

| mode | 処理 |
|---|---|
| `rule` | `category_rules.json` に追記。**既にそのキーに当たるルールがあれば、その前に挿入**（配列は先勝ちのため）。`close.js:181-186` と同じロジックを共用する。その後 `reclassify.js --all` → `build.js` → `build-web.js` |
| `once` | 該当 `merchant_key` の取引に `category` / `subcategory` / `needs_review:false` / `confidence:'high'` / `manual_override:true` を立て、`writeTransactionsByMonth` で書き戻す。その後 `build.js` → `build-web.js`（再分類は不要） |

- 応答 `{ ok, detail, backedUp, pending }`。ブラウザ側は成功したら `location.reload()`
- トークン不一致・`Origin` が自分以外・body 64KB 超 は 400 / 403 で弾く
- **書き込みは実際には `spawnSync` がイベントループごと止めるため、
  同時に投げても順番に処理される**（実測：2件同時で 200 / 200、競合なし）。
  ミューテックスは、将来この処理を非同期に変えたときの歯止めとして残す
- ウォッチャが動いている間（検知からパイプライン完了まで）は 409 を返し、
  ブラウザに「取り込み中です」と出す（同じ JSON を同時に書かないため）

**UI（`ui/app.js` の `renderReview` を拡張）**

```js
const canEdit = typeof PANEL !== 'undefined' && PANEL.token
  && location.protocol === 'http:'
  && (location.hostname === '127.0.0.1' || location.hostname === 'localhost');
```

- `canEdit` が false のとき（`file://` で開いた `dist`、および `https` の `docs`）は
  **現在とまったく同じ読み取り専用テーブル**を描く。既存の見え方を壊さない
- `canEdit` が true のときだけ、各行に
  「ルールにする / この1件だけ / 後で」＋カテゴリ選択＋中分類入力＋確定ボタンを出す
- カテゴリの候補は `DATA` に既に入っている取引から組み立てる
  （`category_rules.json` は HTML に埋め込まれていないため）
- **`ui/` のコードは `docs/index.html` に平文で載る。**
  実際の金額・店名をコメントに書かない

### ⑥ スタートアップ登録（`scripts/install-watcher.js` ← 新規）

**Windows タスクスケジューラの「ログオン時」タスクとして登録する。**

```
npm run watch:install     → schtasks /create /tn "家計ウォッチャ" /sc onlogon ...
npm run watch:uninstall   → schtasks /delete /tn "家計ウォッチャ" /f
npm run watch:status      → schtasks /query /tn "家計ウォッチャ"
```

- `/tr` に直接長いコマンドを書くとクォートで壊れるため、
  `scripts/watch-run.cmd`（生成物）を挟み、タスクはそれを指す
- タスクスケジューラ経由の起動は**コンソールウィンドウが出ない**。
  スタートアップフォルダに `.cmd` を置く方式だと最小化ウィンドウが残り、
  `.vbs` は Windows から段階的に削除される予定のため、どちらも採らない
- 標準出力は `data/watch.out.log` に追記（1MB を超えたら 1 世代だけ退避）

**落ちたときに立て直す**

`/sc onlogon` だけでは、ウォッチャが異常終了しても次のログオンまで復帰しない。
再起動の設定は `schtasks /create` のフラグでは指定できないため、
**タスク定義 XML を生成して `/xml` で登録する**。

**`RestartOnFailure` は当てにしない（実測）。** ウォッチャを強制終了して
1分20秒待っても復帰せず、`LastTaskResult` は 1、`State` は `Ready`、
`NextRunTime` は空のままだった。Windows のこの設定は主に
「タスクの起動そのものに失敗した場合」のもので、起動したプログラムが
落ちた場合には効かない。

代わりに**30分ごとの定期トリガ**で起こし直す。

```xml
<TimeTrigger>
  <Repetition>
    <Interval>PT30M</Interval>
    <StopAtDurationEnd>false</StopAtDurationEnd>
  </Repetition>
  <StartBoundary>2026-01-01T00:00:00</StartBoundary>
</TimeTrigger>
```

既に動いていれば `MultipleInstancesPolicy=IgnoreNew` で何も起きず、
すり抜けてもウォッチャ自身が在席票を見て即座に終わる。**落ちていたときだけ立ち上がる。**
最大30分の空白が出るが、起動時に「止まっている間に置かれたファイル」を拾うので
取りこぼしにはならない（1分間隔に縮めて復帰を実測済み）。

あわせて `<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>`（ノート PC で
バッテリ駆動時に止められないように）と、実行時間の上限なし
（`<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>`。既定の 72 時間で殺されると常駐にならない）
を入れる。

**それでも落ちたことに気づく手段**（監視プロセスは作らない）:

| 手段 | 何が分かるか |
|---|---|
| `npm run watch:status` | タスクの登録状態と、`beatAt` の鮮度（例「動作中（鼓動 12 秒前）」「停止中（最終鼓動 3日前）」） |
| ダッシュボードの「最後の自動反映」 | `watch_log.json` の末尾を `build.js` が `DATA` に載せ、ヘッダに日時を出す |

### ⑦ `writeJson` をアトミックにする（`scripts/lib/io.js`）

```js
writeFileSync(path + '.tmp', text); renameSync(path + '.tmp', path);
```

無人実行とパネルからの書き戻しで書き込み回数が増え、
中断時に JSON が壊れる確率が上がる。同一ボリューム内の `rename` は
アトミックなので、これだけで「壊れた JSON が残る」経路を塞げる
（改善候補 `data--kakei-manager--4ea6f229`）。

## 触るファイル

| ファイル | 変更内容 |
|---|---|
| `scripts/watch.js` | **新規**。fs.watch・デバウンス・安定待ち・ロック・パイプライン実行・通知・ログ追記・パネル常駐 |
| `scripts/lib/pipeline.js` | **新規**。取込〜ビルドの一連を関数化。close.js と watch.js が共用 |
| `scripts/lib/notify.js` | **新規**。PowerShell 経由の Windows トースト通知 |
| `scripts/lib/panel-server.js` | **新規**。127.0.0.1 限定の HTTP サーバとトークン発行・`/api/classify` |
| `scripts/lib/classify-apply.js` | **新規**。「ルール追加」「1件確定」の書き戻しを1か所に。close.js・set-category.js・panel から呼ぶ |
| `scripts/panel.js` | **新規**。パネルだけを単体起動する入口（`npm run panel`） |
| `scripts/install-watcher.js` | **新規**。schtasks への登録・解除・状態確認 |
| `scripts/close.js` | ステップ1〜4・7を `pipeline.js` に置き換え。**対話部分は変えない**。build-web の失敗を握りつぶさない。起動時に `.watch.lock` を見て、ウォッチャ稼働中は中止（`--force` で続行） |
| `scripts/lib/lock.js` | **新規**。`.watch.lock` の取得・解放・生存判定・鼓動。watch / panel / close の3つが使う |
| `scripts/lib/io.js` | `writeJson` をアトミック書き込みに変更 |
| `scripts/build.js` | `DATA` に `watchLog` の末尾（最後の自動反映の日時と結果）を1件だけ載せる |
| `scripts/build-web.js` | `backup` 対象に `watch_log.json` を追加 |
| `ui/app.js` | `renderReview` に確定 UI を追加（`canEdit` が真のときだけ）。バナーの案内文をパネルの URL に更新 |
| `ui/style.css` | 確定 UI の見た目（セレクト・ボタン・行の展開） |
| `config.json` | `panel` セクションを追加 |
| `package.json` | `watch` / `panel` / `watch:install` / `watch:uninstall` / `watch:status` を追加 |
| `.gitignore` | `.watch.lock` / `data/watch.out.log` / `scripts/watch-run.cmd` を追加 |
| `README.md` | 自動反映の章を追加（導入手順・止め方・動かないときの確認順） |
| `CLAUDE.md` | 自動化の前提と、壊れたときの逃げ道を追記 |

## 検討した代替案

| 案 | 採らなかった理由 |
|---|---|
| タスクスケジューラで1日1回ポーリング | 置いてから反映まで最大24時間かかる。「置いたら終わっている」にならない |
| ウォッチャが `close.js --yes` を呼ぶ | close.js は対話・残高入力・`close_log.json` への記録を持つ。無人実行の記録と混ざり「締めの所要時間」の指標が汚れる。共通部を `pipeline.js` に切り出す方が素直 |
| 標準出力を parse して件数を得る | 出力書式を変えた瞬間に静かに壊れる。`data/` を読み直す方が確実 |
| 確定パネルを独立した専用ページにする | 要確認の判断には金額・過去の傾向・同じ月の他の支出が要る。ダッシュボードから切り離すと判断材料が減る |
| `dist/index.html` にトークンを書き込む | `file://` で開いたときにトークンが漏れ、git に載る可能性もある。**サーバが配信時に注入する**方式ならファイルは無変更のまま |
| `docs/`（Pages 公開版）でも確定できるようにする | 公開サイトから家計データを書き換える経路を作ることになる。作らない |
| 未知の店を部分一致で自動推測 | 静かに誤分類が混ざり、集計が信用できなくなる。要確認のまま残す方が安全 |
| スタートアップフォルダに `.vbs` を置く | VBScript は Windows から段階的に削除予定。タスクスケジューラなら停止・状態確認も同じ仕組みでできる |
| `chokidar` などの監視ライブラリ | 依存パッケージゼロの原則に反する |
| ウォッチャ稼働中の `close.js` を「警告して続行」にする | 警告は読み飛ばされる。後勝ちで書き戻した側が相手の変更を消すため、既定は中止が正しい。意図的に押し通したいときのために `--force` を残す |
| ウォッチャの生存を見張る常駐プロセスを別に立てる | 見張り役が落ちたら誰が見るのかという同じ問題が1段ずれるだけ。タスクスケジューラの再起動設定に任せ、気づく手段（`watch:status` と「最後の自動反映」表示）を用意する方が安い |
| ロックを PID の生存確認だけで判定する | PID は再利用される。停止後に別プロセスが同じ PID を取ると「動いている」と誤判定し、永久に起動できなくなる。鼓動の鮮度と併用する |
