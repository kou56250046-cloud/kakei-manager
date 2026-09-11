---
generated:
  id: viz--kakei-manager--d5c91de4
  axis: 可視化
  project: kakei-manager
  title: "固定費と変動費の系列色が2枚のカードで入れ替わっている"
  detector: viz-reviewer
  anchor: renderFixedSplit
  priority: 高
  detectedAt: 2026-09-10T12:35:02.194Z
  targetFiles:
    - ui/app.js
    - ui/style.css
curated:
  status: draft
  statusReason: ""
  effort: low
  measure: 欠陥修正
  expected:
    metric: "欠陥が再現しないこと"
    direction: down
  repro: "2枚のカードで系列色が反転している。両カードで同じ色になったかを確かめる"
  specPath: ""
  branch: ""
  adoptedAt: null
sources:
  - "viz-reviewer: 傾向タブでは変動費=--series-1（青）。固定費タブでは .split-seg.s1 が固定費で --series-1（青）"
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

同じ2系列を並べた2枚で、青の意味が反転している。さらに変動費の色も青と橙で一致しない。

積み上げ棒で「青＝自分で動かせる分」と覚えた直後に帯グラフを見ると、固定費の比率をそのまま裏返して読む。凡例に額があるので読み直せば気づくが、月1回の閲覧で色から先に印象を作る動線では**印象のほうが残る。**

## どう直すか

`--fixed` / `--variable` のような意味づけした CSS 変数を style.css に置いて両方から参照する。「変動費が主役（自分で動かせる分）」という既存のコメント方針に合わせ、変動費を --series-1 に揃える。

## 確かめたこと

<!-- 適用後にここへ書く -->
