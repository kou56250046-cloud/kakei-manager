# 公開版（docs/）の自動コミット・プッシュ — 設計

## データ構造

### config.json（追加）

```json
"publish": {
  "auto_push": true,
  "_note": "ウォッチャと確定パネルが docs/ の生成物だけを自動でコミットし origin/main にプッシュする。false で無効"
}
```

`remote` と `branch` は設定にしない（`origin` / `main` 固定。非目標参照）。

### watch_log.json のエントリ（1項目追加）

```ts
type WatchLogEntry = {
  at: string; trigger: string[]; seconds: number;
  ok: boolean; failed_step: string | null;
  added: number; pending: number; mismatch: number;
  // 追加。古いエントリには無い（読む側は undefined を許す）
  // 'pending' はプッシュ完了前の暫定値。完了時に同じ at のエントリを書き換える
  publish?: PublishStatus | 'skipped' | 'pending';
};
```

`restore.js` と `build.js` は `watch_log.json` を中身を解釈せずに運ぶだけなので、
移行処理は要らない。

### publish の結果

```ts
type PublishStatus =
  | 'pushed'         // プッシュした
  | 'no_change'      // 差分も未プッシュのコミットも無い
  | 'disabled'       // publish.auto_push が false
  | 'not_main'       // main 以外のブランチ
  | 'blocked'        // 未プッシュに許可リスト外のパスを変えたコミットがある
  | 'commit_failed'
  | 'push_failed';

type PublishHandle = {
  committed: Promise<void>;          // コミット区間が終わったら解決（成否を問わない）
  result: Promise<{ status: PublishStatus; detail?: string }>;  // 全体の結果
};
```

`detail` は git の stderr の末尾 1 行（通知の1行目に使う）。git のエラー文にはパスと
リモート URL しか出ないため、家計の情報は含まれない。

## 処理の流れ

新しいモジュール `scripts/lib/publish.js` に閉じ込める。

```
startPublish(reason) → PublishHandle
  （前の publish が終わるまで待つ：Promise の鎖で直列化）
  config.publish.auto_push が false → 'disabled'
  git rev-parse --abbrev-ref HEAD が main でない → 'not_main'
  ── コミット区間（committing = true）──────────
  git add -- <許可リスト>
  git diff --cached --quiet -- <許可リスト>
     差分あり → git commit -m "自動反映（…）" -- <許可リスト>
                 失敗 → 'commit_failed'
  ── ここまで（committing = false, committed を解決）──
  git rev-list origin/main..HEAD が空 → 'no_change'
  git diff --name-only origin/main HEAD に許可リスト外のパスがある → 'blocked'
  git push origin main
     成功 → 'pushed' / 失敗・90秒超過 → 'push_failed'
```

- **`git commit -- <paths>`（pathspec 付き）で呼ぶ。** 作業ツリーやインデックスに
  他の変更があっても、許可リストのファイルだけがコミットに入る
- **差分が無くても push は試みる。** 前回 push に失敗して残ったコミットを、ここで一緒に送るため
- **`blocked` の判定は `origin/main` と `HEAD` の差分のパス一覧で行う。** 人が
  `scripts/` をコミットして未プッシュのまま置いていれば、自動公開はそれが解消されるまで止まる
- `git` はすべて `spawn`（非同期）で呼ぶ。環境変数
  `GIT_TERMINAL_PROMPT=0` / `GCM_INTERACTIVE=never` で対話を禁止し、
  **呼び出し1回ごとに**90 秒のタイムアウトを付けて超えたら kill する
- `origin/main` はリモート追跡ブランチ（最後の fetch/push 時点）を見る。fetch はしない。
  リモートが先に進んでいれば push が non-fast-forward で失敗し、`push_failed` になる

### 生成とコミットが重ならないようにする

`build-web.js` が `docs/` を書いている最中に `git add` が走ると、書きかけのファイルを
コミットし得る。

- **パネル**: 書き込み要求の受付判定に `isCommitting()` を加える。コミット区間の間だけ 409 を返す
- **ウォッチャ**: `runOnce` は取り込みの前に `await idle()`（進行中の publish のコミット区間が
  終わるのを待つ）。プッシュ区間は作業ツリーを触らないので待たない

### 平文混入チェックを書き出しの前へ移す（build-web.js）

現状は `docs/index.html` を書き出した後に点検し、落ちたら exit 1 する。そのため
**平文入りのファイルが作業ツリーに残り**、後の publish（起動時・パネル）が拾い得る。

点検（現 258-285 行）を書き出し（現 151 行）の前へ移し、落ちたら何も書かずに exit 1 する。
点検の中身は変えない。これで作業ツリーの `docs/index.html` は常に「点検を通ったもの」になる。

### 呼び出し元

| 呼び出し元 | タイミング | 待ち方 |
|---|---|---|
| `watch.js` `runOnce` | BUILD_STEPS 成功後 | `committed` だけ await（`running` は真のまま）。その後 `running` を偽にして戻る。`result` は then で受け、watch_log の同じ `at` のエントリの `publish` を書き換え、失敗ならトースト |
| `watch.js` `runOnce` | 取り込み・ビルドが失敗した回 | 呼ばない。`publish: 'skipped'` |
| `panel-server.js` `classify` / `balance` | `build-web.js` 成功時に `schedulePublish(reason)`。**最後の予約から60秒**で発火（予約し直すたびに数え直す） | 応答は待たない。結果はコンソールに1行、失敗ならトースト |
| `watch.js` 起動時 | 起動の**2分後**に1回（`catchup`）。ログオン直後はネットワークと資格情報がまだ整っていないことがあるため | 結果はコンソールに1行、失敗ならトースト |

`running` を偽にするのは現状の `flush` の finally なので、`runOnce` が `committed` を待って戻れば
自然にそうなる。プッシュ中に次の `flush` が来たら、`runOnce` → `idle()` で即座に通過する
（コミット区間ではないため）。次の publish 自体は直列化の鎖で前のプッシュを待つ。

### コミットメッセージ（定型文のみ）

| reason | メッセージ |
|---|---|
| import | `自動反映（取込）` |
| classify | `自動反映（分類の確定）` |
| balance | `自動反映（残高）` |
| catchup | `自動反映（未反映分）` |

デバウンス中に別の reason が来たら後の方を使う。本文や日時は付けない。

### 通知

既存の成功トースト（`report`）は変えない。publish の結果は別に出す。

| 結果 | 通知 |
|---|---|
| `pushed` / `no_change` / `disabled` | 通知しない |
| `not_main` | 通知しない（作業ブランチでの実行は想定内）。コンソールに1行 |
| `blocked` | トースト「公開版の更新を見送りました」／「docs/ 以外の未プッシュのコミットがあります」／「git push を手動で行ってください」 |
| `push_failed` / `commit_failed` | トースト「公開版の更新に失敗」／`detail`／「次の自動反映で再試行します」 |

## 触るファイル

| ファイル | 変更内容 |
|---|---|
| `scripts/lib/publish.js` | **新規**。`startPublish` / `schedulePublish`（デバウンス）/ `isCommitting` / `idle` / `ALLOWLIST` |
| `scripts/build-web.js` | 平文混入チェックを書き出しの前へ移す（点検内容は変えない） |
| `scripts/watch.js` | `runOnce` で idle 待ちと publish、ログの `publish`、起動2分後の catchup、失敗トースト |
| `scripts/lib/panel-server.js` | `classify` / `balance` の `build-web.js` 成功後に `schedulePublish`。受付判定に `isCommitting` |
| `config.json` | `publish.auto_push: true` を追加 |
| `CLAUDE.md` | 「自動反映」節に自動公開と壊しやすいところを追記、月次運用の手順 7 を更新 |
| `.claude/specs/auto-ingest/requirements.md` | 非目標「git commit / push は自動化しない」に、本仕様で改めた旨の注記 |

## 検討した代替案

| 案 | 採らなかった理由 |
|---|---|
| `git add -A` でまとめてコミット（close.js と同じ） | 作業中の `scripts/` などを無人で公開リポジトリに出す。許可リスト方式の規約にも反する |
| 人の未プッシュのコミットも一緒に push する | 作業途中のコードや、`ui/` に金額コメントを書いたコミットが無人で公開される。`git add -A` を退けたのと同じ理由 |
| `docs/` のコミットだけを cherry-pick して別に push する | 履歴が分岐し、次に人が push するときに衝突する。無人で扱う範囲を超える |
| publish.js 側でも平文混入を再点検する | 点検には `data/` 全体が要り、build-web.js の処理を二重に持つことになる。書き出し前に点検すれば作業ツリーに平文が残らないので足りる |
| `docs/index.html` の差分で「変化あり」を判定する | IV が毎回変わるため、データが同じでも暗号文は必ず変わる。代わりに「ウォッチャ・パネルが実際に書いた回だけ publish する」ことで空打ちを防ぐ |
| `spawnSync` で git を呼ぶ | push が数十秒かかるとイベントループが止まり、鼓動（3分で死票）とパネル応答が止まる |
| runOnce で push まで await する | push が詰まると `running` が真のまま数分続き、パネルが「取り込み中」を返し続ける |
| GitHub Actions 側でビルドする | 平文の `data/` を GitHub に置くことになる |
| push 失敗時に `git pull --rebase` して再 push | 衝突時に作業ツリーを壊す。無人で解決してよい問題ではない |
