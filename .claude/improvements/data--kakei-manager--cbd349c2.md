---
generated:
  id: data--kakei-manager--cbd349c2
  axis: データの寿命と移行耐性
  project: kakei-manager
  title: "取引 id が merchant_key を含み、正規化を触ると全履歴が重複計上される"
  detector: ops-reviewer
  anchor: merchantKey
  priority: 高
  detectedAt: 2026-09-10T12:35:02.194Z
  targetFiles:
    - scripts/lib/normalize.js
    - scripts/import-card.js
curated:
  status: draft
  statusReason: ""
  effort: medium
  measure: 欠陥修正
  expected:
    metric: "欠陥が再現しないこと"
    direction: down
  repro: "再現手順で確かめる"
  specPath: ""
  branch: ""
  adoptedAt: null
sources:
  - "ops-reviewer: id は `${date}-${merchantKey(raw)}-${amount}-${n}`。重複判定は byId.has(id) のみ"
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

id が正規化済みキーを含むため、`merchantKey` の規則を1文字でも変えると同じ CSV の同じ行から別の id が生まれ、旧 id と共存したまま両方が書き出される。README は全 CSV の再読込を推奨しているので、次回 `npm run import` で全期間が二重計上される。

`.claude/CLAUDE.md` は正規化規則のチューニング経緯を詳しく残しており、**将来また触る前提の場所**になっている。`manual_override` と `category_rules.json` も merchant_key 基準なので、手で確定した分類も全部外れる。

## どう直すか

id の材料から正規化済みキーを外し、CSV の原文（merchant_raw）のハッシュを使う。既存データには移行時に旧 id を併記して照合できるようにする。あわせて import-card.js に「新規件数が既存件数と同オーダーなら警告」のガードを入れる。

## 確かめたこと

<!-- 適用後にここへ書く -->
