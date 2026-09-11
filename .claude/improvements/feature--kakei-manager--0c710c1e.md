---
generated:
  id: feature--kakei-manager--0c710c1e
  axis: 機能提案
  project: kakei-manager
  title: "献金だけ対話ステップが無く、累積未献金のタイルが読まれなくなる"
  detector: ui-reviewer-pm
  anchor: step5-tithe
  priority: 高
  detectedAt: 2026-09-10T12:35:02.194Z
  targetFiles:
    - scripts/close.js
    - ui/app.js
curated:
  status: draft
  statusReason: ""
  effort: medium
  measure: 利用ログ
  expected:
    metric: "献金タイルへの到達"
    direction: up
  specPath: ""
  branch: ""
  adoptedAt: null
sources:
  - "ui-reviewer-pm: close.js の step5/6 に献金が無い。titheByMonth が毎月自動加算し、消す手段は tithe.json の手編集だけ"
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

「累積未献金」はヒーロータイル5つのうち1つを占める。数字が増え続けるのを見て見ぬふりするようになり、**そのタイルを読まなくなる。1枚が死ぬと画面全体への信頼が落ちる。**

## どう直すか

close.js に step「献金を記録する」を追加。未納月と計算額を出して y/Enter/金額 で data/tithe.json に書く。手編集2分＋再ビルドが Enter 1回になる。

## 確かめたこと

<!-- 適用後にここへ書く -->
