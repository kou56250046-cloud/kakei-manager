---
generated:
  id: dashboard--kakei-manager--f929e87e
  axis: ダッシュボード
  project: kakei-manager
  title: "「今いくら使っていいか」が3つの別カードに散っていて突き合わされていない"
  detector: ui-reviewer-pm
  anchor: spendableNow
  priority: 高
  detectedAt: 2026-09-10T12:35:02.194Z
  targetFiles:
    - ui/summary.js
    - ui/app.js
curated:
  status: draft
  statusReason: ""
  effort: medium
  measure: 欠陥修正
  expected:
    metric: "欠陥が再現しないこと"
    direction: down
  repro: "不完全な月で過小な額が無警告で出る。2026-08 を選んで警告が出るかを確かめる"
  specPath: ""
  branch: ""
  adoptedAt: null
sources:
  - "ui-reviewer-pm: accountBalances / settlementRisk / titheRows の3つとも計算済みだが別カードに置かれている"
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

生活費口座の残高、次回引落額、累積未献金の3つが計算済みなのに、別々のカードにばらばらに置かれている。

残高 − 引落 − 未献金を毎回頭で引き算させている。面倒なので暗算をやめ、結局**「残高だけ見て終わり」**になる。このツール唯一の行動判断が機能していない。

## どう直すか

ui/summary.js に spendableNow() を足し、ヒーロー先頭に「今使えるお金＝生活費残高 −次回引落 −未献金」を1タイル置く。既存3タイルは残さず置換する。

## 確かめたこと

<!-- 適用後にここへ書く -->
