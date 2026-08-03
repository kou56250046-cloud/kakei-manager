/* ダッシュボード描画。
   DATA は build.js が埋め込むオブジェクト。summary.js の関数は同じスコープに展開されている。
   グラフは外部ライブラリを使わず SVG を直接組み立てる（オフラインで確実に描画するため）。 */

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, children = []) => {
  const node = document.createElementNS(
    tag === 'svg' || SVG_TAGS.has(tag) ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xhtml',
    tag,
  );
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, String(v));
  }
  for (const c of [].concat(children)) if (c) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return node;
};
const SVG_TAGS = new Set(['g', 'rect', 'text', 'line', 'path', 'circle', 'defs', 'pattern', 'tspan']);

/** HTML文字列に差し込むデータは必ずこれを通す（店名や備考はCSV由来で内容を保証できない） */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const TX = DATA.transactions;
const state = {
  month: null,          // null = 全期間
  search: '',
  category: '',
  sort: { key: 'date', dir: 'desc' },
};

// ------------------------------------------------------------------ tooltip

const tip = $('#tip');
function showTip(evt, html) {
  tip.innerHTML = html;
  tip.style.opacity = '1';
  moveTip(evt);
}
function moveTip(evt) {
  const pad = 14;
  const r = tip.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY - r.height - 8;
  if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
  if (y < 8) y = evt.clientY + pad;
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
}
function hideTip() { tip.style.opacity = '0'; }

// ------------------------------------------------------------------ 派生データ

const months = markIncompleteMonths(monthlyTotals(TX), DATA.importLog, DATA.config?.analysis?.start_month);
const titheRows = titheByMonth(DATA.incomes, DATA.tithe, DATA.config, TX);
const payments = upcomingPayments(DATA.importLog, DATA.today);
const reviews = reviewQueue(TX);
const mismatches = (DATA.importLog ?? []).filter((e) => e.status === 'MISMATCH');

// 既定の表示月：明細で完全にカバーされている最後の月
const completeMonths = months.filter((m) => !m.incomplete);
state.month = completeMonths.length ? completeMonths[completeMonths.length - 1].month : null;

const scoped = () => (state.month ? TX.filter((t) => t.date.slice(0, 7) === state.month) : TX);

// ------------------------------------------------------------------ 描画

function render() {
  renderBanner();
  renderFilterBar();
  renderHero();
  renderTrend();
  renderCategories();
  renderFixedSplit();
  renderTithe();
  renderFixedList();
  renderReview();
  renderMerchants();
  renderAccounts();
  renderPayments();
  renderTable();
}

function renderBanner() {
  const host = $('#banners');
  host.replaceChildren();
  if (mismatches.length > 0) {
    host.appendChild(el('div', { class: 'banner is-critical' }, [
      el('span', { class: 'banner-icon', text: '⚠' }),
      el('div', {
        class: 'banner-body',
        html: '<strong>検算不一致</strong>：' + mismatches
          .map((e) => `${esc(e.billing_month)} 請求分（請求 ${yenFmt(e.billed)}円 / 明細 ${yenFmt(e.detail_sum)}円 / 差 ${yenFmt(e.diff)}円）`)
          .join('、') + ' — 取り込みは継続しています。',
      }),
    ]));
  }
  if (reviews.length > 0) {
    const total = reviews.reduce((a, r) => a + r.amount, 0);
    host.appendChild(el('div', { class: 'banner' }, [
      el('span', { class: 'banner-icon', text: '?' }),
      el('div', {
        class: 'banner-body',
        html: `<strong>要確認 ${reviews.length}件（${yenFmt(total)}円）</strong> — 分類が確定していない取引があります。`
          + ' <code>data/category_rules.json</code> にルールを追記して <code>npm run review -- --all</code> で反映されます。',
      }),
    ]));
  }
}

function renderFilterBar() {
  const host = $('#filters');
  host.replaceChildren(el('span', { class: 'filterbar-label', text: '対象期間' }));
  host.appendChild(el('button', {
    class: 'chip', type: 'button', 'aria-pressed': state.month === null,
    onclick: () => { state.month = null; render(); },
  }, ['全期間']));
  for (const m of months) {
    host.appendChild(el('button', {
      class: 'chip', type: 'button', 'aria-pressed': state.month === m.month,
      title: m.incomplete ? 'カード明細の範囲外の日があり、この月は不完全です' : '',
      onclick: () => { state.month = m.month; render(); },
    }, [m.month, m.incomplete ? el('span', { class: 'chip-mark', text: '不完全' }) : null]));
  }
}

function renderHero() {
  const rows = scoped().filter(isSpending);
  const total = rows.reduce((a, t) => a + t.amount, 0);
  const label = state.month ? `${state.month} の支出` : '全期間の支出';

  // 前月比（全期間表示のときと不完全月は出さない）
  let delta = null;
  if (state.month) {
    const idx = months.findIndex((m) => m.month === state.month);
    const cur = months[idx], prev = months[idx - 1];
    if (cur && prev && !cur.incomplete && !prev.incomplete) {
      const d = cur.amount - prev.amount;
      const pct = prev.amount ? (d / prev.amount) * 100 : 0;
      delta = { d, pct, prev: prev.month };
    }
  }

  const income = state.month
    ? (DATA.incomes ?? []).filter((i) => i.date.slice(0, 7) === state.month).reduce((a, i) => a + (i.net_amount ?? 0), 0)
    : (DATA.incomes ?? []).reduce((a, i) => a + (i.net_amount ?? 0), 0);

  const t = titheRows.length ? titheRows[titheRows.length - 1] : null;

  $('#hero').replaceChildren(
    el('div', { class: 'hero' }, [
      el('div', { class: 'hero-label', text: label }),
      el('div', { class: 'hero-value', html: yenFmt(total) + '<span class="unit">円</span>' }),
      delta
        ? el('div', {
            class: 'hero-delta',
            html: `前月比 <span class="${delta.d >= 0 ? 'up' : 'down'}">${delta.d >= 0 ? '+' : '−'}${yenFmt(Math.abs(delta.d))}円（${delta.d >= 0 ? '+' : '−'}${Math.abs(delta.pct).toFixed(1)}%）</span> vs ${delta.prev}`,
          })
        : el('div', { class: 'hero-delta', text: `${rows.length}件の取引` }),
    ]),
    el('div', { class: 'tiles' }, [
      tile('取引件数', String(rows.length), '件'),
      tile('手取り収入', yenFmt(income), '円', state.month ? '給与明細より' : `${(DATA.incomes ?? []).length}ヶ月分`),
      income > 0 ? tile('収支', yenFmt(income - total), '円', income - total >= 0 ? '黒字' : '赤字') : null,
      t ? tile('累積未献金', yenFmt(t.carryOver), '円', `${t.month} 時点`) : null,
      tile('要確認', String(reviews.length), '件', reviews.length === 0 ? 'なし' : '分類が未確定'),
    ].filter(Boolean)),
  );
}

function tile(label, value, unit, sub) {
  return el('div', { class: 'tile' }, [
    el('div', { class: 'tile-label', text: label }),
    el('div', { class: 'tile-value', html: value + (unit ? `<span class="unit">${unit}</span>` : '') }),
    sub ? el('div', { class: 'tile-sub', text: sub }) : null,
  ]);
}

/** 月次推移（縦棒・単一系列）。値をすべてキャップに直接ラベルするのでy軸目盛りは置かない。 */
function renderTrend() {
  const host = $('#trend');
  host.replaceChildren();
  if (months.length === 0) { host.appendChild(el('div', { class: 'empty', text: 'データがありません' })); return; }

  const W = 860, H = 240, padL = 8, padR = 8, padT = 34, padB = 44;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const max = Math.max(...months.map((m) => m.amount), 1);
  const band = innerW / months.length;
  const barW = Math.min(24, band * 0.5);

  const svg = el('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet', role: 'img' });
  svg.appendChild(el('defs', {}, [
    el('pattern', { id: 'hatch', width: 6, height: 6, patternTransform: 'rotate(45)', patternUnits: 'userSpaceOnUse' }, [
      el('rect', { width: 6, height: 6, fill: 'var(--surface)' }),
      el('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: 'var(--baseline)', 'stroke-width': 3 }),
    ]),
  ]));

  months.forEach((m, i) => {
    const h = Math.max(2, (m.amount / max) * innerH);
    const x = padL + band * i + (band - barW) / 2;
    const y = padT + innerH - h;
    const selected = state.month === m.month;

    // 4px の角丸データ端・ベースライン側は角なし
    const r = Math.min(4, h);
    const d = `M${x},${padT + innerH} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + barW - r},${y} Q${x + barW},${y} ${x + barW},${y + r} L${x + barW},${padT + innerH} Z`;
    svg.appendChild(el('path', {
      d, fill: m.incomplete ? 'url(#hatch)' : 'var(--series-1)',
      opacity: selected || state.month === null ? 1 : 0.42,
    }));

    svg.appendChild(el('text', {
      class: 'lbl-value', x: x + barW / 2, y: y - 8, 'text-anchor': 'middle', text: yenFmt(m.amount),
    }));
    svg.appendChild(el('text', {
      x: padL + band * i + band / 2, y: padT + innerH + 17, 'text-anchor': 'middle',
      text: m.month.slice(5) + '月', fill: selected ? 'var(--ink)' : undefined,
    }));
    if (m.incomplete) {
      svg.appendChild(el('text', { x: padL + band * i + band / 2, y: padT + innerH + 32, 'text-anchor': 'middle', 'font-size': 10, text: '不完全' }));
    }

    const hit = el('rect', {
      class: 'hit', x: padL + band * i, y: padT, width: band, height: innerH,
      onmousemove: (e) => showTip(e, `<div class="t-val">${yenFmt(m.amount)}円</div><div class="t-sub">${esc(m.month)}・${m.count}件${m.incomplete ? '・明細範囲外あり' : ''}</div>`),
      onmouseleave: hideTip,
      onclick: () => { state.month = state.month === m.month ? null : m.month; render(); },
    });
    hit.style.cursor = 'pointer';
    svg.appendChild(hit);
  });

  svg.appendChild(el('line', { class: 'baseline', x1: padL, y1: padT + innerH, x2: W - padR, y2: padT + innerH }));
  host.appendChild(svg);
  host.appendChild(el('div', { class: 'legend' }, [
    el('span', { class: 'legend-item' }, [el('span', { class: 'legend-swatch', style: 'background: var(--series-1)' }), '支出（利用日ベース）']),
    el('span', { class: 'legend-item' }, [el('span', { class: 'legend-swatch hatched' }), '不完全な月（カード明細の範囲外の日がある）']),
  ]));
}

/** カテゴリ別（横棒・単一色のランキング）。値と構成比を直接ラベルする＝表を兼ねる。 */
function renderCategories() {
  const host = $('#categories');
  const cats = byCategory(TX, state.month);
  const total = cats.reduce((a, c) => a + c.amount, 0);
  host.replaceChildren();
  if (cats.length === 0) { host.appendChild(el('div', { class: 'empty', text: 'この期間の支出はありません' })); return; }
  const max = Math.max(...cats.map((c) => c.amount), 1);

  const list = el('div', { class: 'barlist' });
  for (const c of cats) {
    const pct = total ? (c.amount / total) * 100 : 0;
    const subs = c.subs.filter((s) => s.name !== '—').slice(0, 4);
    list.appendChild(el('div', { class: 'barrow' }, [
      el('div', { class: 'barrow-name', text: c.category, title: c.category }),
      el('div', { class: 'barrow-track' }, [
        el('div', {
          class: 'barrow-fill',
          style: `width: ${Math.max(0.4, (c.amount / max) * 100)}%`,
          onmousemove: (e) => showTip(e, `<div class="t-val">${yenFmt(c.amount)}円</div><div class="t-sub">${esc(c.category)}・${c.count}件・${pct.toFixed(1)}%</div>`),
          onmouseleave: hideTip,
        }),
      ]),
      el('div', { class: 'barrow-val', html: `${yenFmt(c.amount)}<span class="barrow-pct">${pct.toFixed(1)}%</span>` }),
      subs.length > 1
        ? el('div', { class: 'barrow-subs', text: subs.map((s) => `${s.name} ${yenFmt(s.amount)}`).join('　/　') })
        : null,
    ]));
  }
  host.appendChild(list);
}

/** 固定費と変動費（2系列＝凡例必須） */
function renderFixedSplit() {
  const host = $('#fixedsplit');
  const fv = fixedVsVariable(TX, state.month);
  host.replaceChildren();
  if (fv.total <= 0) { host.appendChild(el('div', { class: 'empty', text: 'データがありません' })); return; }
  const fPct = (fv.fixed / fv.total) * 100;

  host.appendChild(el('div', { class: 'split' }, [
    el('div', {
      class: 'split-seg s1', style: `width: ${Math.max(fPct, 0.5)}%`,
      onmousemove: (e) => showTip(e, `<div class="t-val">${yenFmt(fv.fixed)}円</div><div class="t-sub">固定費・${fPct.toFixed(1)}%</div>`),
      onmouseleave: hideTip,
    }),
    el('div', {
      class: 'split-seg s2', style: `width: ${Math.max(100 - fPct, 0.5)}%`,
      onmousemove: (e) => showTip(e, `<div class="t-val">${yenFmt(fv.variable)}円</div><div class="t-sub">変動費・${(100 - fPct).toFixed(1)}%</div>`),
      onmouseleave: hideTip,
    }),
  ]));
  host.appendChild(el('div', { class: 'legend' }, [
    el('span', { class: 'legend-item' }, [
      el('span', { class: 'legend-swatch', style: 'background: var(--series-1)' }),
      `固定費 ${yenFmt(fv.fixed)}円（${fPct.toFixed(1)}%）`,
    ]),
    el('span', { class: 'legend-item' }, [
      el('span', { class: 'legend-swatch', style: 'background: var(--series-2)' }),
      `変動費 ${yenFmt(fv.variable)}円（${(100 - fPct).toFixed(1)}%）`,
    ]),
  ]));
  host.appendChild(el('div', { class: 'hint', text: '固定費はカード払いの光熱費・サブスクに付けた印から集計しています（口座振替分は未登録）。' }));
}

function renderTithe() {
  const host = $('#tithe');
  host.replaceChildren();
  if (titheRows.length === 0) {
    host.appendChild(el('div', { class: 'empty', text: '給与明細が未取込です。npm run import:payslip を実行してください。' }));
    return;
  }
  const cfg = DATA.config?.tithe ?? {};
  const sumCalc = titheRows.reduce((a, r) => a + r.calculated, 0);
  const sumPaid = titheRows.reduce((a, r) => a + r.paid, 0);
  const carry = titheRows[titheRows.length - 1].carryOver;

  host.appendChild(el('div', { class: 'tiles', style: 'margin-bottom:14px' }, [
    tile('計算額 合計', yenFmt(sumCalc), '円', `手取りの${Math.round((cfg.rate ?? 0.1) * 100)}%`),
    tile('献金済 合計', yenFmt(sumPaid), '円', sumPaid === 0 ? '未記録' : null),
    tile('累積未献金', yenFmt(carry), '円', carry === 0 ? '✅ 完了' : '要記録'),
  ]));

  const rows = titheRows.map((r) => el('tr', {}, [
    el('td', { class: 'strong', text: r.month }),
    el('td', { class: 'num', text: yenFmt(r.base) }),
    el('td', { class: 'num strong', text: yenFmt(r.calculated) }),
    el('td', { class: 'num', text: yenFmt(r.paid) }),
    el('td', { class: 'num' }, [
      r.remaining === 0
        ? el('span', { class: 'tag', text: '✅ 完了' })
        : el('span', { class: 'tag is-review', text: yenFmt(r.remaining) + '円 未納' }),
    ]),
  ]));

  host.appendChild(el('div', { class: 'tbl-wrap' }, [
    el('table', {}, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: '支給月' }),
        el('th', { class: 'num', text: '手取り' }),
        el('th', { class: 'num', text: '計算額' }),
        el('th', { class: 'num', text: '献金済' }),
        el('th', { class: 'num', text: '状態' }),
      ])]),
      el('tbody', {}, rows),
    ]),
  ]));
  host.appendChild(el('div', {
    class: 'hint',
    text: `基準：手取り（差引支給額）× ${Math.round((cfg.rate ?? 0.1) * 100)}%、${cfg.rounding_unit ?? 100}円単位で${cfg.rounding === 'floor' ? '切り捨て' : cfg.rounding === 'round' ? '四捨五入' : '切り上げ'}。`
      + '献金の実績は data/tithe.json に記録します。',
  }));
}

function renderFixedList() {
  const host = $('#fixedlist');
  host.replaceChildren();
  const list = fixedCostList(DATA.fixedCosts, TX, months.map((m) => m.month));
  if (list.length === 0) {
    host.appendChild(el('div', { class: 'empty', text: '固定費が登録されていません' }));
    return;
  }

  const monthlyTotal = list.reduce((a, f) => a + f.monthlyEquivalent, 0);
  const generated = list.filter((f) => f.generated);
  const fromCsv = list.filter((f) => !f.generated);
  const unset = list.filter((f) => f.unset);

  $('#fixed-note').textContent = `${months.length}ヶ月の実績から算出`;

  host.appendChild(el('div', { class: 'tiles', style: 'margin-bottom:14px' }, [
    tile('固定費 月あたり', yenFmt(monthlyTotal), '円', `${list.length}項目`),
    tile('自動生成', yenFmt(generated.reduce((a, f) => a + f.monthlyEquivalent, 0)), '円', '口座振替・現金・dカード'),
    tile('明細から集計', yenFmt(fromCsv.reduce((a, f) => a + f.monthlyEquivalent, 0)), '円', 'イオンカード払い'),
  ]));

  const methodLabel = { bank_transfer: '口座振替', card: 'カード', cash: '現金' };
  const rows = list.map((f) => el('tr', {}, [
    el('td', { class: 'strong' }, [
      el('span', { text: f.name }),
      f.unset ? el('span', { class: 'tag is-review', style: 'margin-left:6px', text: '金額未登録' }) : null,
    ]),
    el('td', {}, [el('span', { class: 'tag', text: f.category + (f.subcategory ? ' / ' + f.subcategory : '') })]),
    el('td', {}, [
      el('span', { class: 'tag', text: methodLabel[f.payment_method] ?? f.payment_method }),
    ]),
    el('td', {
      class: 'num',
      text: f.amount_type === 'computed' ? '毎月計算' : f.amount === null ? '—' : yenFmt(f.amount),
    }),
    el('td', { class: 'num strong', text: f.actualAvg === null ? '—' : yenFmt(f.actualAvg) }),
    el('td', { class: 'num', text: f.monthsSeen === 0 ? '—' : `${f.monthsSeen}ヶ月` }),
    el('td', { class: 'num', text: f.actualTotal === 0 ? '—' : yenFmt(f.actualTotal) }),
    el('td', {}, [
      f.generated
        ? el('span', { class: 'tag is-fixed', text: '自動生成' })
        : el('span', { class: 'tag', text: '明細から' }),
    ]),
  ]));

  host.appendChild(el('div', { class: 'tbl-wrap' }, [
    el('table', {}, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: '項目' }), el('th', { text: 'カテゴリ' }), el('th', { text: '支払方法' }),
        el('th', { class: 'num', text: '登録額' }), el('th', { class: 'num', text: '実績（月平均）' }),
        el('th', { class: 'num', text: '実績月数' }), el('th', { class: 'num', text: '累計' }),
        el('th', { text: '計上' }),
      ])]),
      el('tbody', {}, rows),
    ]),
  ]));

  host.appendChild(el('div', {
    class: 'hint',
    html: '<strong>自動生成</strong>＝マスタから毎月の取引を作るもの（口座振替・現金・<strong>明細CSVを取り込んでいない dカード</strong>）。'
      + ' <strong>明細から</strong>＝イオンカードのCSVに実額が出るため生成しないもの（生成すると二重計上になる）。'
      + '「実績（月平均）」は実績のある月数で割った額（隔月請求の水道などを月額に均さないため）。',
  }));
  if (unset.length > 0) {
    host.appendChild(el('div', {
      class: 'banner is-critical', style: 'margin-top:12px',
    }, [
      el('span', { class: 'banner-icon', text: '⚠' }),
      el('div', {
        class: 'banner-body',
        html: `<strong>${unset.map((f) => esc(f.name)).join('、')}</strong> は金額が未登録で、支出に一切計上されていません。`
          + ' 明細CSVを取り込んでいないカード払いのため、<code>data/fixed_costs.json</code> に金額を入れないと漏れ続けます。',
      }),
    ]));
  }
}

function renderReview() {
  const host = $('#review');
  host.replaceChildren();
  if (reviews.length === 0) {
    host.appendChild(el('div', { class: 'empty', text: '要確認の取引はありません ✅' }));
    return;
  }
  const rows = reviews.map((r) => el('tr', {}, [
    el('td', { class: 'strong', text: r.merchant }),
    el('td', { class: 'num', text: yenFmt(r.amount) }),
    el('td', { class: 'num', text: String(r.count) }),
    el('td', { text: r.items.map((i) => i.date).join(', ') }),
    el('td', {}, [el('code', { text: r.key, style: 'font-size:11px' })]),
  ]));
  host.appendChild(el('div', { class: 'tbl-wrap' }, [
    el('table', {}, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: '店名' }), el('th', { class: 'num', text: '金額' }),
        el('th', { class: 'num', text: '件数' }), el('th', { text: '利用日' }), el('th', { text: '正規化キー' }),
      ])]),
      el('tbody', {}, rows),
    ]),
  ]));
}

function renderMerchants() {
  const host = $('#merchants');
  const list = byMerchant(TX, state.month).slice(0, 20);
  host.replaceChildren();
  if (list.length === 0) { host.appendChild(el('div', { class: 'empty', text: 'データがありません' })); return; }
  const rows = list.map((m, i) => el('tr', {}, [
    el('td', { text: String(i + 1), class: 'num' }),
    el('td', { class: 'strong', text: m.merchant }),
    el('td', {}, [el('span', { class: 'tag', text: m.category })]),
    el('td', { class: 'num', text: String(m.count) }),
    el('td', { class: 'num strong', text: yenFmt(m.amount) }),
  ]));
  host.appendChild(el('div', { class: 'tbl-wrap' }, [
    el('table', {}, [
      el('thead', {}, [el('tr', {}, [
        el('th', { class: 'num', text: '#' }), el('th', { text: '店名' }), el('th', { text: 'カテゴリ' }),
        el('th', { class: 'num', text: '件数' }), el('th', { class: 'num', text: '金額' }),
      ])]),
      el('tbody', {}, rows),
    ]),
  ]));
}

function renderAccounts() {
  const host = $('#accounts');
  const rows = accountBalances(DATA.accounts, DATA.balances, DATA.incomes, TX);
  const withData = rows.filter((r) => r.actual !== null);
  host.replaceChildren();
  if (withData.length === 0) {
    host.appendChild(el('div', { class: 'setup-note' }, [
      el('div', { text: '口座残高は未登録です。' }),
      el('div', {
        style: 'margin-top:6px',
        html: '<code>data/balances.json</code> に各口座の残高スナップショットを入れると、理論残高との差額（＝記録漏れ）が表示されます。',
      }),
    ]));
    return;
  }
  // 仕様書8.3：「使えるお金」と「貯めたお金」を混ぜない
  const inTotal = withData.filter((r) => r.include_in_total !== false);
  const savings = inTotal.filter((r) => (r.roles ?? []).includes('savings'));
  const living = inTotal.filter((r) => !(r.roles ?? []).includes('savings'));
  const sum = (list) => list.reduce((a, r) => a + r.actual, 0);

  host.appendChild(el('div', { class: 'tiles', style: 'margin-bottom:14px' }, [
    tile('合計残高', yenFmt(sum(inTotal)), '円', `${inTotal.length}口座`),
    living.length ? tile('生活費', yenFmt(sum(living)), '円', living.map((r) => r.name.replace(/（.*/, '')).join('・')) : null,
    savings.length ? tile('貯蓄', yenFmt(sum(savings)), '円', savings.map((r) => r.name.replace(/（.*/, '')).join('・')) : null,
  ].filter(Boolean)));

  const list = withData.map((r) => el('tr', {}, [
    el('td', { class: 'strong' }, [
      el('span', { text: r.name }),
      (r.roles ?? []).includes('savings') ? el('span', { class: 'tag', style: 'margin-left:6px', text: '貯蓄' }) : null,
    ]),
    el('td', { class: 'num', text: yenFmt(r.actual) }),
    el('td', { class: 'num', text: yenFmt(r.calculated) }),
    el('td', { class: 'num' }, [
      r.diff === 0 ? el('span', { class: 'tag', text: '一致' }) : el('span', { class: 'tag is-review', text: yenFmt(r.diff) }),
    ]),
    el('td', { text: r.asOf }),
  ]));
  host.appendChild(el('div', { class: 'tbl-wrap' }, [
    el('table', {}, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: '口座' }), el('th', { class: 'num', text: '実残高' }), el('th', { class: 'num', text: '理論残高' }),
        el('th', { class: 'num', text: '差額' }), el('th', { text: '基準日' }),
      ])]),
      el('tbody', {}, list),
    ]),
  ]));
  host.appendChild(el('div', {
    class: 'hint',
    text: '理論残高は「基準日の実残高 ＋ その後の収入 − その後の支出」で計算します。'
      + '基準日以降のデータがまだないため現在は実残高と一致します。差額（＝記録漏れ）は次回の残高入力から意味を持ちます。',
  }));
}

function renderPayments() {
  const host = $('#payments');
  host.replaceChildren();
  if (payments.length === 0) { host.appendChild(el('div', { class: 'empty', text: '引落予定はありません' })); return; }
  const rows = payments.map((p) => el('tr', {}, [
    el('td', { class: p.past ? '' : 'strong', text: p.date }),
    el('td', { text: p.label }),
    el('td', { class: 'num strong', text: yenFmt(p.amount) }),
    el('td', {}, [el('span', { class: 'tag', text: p.past ? '引落済' : '予定' })]),
  ]));
  host.appendChild(el('div', { class: 'tbl-wrap' }, [
    el('table', {}, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: '引落日' }), el('th', { text: '内容' }), el('th', { class: 'num', text: '金額' }), el('th', { text: '状態' }),
      ])]),
      el('tbody', {}, rows),
    ]),
  ]));
  host.appendChild(el('div', { class: 'hint', text: 'カード請求額は明細の「今回ご請求金額」から自動取得しています（手入力なし）。' }));
}

// ------------------------------------------------------------------ 取引一覧

function renderTable() {
  const host = $('#txtable');
  const q = state.search.trim().toLowerCase();
  let rows = scoped().filter((t) => {
    if (state.category && t.category !== state.category) return false;
    if (!q) return true;
    return (t.merchant + ' ' + t.merchant_raw + ' ' + t.merchant_key + ' ' + (t.note ?? '')).toLowerCase().includes(q);
  });

  const { key, dir } = state.sort;
  rows = [...rows].sort((a, b) => {
    let r;
    if (key === 'amount') r = a.amount - b.amount;
    else if (key === 'merchant') r = String(a.merchant).localeCompare(String(b.merchant), 'ja');
    else if (key === 'category') r = String(a.category).localeCompare(String(b.category), 'ja');
    else r = a.date.localeCompare(b.date);
    return dir === 'asc' ? r : -r;
  });

  const sum = rows.reduce((a, t) => a + t.amount, 0);
  const th = (label, k, cls = '') => el('th', {
    class: `sortable ${cls}`.trim(),
    onclick: () => {
      state.sort = { key: k, dir: state.sort.key === k && state.sort.dir === 'desc' ? 'asc' : 'desc' };
      renderTable();
    },
  }, [label, key === k ? el('span', { class: 'arrow', text: dir === 'asc' ? '▲' : '▼' }) : null]);

  const body = rows.slice(0, 400).map((t) => el('tr', {}, [
    el('td', { text: t.date }),
    el('td', { class: 'strong', text: t.merchant, title: t.merchant_raw }),
    el('td', {}, [
      el('span', { class: 'tag', text: t.category + (t.subcategory && t.subcategory !== '—' ? ' / ' + t.subcategory : '') }),
    ]),
    el('td', { class: 'num strong', text: yenFmt(t.amount) }),
    el('td', {}, [
      t.needs_review ? el('span', { class: 'tag is-review', text: '要確認' }) : null,
      t.is_fixed_cost ? el('span', { class: 'tag is-fixed', text: '固定費' }) : null,
      t.type === 'refund' ? el('span', { class: 'tag is-refund', text: '返品' }) : null,
    ].filter(Boolean)),
    el('td', { text: t.note || '' }),
    el('td', { text: t.billing_month ?? '' }),
  ]));

  host.replaceChildren(
    el('div', { class: 'tbl-wrap' }, [
      el('table', {}, [
        el('thead', {}, [el('tr', {}, [
          th('利用日', 'date'), th('店名', 'merchant'), th('カテゴリ', 'category'),
          th('金額', 'amount', 'num'),
          el('th', { text: '印' }), el('th', { text: '備考' }), el('th', { text: '請求月' }),
        ])]),
        el('tbody', {}, body),
      ]),
    ]),
    el('div', {
      class: 'rowcount',
      text: `${rows.length}件 / 合計 ${yenFmt(sum)}円` + (rows.length > 400 ? '（先頭400件を表示）' : ''),
    }),
  );
}

// ------------------------------------------------------------------ 初期化

function initControls() {
  const cats = [...new Set(TX.map((t) => t.category))].sort((a, b) => a.localeCompare(b, 'ja'));
  const sel = $('#f-category');
  for (const c of cats) sel.appendChild(el('option', { value: c, text: c }));
  sel.addEventListener('change', (e) => { state.category = e.target.value; renderTable(); });
  $('#f-search').addEventListener('input', (e) => { state.search = e.target.value; renderTable(); });

  const toggle = $('#theme');
  const apply = (mode) => {
    document.documentElement.setAttribute('data-theme', mode);
    toggle.textContent = mode === 'dark' ? '☀ ライト' : '🌙 ダーク';
    try { localStorage.setItem('kakei-theme', mode); } catch {}
  };
  let saved = null;
  try { saved = localStorage.getItem('kakei-theme'); } catch {}
  apply(saved ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  toggle.addEventListener('click', () => {
    apply(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
  });

  window.addEventListener('mousemove', (e) => { if (tip.style.opacity === '1') moveTip(e); });
}

initControls();
render();

// Web版（暗号化）の boot() が「描画まで到達したか」を判定するための目印。
// これが立たないまま復号ゲートを閉じると、空の枠だけが残って復帰不能になる。
window.__kakeiRendered = true;
