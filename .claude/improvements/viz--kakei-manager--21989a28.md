---
generated:
  id: viz--kakei-manager--21989a28
  axis: 可視化
  project: kakei-manager
  title: "日別カレンダーが明細範囲外の日を「使わなかった日」として数え、表示する"
  detector: viz-reviewer
  anchor: dailyTotals
  priority: 高
  detectedAt: 2026-09-10T12:35:02.194Z
  targetFiles:
    - ui/app.js
    - ui/summary.js
curated:
  status: draft
  statusReason: ""
  effort: medium
  measure: 欠陥修正
  expected:
    metric: "欠陥が再現しないこと"
    direction: down
  repro: "範囲外の日を「使わなかった日」と数える。2026-08 で 8/11 以降が除外されるかを確かめる"
  specPath: ""
  branch: ""
  adoptedAt: null
sources:
  - "viz-reviewer: dailyTotals は月の日数ぶんセルを作り、取引が無い日を一律 amount: 0 にする。zeroDays = days - spent.length"
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

範囲外の日と本当に使わなかった日が区別されない。2026-08 では 8/11〜8/31 の21日が「使わなかった日」として cal-head に数字で出る。ヒートマップも白いマスとして敷き詰められ、「後半ぱったり使わなかった月」に見える。

これは推測ではなく**事実として断言している文**なので、hero の過小表示より嘘の度合いが強い。

## どう直すか

dailyTotals に明細のカバー範囲（usage_from / usage_to）を渡し、範囲外のセルに outOfRange フラグを立てる。範囲外は0円マスではなく無地のマスとして描き、「使わなかった日」の計数から外す。カード下に「8/11以降は明細が未取込」と1行。

## 確かめたこと

<!-- 適用後にここへ書く -->
