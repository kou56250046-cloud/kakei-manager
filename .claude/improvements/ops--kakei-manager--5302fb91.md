---
generated:
  id: ops--kakei-manager--5302fb91
  axis: 運用性
  project: kakei-manager
  title: "CSV の列構成が変わると 0 行取込のまま正常終了する"
  detector: ops-reviewer
  anchor: parseMeisai
  priority: 高
  detectedAt: 2026-09-10T12:35:02.194Z
  targetFiles:
    - scripts/lib/parse-meisai.js
curated:
  status: draft
  statusReason: ""
  effort: low
  measure: 欠陥修正
  expected:
    metric: "欠陥が再現しないこと"
    direction: down
  repro: "CSV 構造破綻を検知できない。列を1つずらした CSV で例外が出るかを確かめる"
  specPath: ""
  branch: ""
  adoptedAt: null
sources:
  - "ops-reviewer: 列が1つ挿入されるとヘッダ判定は通り、amount = toInt(c[6]) が全行 null を返して continue される"
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

結果 rows は空、detailSum は 0、diff = -billed で MISMATCH になるが、**設計上 MISMATCH は続行**であり README も警告の軽視を推奨している。取込は「新規 0件 / スキップ 0件」で exit 0、close.js も update も最後まで通り、ダッシュボードは先月までの数字で正常に見える。「今月は取り込み済みだったのか」と誤解して先へ進む。

## どう直すか

`parseMeisai` に「ヘッダは見つかったが有効行が0件」の分岐を追加し、この場合だけ例外にする。返品しかない月でも1行は出るため、0件は構造変化とみなして安全。あわせて import_log.json の MISMATCH を、差額が請求額の一定割合を超えたら別ステータスにする。

## 確かめたこと

<!-- 適用後にここへ書く -->
