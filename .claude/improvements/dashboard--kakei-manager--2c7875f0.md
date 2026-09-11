---
generated:
  id: dashboard--kakei-manager--2c7875f0
  axis: ダッシュボード
  project: kakei-manager
  title: "全期間のとき日別カレンダーだけが月を明示せず直近1ヶ月を描く"
  detector: viz-reviewer
  anchor: renderCalendar
  priority: 高
  detectedAt: 2026-09-10T12:35:02.194Z
  targetFiles:
    - ui/app.js
    - ui/template.html
curated:
  status: draft
  statusReason: ""
  effort: low
  measure: 欠陥修正
  expected:
    metric: "欠陥が再現しないこと"
    direction: down
  repro: "全期間で月名の無いカレンダーが出る。全期間を選んで見出しが出るかを確かめる"
  specPath: ""
  branch: ""
  adoptedAt: null
sources:
  - "viz-reviewer: const month = state.month ?? months[months.length - 1].month; 全期間で無言のフォールバック"
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

カードには日付の見出しが一切無い（cal-head は金額と日数だけ、セルは日番号だけ、月名はツールチップの中だけ）。カードノートは静的な「選択中の月」で、全期間には選択中の月が存在しないので**この文自体が嘘になる。**

フォールバック先は「最後の完全月」ではなく単に最後の月なので、いま表示されるのは不完全な 2026-08 の10日分。hero が全期間の 2,071,262円 を出している横で、月名のない8月10日ぶんのカレンダーが並ぶ。

## どう直すか

dailyTotals の戻り値にある dt.month を cal-head に見出しとして必ず出す。全期間のときは「全期間では日別に割れないため、直近の完全月 2026-07 を表示」と明示する。フォールバック先も最後の完全月に変える。

## 確かめたこと

<!-- 適用後にここへ書く -->
