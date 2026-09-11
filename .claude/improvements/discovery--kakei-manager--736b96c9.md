---
generated:
  id: discovery--kakei-manager--736b96c9
  axis: 発見性
  project: kakei-manager
  title: "画面のバナーが npm run close を一度も案内せず、旧・手動JSON編集手順に誘導する"
  detector: ui-reviewer-pm
  anchor: renderBanner
  priority: 高
  detectedAt: 2026-09-10T12:35:02.194Z
  targetFiles:
    - ui/app.js
curated:
  status: draft
  statusReason: ""
  effort: low
  measure: 利用ログ
  expected:
    metric: "締めの実行回数"
    direction: up
  specPath: ""
  branch: ""
  adoptedAt: null
sources:
  - "ui-reviewer-pm: ui/app.js:357 / :375 / :401 が「balances.json に追記して npm run update」「category_rules.json に追記して npm run review -- --all」を指す"
evidence: []
baseline:
  capturedAt: null
  mode: ""
  metrics: {}
after:
  capturedAt: null
  mode: ""
  metrics: {}
verdict: null
history:
  - at: 2026-09-10T12:35:02.194Z
    change: detected
---

## 何が問題か

close.js が置き換えたはずの旧・手動 JSON 編集ルートを、画面が案内し続けている。

半年ぶりに開いた本人は README ではなく**画面の指示に従う。** そこで14ステップの旧手順に戻され、**その月の締めごと放棄する。** ui-reviewer-pm が「最大の離脱リスク」と判定した箇所。

## どう直すか

バナー文言3か所を `npm run close` に統一し、JSON 手編集の記述を削除する。文字列の変更だけで済む。

## 確かめたこと

<!-- 適用後にここへ書く -->
