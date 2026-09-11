---
generated:
  id: data--kakei-manager--dd9ee897
  axis: データの寿命と移行耐性
  project: kakei-manager
  title: "start_month を上げると過去月のファイルが無確認で削除される"
  detector: ops-reviewer
  anchor: analysis.start_month
  priority: 高
  detectedAt: 2026-09-10T12:35:02.194Z
  targetFiles:
    - scripts/import-card.js
    - config.json
curated:
  status: draft
  statusReason: ""
  effort: low
  measure: 欠陥修正
  expected:
    metric: "欠陥が再現しないこと"
    direction: down
  repro: "再現手順で確かめる"
  specPath: ""
  branch: ""
  adoptedAt: null
sources:
  - "ops-reviewer: import-card.js 127-131 行で start_month より古い月を rmSync。確認も --dry-run もバックアップも無い"
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

`config.json` の `_note` は start_month の決め方を説明しており、今後カバー範囲を見直す前提の設定値。`2025-12` を `2026-01` に直して `npm run import` を打った瞬間、`data/transactions/2025-12.json`（29KB・実データ）が消える。

`data/` は Git 管理外なので git checkout では戻らず、直前に build:web が走っていれば docs/index.html も新しい範囲で上書きされている可能性がある。削除件数はログにも出ない。

## どう直すか

削除前にファイル名と件数・金額を表示し、`--prune` のような明示フラグが無ければ消さず警告だけにする。もしくは削除せず `data/archive/` へ移動する。

## 確かめたこと

<!-- 適用後にここへ書く -->
