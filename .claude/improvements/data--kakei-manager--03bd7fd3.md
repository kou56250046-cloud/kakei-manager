---
generated:
  id: data--kakei-manager--03bd7fd3
  axis: データの寿命と移行耐性
  project: kakei-manager
  title: "close.js が build-web.js の失敗を握りつぶし、唯一のバックアップが黙って古くなる"
  detector: ops-reviewer
  anchor: step7-buildWeb
  priority: 高
  detectedAt: 2026-09-10T12:35:02.194Z
  targetFiles:
    - scripts/close.js
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
  - "ops-reviewer: close.js 238-240 行で try/catch し、失敗しても1行の警告で先へ進む"
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

`build-web.js` は合言葉が無い・10文字未満のときに exit 1 する。`.webpass` を消した・書き換えた・別 PC に clone した、のいずれでもここに落ちる。

`docs/index.html` は `data/` の唯一のバックアップなので、**取込は成功し続けるのにバックアップだけが止まる。** `--commit` を付けていると古い docs/index.html を含んだまま「今月分を締めた」というコミットが積まれる。締めの最終報告にもバックアップの日付は出ないため、気づく手段が無い。

## どう直すか

締めの最終報告に必ず「バックアップ（docs/index.html）最終更新: YYYY-MM-DD」を出し、当日でなければ赤字の警告にする。`--commit` は build-web.js が成功したときだけ走らせる。

## 確かめたこと

<!-- 適用後にここへ書く -->
