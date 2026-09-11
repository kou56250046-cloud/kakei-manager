---
generated:
  id: data--kakei-manager--f71381f2
  axis: データの寿命と移行耐性
  project: kakei-manager
  title: "保存 JSON にバージョンが無く、形式変更で過去月が黙って誤読される"
  detector: ops-reviewer
  anchor: readAllTransactions
  priority: 高
  detectedAt: 2026-09-11T00:38:39.292Z
  targetFiles:
    - scripts/lib/io.js
curated:
  status: draft
  statusReason: ""
  effort: medium
  measure: 欠陥修正
  expected:
    metric: "欠陥が再現しないこと"
    direction: down
  repro: "取引レコードのキーを1つ改名し、過去月が例外なく読み込まれてしまうかを確かめる"
  specPath: ""
  branch: ""
  adoptedAt: null
sources:
  - "ops-reviewer: バージョン欄があるのは category_rules.json だけ。transactions/*.json は素の配列"
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
  - at: 2026-09-11T00:38:39.292Z
    change: restored（ID衝突で消えていたものを復元）
---

## 何が問題か

`readAllTransactions` は月ファイルを無検証で連結する。取引レコードのキーを1つ改名しただけで過去9ヶ月分は旧形式のまま残り、`ui/summary.js` で `undefined` が `?? 0` に落ちて**エラーにならず金額が消える。**

この事故は既に一度起きていて、`restore.js` に「⚠ このファイルは古く、分類ルールを含んでいません」という後付けの判定が入っている。同じことが取引本体で起きたときの検知手段が無い。

## どう直すか

月別ファイルを `{ schema: 1, transactions: [...] }` に包み、`readAllTransactions` で schema を読んで既知でなければ即座に止める。既存の素配列は schema: 0 とみなして自動で包み直す。incomes / balances / dcard_bills にも同じ欄を付ける。

## 確かめたこと

<!-- 適用後にここへ書く -->
