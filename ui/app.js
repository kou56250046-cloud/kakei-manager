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
const SVG_TAGS = new Set(['g', 'rect', 'text', 'line', 'path', 'circle', 'defs', 'pattern', 'tspan', 'clipPath']);

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
  txLimit: 200,        // 「残りN件を表示」で解除する
  calFixed: false,     // カレンダーに固定費を含めるか（既定は変動費のみ）
  openMerchant: null,  // 店舗別で推移を開いている店
  tab: 'month',        // 表示中のタブ（initTabs が localStorage から復元する）
};

// ------------------------------------------------------------------ motion

// OS の「視差効果を減らす」設定。動きは全部ここで殺せるようにする
const REDUCE = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
let firstPaint = true;   // 棒の伸長などは初回のみ。切替のたびに再生すると鬱陶しい

/**
 * 数値を from → to へ数える。桁が読めない瞬間を作らないよう、ロールではなく加算。
 *
 * ★ 要素には最初から最終値が入っている状態で呼ぶこと。
 *   先に from を書き込むと、rAF が動かない環境（バックグラウンドタブなど）で
 *   古い数字のまま表示され続ける。「動かないなら正しい値のまま」が安全側。
 */
function countTo(node, from, to, ms, tailHtml) {
  const set = (v) => { node.innerHTML = yenFmt(v) + tailHtml; };
  if (REDUCE || ms === 0 || from === to) { set(to); return; }
  const t0 = performance.now();
  let done = false;
  const ease = (p) => 1 - Math.pow(1 - p, 4);   // easeOutQuart：減速だけ。跳ねさせない
  const step = (t) => {
    if (done) return;
    const p = Math.min(1, (t - t0) / ms);
    set(Math.round(from + (to - from) * ease(p)));
    if (p < 1) requestAnimationFrame(step);
    else done = true;
  };
  requestAnimationFrame(step);
  // rAF が途中で止まっても、中途半端な数字のまま固定されないようにする
  setTimeout(() => { if (!done) { done = true; set(to); } }, ms + 150);
}

/**
 * 表示を差し替える間、対象カードを一段沈めて「更新された」ことを伝える。
 *
 * ★ mutate() は必ず同期で呼ぶ。
 *   以前は requestAnimationFrame の中で呼んでいたが、rAF が来ない状況
 *   （バックグラウンドタブ、省電力、ヘッドレス）では画面が更新されないまま
 *   沈んだ状態で固まった。演出は失敗してよいが、表示の更新は失敗してはいけない。
 *   .card 自体は作り替えられず中身だけ差し替わるので、沈めたまま更新して
 *   次フレームで戻せば、新しい内容がフェードインする。
 */
function swapCards(mutate) {
  if (REDUCE) { mutate(); return; }
  const cards = [...document.querySelectorAll('.card')];
  cards.forEach((c) => c.classList.add('is-swapping'));
  mutate();
  const clear = () => cards.forEach((c) => c.classList.remove('is-swapping'));
  requestAnimationFrame(clear);
  setTimeout(clear, 400);   // rAF が来なくても必ず戻す
}

// ------------------------------------------------------------------ tooltip

const tip = $('#tip');
let tipW = 0, tipH = 0, tipRaf = 0, tipEvt = null;

function showTip(evt, html) {
  tip.innerHTML = html;
  tip.classList.add('is-on');
  // 計測は内容が変わったときだけ。mousemove ごとに測ると強制同期レイアウトになる
  const r = tip.getBoundingClientRect();
  tipW = r.width; tipH = r.height;
  moveTip(evt);
}
function moveTip(evt) {
  tipEvt = evt;
  if (tipRaf) return;
  tipRaf = requestAnimationFrame(() => {
    tipRaf = 0;
    const pad = 14;
    let x = tipEvt.clientX + pad;
    let y = tipEvt.clientY - tipH - 8;
    if (x + tipW > window.innerWidth - 8) x = tipEvt.clientX - tipW - pad;
    // 上に置けないときは下に回すが、指の場合は手で隠れるので大きく逃がす
    if (y < 8) y = tipEvt.clientY + (isTouching() ? 34 : pad);
    // 指で操作中は、チップ自体が画面外にはみ出して読めなくなるのを防ぐ
    if (x < 8) x = 8;
    if (y + tipH > window.innerHeight - 8) y = Math.max(8, window.innerHeight - tipH - 8);
    tip.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  });
}
function hideTip() { tip.classList.remove('is-on'); }

/**
 * 指で触っている間だけツールチップを出す。
 *
 * ★ タッチでは mouseleave が発火しない。
 *   ブラウザはタップのたびに mouseenter/mousemove を「エミュレート」して送ってくるが、
 *   離れたことを知らせる mouseleave は他の場所を叩くまで来ない。
 *   そのため詳細が画面に残り続けていた（スマホで実際に起きていた）。
 *
 * ★ 端末で分岐しない（`ontouchstart in window` などで二分しない）。
 *   タッチ対応のノートPCではマウスと指が交互に来るため、端末で決め打つと必ずどちらかが壊れる。
 *   「直前の入力が指だったか」だけを見る。
 *
 * ★ エミュレートされたマウスイベントは touchend の**後**に飛んでくる。
 *   だから touchend で消しただけでは、直後の mousemove がもう一度出してしまう。
 *   直近にタッチがあった間はマウス側を丸ごと無視する。
 */
let lastTouchAt = 0;
const isTouching = () => Date.now() - lastTouchAt < 700;

function bindTip(node, htmlOf, hooks = {}) {
  const enter = () => hooks.onShow?.();
  const leave = () => { hooks.onHide?.(); hideTip(); };

  node.addEventListener('mouseenter', () => { if (!isTouching()) enter(); });
  node.addEventListener('mousemove', (e) => { if (!isTouching()) showTip(e, htmlOf()); });
  node.addEventListener('mouseleave', () => { if (!isTouching()) leave(); });

  // Touch オブジェクトは clientX/clientY を持つので、そのまま showTip に渡せる
  node.addEventListener('touchstart', (e) => {
    lastTouchAt = Date.now();
    enter();
    showTip(e.touches[0], htmlOf());
  }, { passive: true });
  node.addEventListener('touchmove', (e) => {
    lastTouchAt = Date.now();
    moveTip(e.touches[0]);
  }, { passive: true });

  // touchcancel も拾う。指を置いたままスクロールに移った場合はこちらしか来ない
  const end = () => { lastTouchAt = Date.now(); leave(); };
  node.addEventListener('touchend', end, { passive: true });
  node.addEventListener('touchcancel', end, { passive: true });
}

// ------------------------------------------------------------------ 派生データ

/**
 * ★ 引落・残高の判定は「ビルド時刻」ではなく「開いた瞬間の実日付」で行う。
 *
 * DATA.today はビルド時に焼き込まれた日付。これを基準にすると、
 * 更新前に前月の dist/index.html を開いたときに
 * 「本日 N円の引落に対し残高不足」という**とっくに終わった警告**が出続ける。
 * 月1運用では「まず古いファイルを開く」が普通に起き、
 * 画面で最も強い警告が最も起きやすい状況で偽になっていた。
 */
const REAL_TODAY = new Date().toISOString().slice(0, 10);
const STALE_DAYS = Math.max(0, Math.round((Date.parse(REAL_TODAY) - Date.parse(DATA.today)) / 86400000));
const IS_STALE = STALE_DAYS > 0;

const months = markIncompleteMonths(monthlyTotals(TX), DATA.importLog, DATA.config?.analysis?.start_month);
const titheRows = titheByMonth(DATA.incomes, DATA.tithe, DATA.config, TX);
const payments = upcomingPayments(DATA.importLog, REAL_TODAY);
const risk = settlementRisk(DATA.accounts, DATA.balances, DATA.importLog, REAL_TODAY);
const reviews = reviewQueue(TX);
const mismatches = (DATA.importLog ?? []).filter((e) => e.status === 'MISMATCH');

// 既定の表示月：明細で完全にカバーされている最後の月
const completeMonths = months.filter((m) => !m.incomplete);
state.month = completeMonths.length ? completeMonths[completeMonths.length - 1].month : null;

const scoped = () => (state.month ? TX.filter((t) => t.date.slice(0, 7) === state.month) : TX);

// ------------------------------------------------------------------ タブ

/**
 * カードをタブに分ける。
 *
 * カードが17枚まで増え、1枚の縦長ページでは端から端まで届かなくなった。
 *
 * ★ 警告（#banners）と期間フィルタはタブに入れない。
 *   残高不足のような「行動に繋がるもの」は、どのタブを見ていても目に入る必要がある。
 * ★ 隠すのは表示だけで、描画は全タブ分やる。
 *   タブを開いた瞬間に組み立てると、切り替えのたびに待たされる。
 *   取引は数百件で、全部描いても一瞬で終わる規模。
 * ★ 隠れているタブに要確認が溜まると気づけないので、件数をタブに出す。
 *   タブ導入で唯一失われるのが「全部が目に入る」ことなので、そこだけ補う。
 */
const TAB_KEY = 'kakei-tab';

function tabButtons() {
  return [...document.querySelectorAll('#tabs .tab')];
}

function applyTab(scroll = false) {
  for (const sec of document.querySelectorAll('.card[data-tab]')) {
    const t = sec.dataset.tab;
    sec.classList.toggle('is-hidden', t !== 'always' && t !== state.tab);
  }
  for (const b of tabButtons()) {
    const on = b.dataset.tab === state.tab;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  }

  // タブを切り替えたとき、前のタブの下のほうを見ていると
  // 切り替え先の途中に着地して「何も変わっていない」ように見える
  if (scroll) {
    const bar = $('#tabs');
    if (bar && bar.getBoundingClientRect().top < 0) {
      bar.scrollIntoView({ block: 'start', behavior: REDUCE ? 'auto' : 'smooth' });
    }
  }
}

function selectTab(tab, scroll = true) {
  if (state.tab === tab) return;
  state.tab = tab;
  try { localStorage.setItem(TAB_KEY, tab); } catch { /* プライベートモードなど。記憶しないだけ */ }
  applyTab(scroll);
}

function initTabs() {
  const bar = $('#tabs');
  if (!bar) return;
  const buttons = tabButtons();
  if (buttons.length === 0) return;

  const known = buttons.map((b) => b.dataset.tab);
  let saved = null;
  try { saved = localStorage.getItem(TAB_KEY); } catch { /* 読めなければ既定のタブ */ }
  state.tab = known.includes(saved) ? saved : known[0];

  buttons.forEach((b, i) => {
    b.addEventListener('click', () => selectTab(b.dataset.tab));
    // 左右キーで移動できるようにする（role="tablist" の作法）
    b.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const next = buttons[(i + d + buttons.length) % buttons.length];
      selectTab(next.dataset.tab, false);
      next.focus();
    });
  });
  applyTab();
}

/** 隠れているタブに溜まっているものを、タブ自身に出す */
function updateTabBadges() {
  const marks = { detail: reviews.length };
  for (const b of tabButtons()) {
    const n = marks[b.dataset.tab] ?? 0;
    let badge = b.querySelector('.tab-badge');
    if (n > 0) {
      if (!badge) {
        badge = el('span', { class: 'tab-badge' });
        b.appendChild(badge);
      }
      badge.textContent = String(n);
      badge.title = `要確認 ${n}件`;
    } else if (badge) {
      badge.remove();
    }
  }
}

// ------------------------------------------------------------------ 描画

/** 期間を切り替える。押した直後の反応は遅らせず、表示の入れ替えだけを滑らかにする */
function selectMonth(month) {
  if (state.month === month) return;
  state.month = month;
  swapCards(render);
}

/**
 * 1枚のカードで例外が出ても、他のカードを巻き添えにしない。
 * 以前は12個を素で連続呼び出ししており、データ1件の不整合
 * （不正な正規表現、date 欠損など）で画面全体が消え、
 * Web版では「表示に失敗しました」でダッシュボードごと開けなくなった。
 */
function safe(label, fn, hostSel) {
  try {
    fn();
  } catch (e) {
    console.error(`[${label}] 描画に失敗:`, e);
    const host = hostSel ? $(hostSel) : null;
    if (host) {
      host.replaceChildren(el('div', {
        class: 'empty',
        text: `${label} の表示に失敗しました（他の項目は正常です）`,
      }));
    }
  }
}

function render() {
  safe('今月の色', applyMonthTone);
  safe('警告', renderBanner, '#banners');
  safe('期間フィルタ', renderFilterBar, '#filters');
  safe('サマリー', renderHero, '#hero');
  safe('月次推移', renderTrend, '#trend');
  safe('カテゴリ別支出', renderCategories, '#categories');
  safe('いつもの幅', renderBands, '#bands');
  safe('変動費の推移', renderVariableTrend, '#vartrend');
  safe('日別カレンダー', renderCalendar, '#calendar');
  safe('固定費と変動費', renderFixedSplit, '#fixedsplit');
  safe('固定費の変化', renderPriceChanges, '#pricechanges');
  safe('年間コミット額', renderAnnual, '#annual');
  safe('光熱費の推移', renderUtilities, '#utilities');
  safe('献金', renderTithe, '#tithe');
  safe('固定費一覧', renderFixedList, '#fixedlist');
  safe('要確認キュー', renderReview, '#review');
  safe('店舗別', renderMerchants, '#merchants');
  safe('口座残高', renderAccounts, '#accounts');
  safe('カード引落予定', renderPayments, '#payments');
  safe('取引一覧', renderTable, '#txtable');
  safe('タブの件数', updateTabBadges);
}

function renderBanner() {
  const host = $('#banners');
  host.replaceChildren();

  // データが古いことを最初に知らせる。これを出さずに引落や残高を判定すると、
  // 「とっくに終わった引落」を今日の予定として警告してしまう
  if (IS_STALE) {
    host.appendChild(el('div', { class: 'banner' }, [
      el('span', { class: 'banner-icon', text: '⏳' }),
      el('div', {
        class: 'banner-body',
        html: `<strong>この画面は ${esc(DATA.today)} 時点のデータです</strong>`
          + `（今日は ${esc(REAL_TODAY)}／${STALE_DAYS}日前の内容）。`
          + ` 引落・残高の判定は古い可能性があります。<code>npm run update</code> で更新してください。`,
      }),
    ]));
  }

  // 残高不足は延滞・手数料という実損に直結する。この画面で最も優先度が高い警告
  if (risk && !risk.covered) {
    // データが古いときは「本日」「N日後」と断言しない（その相対表現こそが嘘になる）
    const when = IS_STALE
      ? `${risk.date} 予定の`
      : (risk.daysLeft <= 0 ? '本日' : `${risk.daysLeft}日後（${risk.date}）`) + 'に';
    host.appendChild(el('div', { class: 'banner is-critical' }, [
      el('span', { class: 'banner-icon', text: '⚠' }),
      el('div', {
        class: 'banner-body',
        html: `<strong>引落に残高が足りません</strong>：${when} <strong>${yenFmt(risk.amount)}円</strong> の引落に対し、`
          + `${esc(risk.account.name)}の残高は ${yenFmt(risk.balance)}円（${esc(risk.balanceDate)}時点）。`
          + `<strong>${yenFmt(risk.shortfall)}円 不足</strong>しています。`
          + '　→ 最新の残高を <code>data/balances.json</code> に追記して <code>npm run update</code>。'
          + (risk.sameDay
            ? '（残高の基準日と引落日が同じため、引き落とし後の残高を見ている可能性があります）'
            : ''),
      }),
    ]));
  }

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
    onclick: () => selectMonth(null),
  }, ['全期間']));
  for (const m of months) {
    host.appendChild(el('button', {
      class: 'chip', type: 'button', 'aria-pressed': state.month === m.month,
      title: m.incomplete ? 'カード明細の範囲外の日があり、この月は不完全です' : '',
      onclick: () => selectMonth(m.month),
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

  // 収入のあった「月数」。incomes.length はレコード数（給与＋児童手当）なので
  // そのまま出すと「13ヶ月分」のような誤った表示になる。
  const incomeMonths = new Set((DATA.incomes ?? []).map((i) => i.date.slice(0, 7))).size;

  // 累積未献金は、全期間表示なら最新月、月を選んでいればその月時点の値を出す
  // （他の4タイルが選択月スコープなのに、ここだけ常に最終月を指していた）
  const t = state.month
    ? titheRows.find((r) => r.month === state.month) ?? null
    : (titheRows.length ? titheRows[titheRows.length - 1] : null);

  // 全期間表示のとき、支出には不完全な月が混ざるが収入は満額入る。
  // 前月比では除外しているのに収支だけ素通しなのは筋が通らないので注記する。
  const incompleteIncluded = state.month === null && months.some((m) => m.incomplete);

  // 前月の値から数え上げる。0 から数えるより「先月からこう動いた」が伝わる
  const prevTotal = delta ? total - delta.d : null;
  const heroValue = el('div', { class: 'hero-value', html: yenFmt(total) + '<span class="unit">円</span>' });

  $('#hero').replaceChildren(
    el('div', { class: 'hero' }, [
      // ★ 数字を大きくするなら、何の数字かを同じ視界に残す。
      //   これが無いと1年後に「その月に口座から出た額」と誤読する
      el('div', { class: 'hero-label', text: `${label}（利用日ベース・カード明細＋固定費）` }),
      el('div', { class: 'hero-value-clip' }, [heroValue]),
      delta
        ? el('div', {
            class: 'hero-delta',
            html: `前月比 <span class="${delta.d >= 0 ? 'up' : 'down'}">${delta.d >= 0 ? '+' : '−'}${yenFmt(Math.abs(delta.d))}円（${delta.d >= 0 ? '+' : '−'}${Math.abs(delta.pct).toFixed(1)}%）</span> vs ${delta.prev}`,
          })
        : el('div', { class: 'hero-delta', text: `${rows.length}件の取引` }),
    ]),
    el('div', { class: 'tiles' }, [
      tile('取引件数', String(rows.length), '件'),
      tile('手取り収入', yenFmt(income), '円', state.month ? '給与明細より' : `${incomeMonths}ヶ月分`),
      // 収支は「プラスが良い」。支出の前月比（増＝赤）とは向きが逆なので注意
      income > 0
        ? tile('収支', yenFmt(income - total), '円',
            (income - total >= 0 ? '黒字' : '赤字') + (incompleteIncluded ? '（不完全な月を含む）' : ''),
            income - total >= 0 ? 'good' : 'bad')
        : tile('収支', '—', '', '収入データなし'),
      t ? tile('累積未献金', yenFmt(t.carryOver), '円', `${t.month} 時点`) : tile('累積未献金', '—', '', '収入データなし'),
      // ★ この1つだけ全期間スコープ。他4つと違うので必ず明示する
      tile('要確認', String(reviews.length), '件', reviews.length === 0 ? '全期間・なし' : '全期間・分類が未確定'),
    ].filter(Boolean)),
  );

  // 初回は前月値（無ければ0）から900ms、切替時は前の表示値から420ms。
  // 差が5%未満なら数えない（ちらつくだけで情報にならない）
  const from = firstPaint ? (prevTotal ?? 0) : (lastHeroTotal ?? total);
  const diffRatio = total === 0 ? 0 : Math.abs(total - from) / Math.abs(total);
  countTo(heroValue, from, total, diffRatio < 0.05 ? 0 : (firstPaint ? 900 : 420),
    '<span class="unit">円</span>');

  // 月を切り替えたとき、数字が下から起き上がる。カウントアップと同時に走らせて
  // 「別の数字に差し替わった」ではなく「新しい数字が据えられた」と感じさせる
  if (!REDUCE && !firstPaint) {
    heroValue.classList.add('is-rise');
    requestAnimationFrame(() => requestAnimationFrame(() => heroValue.classList.remove('is-rise')));
    setTimeout(() => heroValue.classList.remove('is-rise'), 500);   // rAF が来なくても必ず戻す
  }
  lastHeroTotal = total;
}

let lastHeroTotal = null;

/**
 * @param {'good'|'bad'|null} tone 値を着色する。色だけに意味を持たせないよう、
 *   sub の「黒字 / 赤字」という文字は必ず併記したまま残すこと
 */
function tile(label, value, unit, sub, tone) {
  return el('div', { class: 'tile' }, [
    el('div', { class: 'tile-label', text: label }),
    el('div', {
      class: 'tile-value' + (tone ? ` is-${tone}` : ''),
      html: value + (unit ? `<span class="unit">${unit}</span>` : ''),
    }),
    sub ? el('div', { class: 'tile-sub' + (tone ? ` is-${tone}` : ''), text: sub }) : null,
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
  const baseW = Math.min(24, band * 0.5);

  const svg = el('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet', role: 'img' });
  svg.appendChild(el('defs', {}, [
    el('pattern', { id: 'hatch', width: 6, height: 6, patternTransform: 'rotate(45)', patternUnits: 'userSpaceOnUse' }, [
      el('rect', { width: 6, height: 6, fill: 'var(--surface)' }),
      el('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: 'var(--warning-line)', 'stroke-width': 3, opacity: 0.55 }),
    ]),
  ]));

  months.forEach((m, i) => {
    const h = Math.max(2, (m.amount / max) * innerH);
    const selected = state.month === m.month;
    // 選択月は太く（手前）、それ以外は細く（奥）。band の中で変えるので隣と衝突しない
    const barW = state.month === null ? baseW
      : Math.min(band * 0.62, selected ? baseW * 1.34 : baseW * 0.82);
    const x = padL + band * i + (band - barW) / 2;
    const y = padT + innerH - h;

    // 4px の角丸データ端・ベースライン側は角なし
    const r = Math.min(4, h);
    const d = `M${x},${padT + innerH} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + barW - r},${y} Q${x + barW},${y} ${x + barW},${y + r} L${x + barW},${padT + innerH} Z`;
    // 選択月だけを手前に見せる。
    // ★ SVG の中では transform-style: preserve-3d が平坦化されるため translateZ は効かない
    //   （実測で確認済み）。代わりに「選択月は太く・濃く、他は細く・薄く」で
    //   奥行きを作る。幅は band の中で変えるので隣とぶつからない。
    const bar = el('path', {
      class: 'bar' + (selected ? ' is-sel' : ''),
      d, fill: m.incomplete ? 'url(#hatch)' : 'var(--series-1)',
      opacity: selected || state.month === null ? 1 : 0.42,
    });
    // 初回だけ左から順に立ち上げる。時間の経過を身体で分からせる。
    // ★ height や d ではなく transform を使う（毎フレームの再ラスタライズを避ける）
    // ★ transform-box: fill-box が無いと原点がSVG座標系になって崩れる
    if (!REDUCE && firstPaint) {
      bar.style.transformBox = 'fill-box';
      bar.style.transformOrigin = 'bottom';
      bar.style.transform = 'scaleY(0)';
      bar.style.transition = `transform var(--dur-figure) var(--e-figure) ${i * 55}ms`;
      requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.transform = 'scaleY(1)'; }));
    }
    svg.appendChild(bar);

    svg.appendChild(el('text', {
      class: 'lbl-value', x: x + barW / 2, y: y - 8, 'text-anchor': 'middle', text: yenFmt(m.amount),
    }));
    svg.appendChild(el('text', {
      x: padL + band * i + band / 2, y: padT + innerH + 17, 'text-anchor': 'middle',
      text: m.month.slice(5) + '月', fill: selected ? 'var(--ink)' : undefined,
    }));
    if (m.incomplete) {
      svg.appendChild(el('text', { x: padL + band * i + band / 2, y: padT + innerH + 32, 'text-anchor': 'middle', 'font-size': 10, fill: 'var(--warning-line)', 'font-weight': 600, text: '不完全' }));
    }

    const hit = el('rect', {
      class: 'hit', x: padL + band * i, y: padT, width: band, height: innerH,
      'aria-hidden': 'true',
      // チップと挙動を揃える（以前は再クリックで全期間に戻るトグルで、
      // 「もう一度見ようとしたら全期間に戻った」という事故になっていた）
      onclick: () => selectMonth(m.month),
    });
    bindTip(
      hit,
      () => `<div class="t-val">${yenFmt(m.amount)}円</div><div class="t-sub">${esc(m.month)}・${m.count}件${m.incomplete ? '・明細範囲外あり' : ''}</div>`,
      { onShow: () => bar.classList.add('is-hover'), onHide: () => bar.classList.remove('is-hover') },
    );
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

/**
 * 水道光熱費の内訳別推移（電気・ガス・水道）。
 *
 * 合算の棒グラフでは「今月は光熱費が高い」までしか分からない。
 * 光熱費は季節で動くものと、単価改定で恒久的に上がるものが混ざるため、
 * 内訳を重ねて初めて「どれが上がったのか」が読める。
 *
 * ★ 棒ではなく折れ線にしている。棒は「その月の量」、線は「変化の向き」を見せる図で、
 *   ここで知りたいのは後者（季節の山と、去年より上か下か）。
 * ★ 請求のない月は点を打たず、その区間だけ破線でまたぐ。
 *   0 として床に落とすと「使わなかった月」に見え、線を切ると推移が読めなくなる。
 */
function renderUtilities() {
  const host = $('#utilities');
  host.replaceChildren();

  const ut = utilityTrend(TX, months);
  if (ut.series.length === 0) {
    host.appendChild(el('div', { class: 'empty', text: '水道光熱費の記録がありません' }));
    return;
  }

  // 系列色は内訳に固定で結びつける。月や並び順で変わると月間比較が壊れる
  const TONE = { 電気: 'var(--series-2)', ガス: 'var(--series-3)', 水道: 'var(--series-1)' };
  const toneOf = (name) => TONE[name] ?? 'var(--muted)';

  const W = 860, H = 250, padL = 8, padR = 52, padT = 22, padB = 42;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const band = innerW / ut.months.length;
  // 軸の上限は実額そのままではなく切りのいい値に上げる。
  // 目盛りが最大額そのものだと基準として使えず、線の高さを額に変換できない
  const unit = Math.pow(10, Math.max(0, Math.floor(Math.log10(ut.max)) - 1)) * 5;
  const top = Math.max(unit, Math.ceil(ut.max / unit) * unit);
  const cx = (i) => padL + band * i + band / 2;
  const cy = (v) => padT + innerH - (v / top) * innerH;

  const svg = el('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet', role: 'img' });

  // 左から開くワイプ。線を stroke-dashoffset で描くと破線区間が壊れるためクリップで送る
  const clipId = 'util-clip';
  const wipe = el('rect', { x: 0, y: 0, width: W, height: H });
  svg.appendChild(el('defs', {}, [el('clipPath', { id: clipId }, [wipe])]));

  // 目盛り（3本）。折れ線は基準線がないと高さを読めない
  for (const f of [0, 0.5, 1]) {
    const v = top * f;
    const y = cy(v);
    svg.appendChild(el('line', { class: f === 0 ? 'baseline' : 'gridline', x1: padL, y1: y, x2: W - padR, y2: y }));
    svg.appendChild(el('text', { class: 'lbl-axis', x: W - padR + 6, y: y + 4, text: f === 0 ? '0' : yenFmt(v) }));
  }

  // 月ラベル
  ut.months.forEach((m, i) => {
    const selected = state.month === m.month;
    svg.appendChild(el('text', {
      x: cx(i), y: padT + innerH + 17, 'text-anchor': 'middle',
      text: m.month.slice(5) + '月', fill: selected ? 'var(--ink)' : undefined,
    }));
    if (m.incomplete) {
      svg.appendChild(el('text', {
        x: cx(i), y: padT + innerH + 31, 'text-anchor': 'middle',
        'font-size': 10, fill: 'var(--warning-line)', 'font-weight': 600, text: '不完全',
      }));
    }
  });

  const plot = el('g', { 'clip-path': `url(#${clipId})` });
  const labels = [];
  let hasGap = false;

  for (const s of ut.series) {
    const pts = s.points
      .map((p, i) => ({ ...p, i, x: cx(i), y: p.amount === null ? null : cy(p.amount) }))
      .filter((p) => p.y !== null);
    if (pts.length === 0) continue;

    const color = toneOf(s.name);

    // 隣り合う月どうしは実線、請求のない月をまたぐ区間は破線
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k];
      const gap = b.i - a.i > 1;
      if (gap) hasGap = true;
      plot.appendChild(el('line', {
        class: 'util-line' + (gap ? ' is-gap' : ''),
        x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: color,
      }));
    }

    for (const p of pts) {
      plot.appendChild(el('circle', { class: 'util-dot', cx: p.x, cy: p.y, r: 3.5, fill: color }));
    }

    // 値ラベルは最新の点だけ。全部に付けると3系列で重なって読めなくなる
    const last = pts[pts.length - 1];
    labels.push({ x: last.x, y: last.y - 10, i: last.i, color, text: yenFmt(last.amount) });
  }

  // 直近の請求月が同じ系列どうしはラベルが重なる（実際に潰れて読めなくなった）。
  // ★ 下ではなく上へ逃がす。下へ押すと自分の点や下の系列の線に重なり、
  //   重なりを直したはずが別の読みにくさに変わる
  const GAP = 14;
  labels.sort((a, b) => b.y - a.y);
  for (let k = 1; k < labels.length; k++) {
    if (labels[k].x !== labels[k - 1].x) continue;
    if (labels[k - 1].y - labels[k].y < GAP) labels[k].y = labels[k - 1].y - GAP;
  }
  for (const L of labels) {
    plot.appendChild(el('text', {
      class: 'lbl-value', x: L.x, y: L.y, 'text-anchor': L.i >= ut.months.length - 1 ? 'end' : 'middle',
      fill: L.color, text: L.text,
    }));
  }
  svg.appendChild(plot);

  if (!REDUCE && firstPaint) {
    wipe.style.transformBox = 'fill-box';
    wipe.style.transformOrigin = 'left';
    wipe.style.transform = 'scaleX(0)';
    wipe.style.transition = 'transform var(--dur-figure) var(--e-figure) 120ms';
    requestAnimationFrame(() => requestAnimationFrame(() => { wipe.style.transform = 'scaleX(1)'; }));
  }

  // ホバー：その月の全内訳をまとめて出す。系列ごとに拾わせると比較にならない
  const guide = el('line', { class: 'util-guide', x1: 0, y1: padT, x2: 0, y2: padT + innerH, opacity: 0 });
  svg.appendChild(guide);

  ut.months.forEach((m, i) => {
    const rows = ut.series.map((s) => {
      const p = s.points[i];
      const val = p && p.amount !== null ? `${yenFmt(p.amount)}円` : '請求なし';
      return `<div class="t-row"><span class="t-key"><span class="legend-swatch" style="background:${toneOf(s.name)}"></span>${esc(s.name)}</span><span>${val}</span></div>`;
    }).join('');
    const sum = ut.series.reduce((a, s) => a + (s.points[i]?.amount ?? 0), 0);

    const hit = el('rect', {
      class: 'hit', x: padL + band * i, y: padT, width: band, height: innerH, 'aria-hidden': 'true',
      onclick: () => selectMonth(m.month),
    });
    bindTip(
      hit,
      () => `<div class="t-val">${yenFmt(sum)}円</div><div class="t-sub">${esc(m.month)}${m.incomplete ? '・明細範囲外あり' : ''}</div>${rows}`,
      {
        onShow: () => { guide.setAttribute('x1', cx(i)); guide.setAttribute('x2', cx(i)); guide.setAttribute('opacity', 1); },
        onHide: () => guide.setAttribute('opacity', 0),
      },
    );
    hit.style.cursor = 'pointer';
    svg.appendChild(hit);
  });

  host.appendChild(svg);

  // 凡例は色の対応表であると同時に、直近額・平均・前回比の要約でもある
  const legend = el('div', { class: 'util-legend' });
  for (const s of ut.series) {
    const d = s.latest && s.prev ? s.latest.amount - s.prev.amount : null;
    legend.appendChild(el('div', { class: 'util-legend-item' }, [
      el('span', { class: 'legend-swatch', style: `background: ${toneOf(s.name)}` }),
      el('span', { class: 'util-legend-name', text: s.name }),
      el('span', { class: 'util-legend-val' }, [
        el('b', { text: s.latest ? `${yenFmt(s.latest.amount)}円` : '—' }),
        el('span', { class: 'util-legend-sub', text: s.latest ? `（${s.latest.month.slice(5)}月）` : '' }),
      ]),
      d === null ? el('span', { class: 'util-legend-delta', text: '' })
        : el('span', { class: 'util-legend-delta ' + (d > 0 ? 'is-up' : d < 0 ? 'is-down' : ''), text: d === 0 ? '±0' : `${d > 0 ? '+' : '−'}${yenFmt(Math.abs(d))}` }),
      el('span', { class: 'util-legend-avg', text: `平均 ${yenFmt(s.avg)}円 / ${s.paidCount}回` }),
    ]));
  }
  host.appendChild(legend);

  if (hasGap) {
    host.appendChild(el('div', { class: 'util-note', text: '点線は請求のない月をまたいだ区間（隔月請求など）。「不完全」の月はカード明細の範囲外の日を含むため、実額より少なく出る。' }));
  }
}

/**
 * 固定費の値上がり検知。
 *
 * ★ 「定着したもの」と「直近1ヶ月だけのもの」を分けて出す。
 *   ドル建てのサブスクは為替で毎月動くため、1ヶ月だけの変化を改定として断定すると
 *   毎月それらしい警告が出て、本当の値上げが埋もれる。
 *   決めつけずに「様子見」として弱く置く。
 */
function renderPriceChanges() {
  const host = $('#pricechanges');
  host.replaceChildren();

  const rows = priceChanges(TX, DATA.fixedCosts, months);
  const settled = rows.filter((r) => r.settled);
  const watching = rows.filter((r) => !r.settled);

  if (rows.length === 0) {
    host.appendChild(el('div', { class: 'empty', text: '金額が変わった固定費はありません' }));
    return;
  }

  const section = (list, title, note, weak) => {
    if (list.length === 0) return;
    host.appendChild(el('div', { class: 'pc-head' }, [
      el('span', { class: 'pc-head-title', text: title }),
      el('span', { class: 'pc-head-note', text: note }),
    ]));
    for (const r of list) {
      const spark = el('span', { class: 'pc-spark' });
      const max = Math.max(...r.series.map((p) => p.amount), 1);
      for (const p of r.series) {
        const bar = el('i', { title: `${p.month} ${yenFmt(p.amount)}円` });
        bar.style.height = `${Math.max(12, (p.amount / max) * 100)}%`;
        bar.style.background = p.amount === r.to ? 'var(--series-1)' : 'var(--baseline)';
        spark.appendChild(bar);
      }
      host.appendChild(el('div', { class: 'pc-row' + (weak ? ' is-weak' : '') }, [
        el('div', { class: 'pc-name' }, [
          el('b', { text: r.name }),
          el('span', { class: 'pc-cat', text: `${r.category}${r.subcategory ? ' / ' + r.subcategory : ''}` }),
        ]),
        spark,
        el('div', { class: 'pc-move' }, [
          el('span', { class: 'pc-from', text: `${yenFmt(r.from)}円` }),
          el('span', { class: 'pc-arrow', text: '→' }),
          el('span', { class: 'pc-to', text: `${yenFmt(r.to)}円` }),
        ]),
        el('div', { class: 'pc-diff ' + (r.up ? 'is-up' : 'is-down') }, [
          el('b', { text: `${r.up ? '+' : '−'}${yenFmt(Math.abs(r.diff))}` }),
          el('span', { class: 'pc-annual', text: `年 ${r.up ? '+' : '−'}${yenFmt(Math.abs(r.annualImpact))}円` }),
        ]),
        el('div', { class: 'pc-when', text: `${r.month.slice(5)}月から${r.settled ? `・${r.stableMonths}ヶ月継続` : ''}` }),
      ]));
    }
  };

  section(settled, '継続している改定', '2ヶ月以上同じ額が続いている');
  section(watching, '様子見', '直近1ヶ月だけの変化。為替や購入内容の違いかもしれない', true);

  host.appendChild(el('div', { class: 'hint', text: '光熱費は季節で動くのが正常なため監視していません。収入に比例する費目も同様です。' }));
}

/**
 * 年間コミット額 — 「今の契約を続けると1年でいくら出ていくか」。
 *
 * ★ サブスクは店ごとに分解する。マスタでは1行にまとまっているが、
 *   それでは「どれをやめると年いくら浮くか」に答えられない。
 */
function renderAnnual() {
  const host = $('#annual');
  host.replaceChildren();

  const ac = annualCommitment(DATA.fixedCosts, TX, months);
  if (ac.rows.length === 0) {
    host.appendChild(el('div', { class: 'empty', text: '固定費が登録されていません' }));
    return;
  }

  const head = el('div', { class: 'annual-total' }, [
    el('div', { class: 'annual-total-value' }, [
      el('b', { text: yenFmt(ac.total) }),
      el('span', { class: 'annual-unit', text: '円 / 年' }),
    ]),
    el('div', { class: 'annual-total-sub', text: `月あたり ${yenFmt(Math.round(ac.total / 12))}円` }),
  ]);
  host.appendChild(head);

  if (ac.estimated) {
    host.appendChild(el('div', { class: 'annual-note' }, [
      `${ac.observedMonths}ヶ月分の実績からの推定です。請求の間隔（毎月・隔月・年1回）を判定して年額に直しています。`,
    ]));
  }

  const CADENCE = { monthly: '毎月', bimonthly: '隔月', yearly: '年1回', irregular: '不定期' };
  const max = Math.max(...ac.rows.map((r) => r.annual), 1);

  const list = el('div', { class: 'annual-list' });
  for (const r of ac.rows) {
    const bar = el('div', { class: 'annual-bar' });
    bar.style.width = `${Math.max(1, (r.annual / max) * 100)}%`;
    list.appendChild(el('div', { class: 'annual-row' }, [
      el('div', { class: 'annual-name' }, [
        el('span', { text: r.name, title: r.name }),
        el('span', { class: 'annual-cadence', text: CADENCE[r.cadence] ?? '' }),
      ]),
      el('div', { class: 'annual-track' }, [bar]),
      el('div', { class: 'annual-value', text: `${yenFmt(r.annual)}円` }),
    ]));
  }
  host.appendChild(list);

  if (ac.subscriptions.length > 0) {
    host.appendChild(el('div', { class: 'pc-head' }, [
      el('span', { class: 'pc-head-title', text: 'サブスクの内訳' }),
      el('span', { class: 'pc-head-note', text: `合計 ${yenFmt(ac.subscriptionTotal)}円 / 年・やめた分だけ浮く` }),
    ]));
    // 上の一覧はマスタの1行をまとめて月平均から出しているため、店ごとに
    // 請求間隔（毎月・年1回）を判定したこちらとは額が食い違う。こちらのほうが正確
    host.appendChild(el('div', {
      class: 'annual-note',
      text: '店ごとに請求の間隔を判定しているため、上の一覧の「サブスク」行より正確です。',
    }));
    const subs = el('div', { class: 'annual-list' });
    const smax = Math.max(...ac.subscriptions.map((r) => r.annual), 1);
    for (const r of ac.subscriptions) {
      const bar = el('div', { class: 'annual-bar is-sub' });
      bar.style.width = `${Math.max(1, (r.annual / smax) * 100)}%`;
      subs.appendChild(el('div', { class: 'annual-row' }, [
        el('div', { class: 'annual-name' }, [
          el('span', { text: r.merchant, title: r.merchant }),
          el('span', { class: 'annual-cadence', text: CADENCE[r.cadence] ?? '' }),
        ]),
        el('div', { class: 'annual-track' }, [bar]),
        el('div', { class: 'annual-value', text: `${yenFmt(r.annual)}円` }),
      ]));
    }
    host.appendChild(subs);
  }
}

/**
 * カテゴリの「いつもの幅」。
 *
 * 過去の月の最小〜最大を帯で敷き、今月の位置を点で打つ。
 * 帯の外に出たものだけを色で拾う。前月比と違い「たまたま高い月」に振り回されない。
 */
function renderBands() {
  const host = $('#bands');
  host.replaceChildren();

  const cb = categoryBands(TX, months, state.month);
  if (!cb.available) {
    host.appendChild(el('div', {
      class: 'empty',
      text: state.month
        ? '比較できる月がまだ足りません（完全な月が4ヶ月必要です）'
        : '月を選ぶと、その月が「いつもの幅」に収まっているか分かります',
    }));
    return;
  }

  const outliers = cb.rows.filter((r) => r.status !== 'normal');
  host.appendChild(el('div', { class: 'bands-lead' }, [
    outliers.length === 0
      ? `${state.month} は、どのカテゴリも過去 ${cb.baseMonths}ヶ月の幅に収まっています。`
      : `過去 ${cb.baseMonths}ヶ月の幅から外れたのは ${outliers.length}件です。`,
  ]));

  const max = Math.max(...cb.rows.map((r) => Math.max(r.current, r.max)), 1);
  const pct = (v) => `${(v / max) * 100}%`;

  for (const r of cb.rows) {
    const track = el('div', { class: 'band-track' });

    // 「いつもの幅」（最小〜最大）
    if (!r.neverBefore) {
      const band = el('div', { class: 'band-range' });
      band.style.left = pct(r.min);
      band.style.width = `${Math.max(0.6, ((r.max - r.min) / max) * 100)}%`;
      track.appendChild(band);

      const med = el('div', { class: 'band-median', title: `中央値 ${yenFmt(r.median)}円` });
      med.style.left = pct(r.median);
      track.appendChild(med);
    }

    const dot = el('div', { class: `band-dot is-${r.status}`, title: `${state.month} ${yenFmt(r.current)}円` });
    dot.style.left = pct(r.current);
    track.appendChild(dot);

    const label = r.status === 'new' ? '初めて'
      : r.status === 'high' ? '過去最高'
        : r.status === 'low' ? '過去最低' : '';

    const row = el('div', { class: `band-row is-${r.status}` }, [
      el('div', { class: 'band-name', text: r.category, title: r.category }),
      track,
      el('div', { class: 'band-value' }, [
        el('b', { text: yenFmt(r.current) }),
        label ? el('span', { class: `band-tag is-${r.status}`, text: label }) : null,
      ]),
    ]);

    bindTip(row, () => {
      if (r.neverBefore) {
        return `<div class="t-val">${yenFmt(r.current)}円</div><div class="t-sub">${esc(r.category)}</div>`
          + `<div class="t-row"><span class="t-key">過去${r.baseCount}ヶ月</span><span>発生なし</span></div>`;
      }
      const d = r.vsMedian;
      return `<div class="t-val">${yenFmt(r.current)}円</div><div class="t-sub">${esc(r.category)}・${esc(state.month)}</div>`
        + `<div class="t-row"><span class="t-key">いつもの幅</span><span>${yenFmt(r.min)} 〜 ${yenFmt(r.max)}円</span></div>`
        + `<div class="t-row"><span class="t-key">中央値</span><span>${yenFmt(r.median)}円</span></div>`
        + `<div class="t-row"><span class="t-key">中央値との差</span><span>${d >= 0 ? '+' : '−'}${yenFmt(Math.abs(d))}円</span></div>`
        + `<div class="t-row"><span class="t-key">比較した月数</span><span>${r.baseCount}ヶ月</span></div>`;
    });
    host.appendChild(row);
  }

  host.appendChild(el('div', { class: 'hint', text: '帯は過去の月の最小〜最大、縦線は中央値。不完全な月は比較に使っていません。' }));
}

/**
 * 日別カレンダー。
 *
 * ★ 既定では固定費を除く。引落日が未確認で月初に寄せてあるため、
 *   混ぜると初日だけが濃くなって日々の使い方が読めない。
 */
function renderCalendar() {
  const host = $('#calendar');
  host.replaceChildren();

  const month = state.month ?? (months.length ? months[months.length - 1].month : null);
  const dt = dailyTotals(TX, month, state.calFixed);
  if (!dt) { host.appendChild(el('div', { class: 'empty', text: 'データがありません' })); return; }

  host.appendChild(el('div', { class: 'cal-head' }, [
    el('div', { class: 'cal-sum' }, [
      el('b', { text: `${yenFmt(dt.total)}円` }),
      el('span', { text: `・使った日 ${dt.spentDays}日／使わなかった日 ${dt.zeroDays}日` }),
    ]),
    el('button', {
      class: 'cal-toggle' + (state.calFixed ? ' is-on' : ''),
      type: 'button',
      text: state.calFixed ? '固定費を含む' : '変動費のみ',
      onclick: () => { state.calFixed = !state.calFixed; renderCalendar(); },
    }),
  ]));

  const grid = el('div', { class: 'cal-grid' });
  for (const w of ['日', '月', '火', '水', '木', '金', '土']) {
    grid.appendChild(el('div', { class: 'cal-wd', text: w }));
  }
  for (let i = 0; i < dt.leading; i++) grid.appendChild(el('div', { class: 'cal-cell is-empty' }));

  for (const c of dt.cells) {
    const cell = el('div', {
      class: 'cal-cell' + (c.amount === 0 ? ' is-zero' : '') + (c.weekday === 0 || c.weekday === 6 ? ' is-weekend' : ''),
    }, [
      el('span', { class: 'cal-day', text: String(c.day) }),
      c.amount > 0 ? el('span', { class: 'cal-amt', text: yenFmt(c.amount) }) : null,
    ]);
    if (c.amount > 0) {
      // 濃さは平方根で。金額に比例させると突出した1日だけが濃く、他が全部白くなる
      const k = Math.sqrt(c.amount / dt.max);
      cell.style.background = `color-mix(in srgb, var(--series-1) ${Math.round(k * 78)}%, var(--surface))`;
      if (k > 0.62) cell.classList.add('is-dark');
    }
    bindTip(cell, () => {
      if (c.amount === 0) return `<div class="t-val">0円</div><div class="t-sub">${esc(c.date)}</div>`;
      const top = c.items.slice(0, 4)
        .map((t) => `<div class="t-row"><span class="t-key">${esc(t.merchant)}</span><span>${yenFmt(t.amount)}円</span></div>`)
        .join('');
      const rest = c.items.length > 4 ? `<div class="t-row"><span class="t-key">ほか ${c.items.length - 4}件</span><span></span></div>` : '';
      return `<div class="t-val">${yenFmt(c.amount)}円</div><div class="t-sub">${esc(c.date)}・${c.count}件</div>${top}${rest}`;
    });
    grid.appendChild(cell);
  }
  host.appendChild(grid);

  if (!state.calFixed && dt.fixedTotal > 0) {
    host.appendChild(el('div', {
      class: 'hint',
      text: `固定費 ${yenFmt(dt.fixedTotal)}円は日付を持たない（引落日が未確認で月初に寄せている）ため、既定では外しています。`,
    }));
  }
}

/**
 * 固定費と変動費に分けた月次推移。
 *
 * 積み上げにすると、下に置いた側だけが底から伸びて読みやすく、
 * 上に載せた側は基線が動くため変化が読めない。
 * ここで見たいのは変動費の増減なので、変動費を下に置く。
 */
function renderVariableTrend() {
  const host = $('#vartrend');
  host.replaceChildren();

  const vt = variableTrend(TX, months);
  if (vt.points.length === 0) {
    host.appendChild(el('div', { class: 'empty', text: 'データがありません' }));
    return;
  }

  const W = 860, H = 250, padL = 8, padR = 52, padT = 26, padB = 42;
  const innerW = W - padL - padR, innerH = H - padT - padB;
  const band = innerW / vt.points.length;
  const barW = Math.min(30, band * 0.56);

  const unit = Math.pow(10, Math.max(0, Math.floor(Math.log10(vt.max)) - 1)) * 5;
  const top = Math.max(unit, Math.ceil(vt.max / unit) * unit);

  const svg = el('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet', role: 'img' });
  svg.appendChild(el('defs', {}, [
    el('pattern', { id: 'hatch-v', width: 6, height: 6, patternTransform: 'rotate(45)', patternUnits: 'userSpaceOnUse' }, [
      el('rect', { width: 6, height: 6, fill: 'var(--surface)' }),
      el('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: 'var(--warning-line)', 'stroke-width': 3, opacity: 0.55 }),
    ]),
  ]));

  for (const f of [0, 0.5, 1]) {
    const y = padT + innerH - f * innerH;
    svg.appendChild(el('line', { class: f === 0 ? 'baseline' : 'gridline', x1: padL, y1: y, x2: W - padR, y2: y }));
    svg.appendChild(el('text', { class: 'lbl-axis', x: W - padR + 6, y: y + 4, text: f === 0 ? '0' : yenFmt(top * f) }));
  }

  // 変動費の平均線。今月がいつもより上か下かを、目で1回で捉えられる。
  // ★ ラベルは棒の上ではなく右の余白に置く。棒に重ねると必ずどれかと衝突する
  if (vt.avgVariable) {
    const ay = padT + innerH - (vt.avgVariable / top) * innerH;
    svg.appendChild(el('line', { class: 'avg-line', x1: padL, y1: ay, x2: W - padR, y2: ay }));
    svg.appendChild(el('text', {
      class: 'lbl-axis', x: W - padR + 6, y: ay + 4,
      fill: 'var(--series-1)', text: yenFmt(vt.avgVariable),
    }));
  }

  vt.points.forEach((p, i) => {
    const x = padL + band * i + (band - barW) / 2;
    const hv = (p.variable / top) * innerH;
    const hf = (p.fixed / top) * innerH;
    const yv = padT + innerH - hv;
    const yf = yv - hf;
    const selected = state.month === p.month;
    const dim = state.month !== null && !selected;

    // 変動費（下）
    const rv = el('rect', {
      class: 'vt-seg', x, y: yv, width: barW, height: Math.max(1, hv),
      fill: p.incomplete ? 'url(#hatch-v)' : 'var(--series-1)', opacity: dim ? 0.42 : 1,
    });
    // 固定費（上）
    const rf = el('rect', {
      class: 'vt-seg', x, y: yf, width: barW, height: Math.max(1, hf),
      fill: p.incomplete ? 'url(#hatch-v)' : 'var(--series-3)', opacity: dim ? 0.3 : 0.72,
    });
    if (!REDUCE && firstPaint) {
      for (const [r, d] of [[rv, i * 55], [rf, i * 55 + 90]]) {
        r.style.transformBox = 'fill-box';
        r.style.transformOrigin = 'bottom';
        r.style.transform = 'scaleY(0)';
        r.style.transition = `transform var(--dur-figure) var(--e-figure) ${d}ms`;
        requestAnimationFrame(() => requestAnimationFrame(() => { r.style.transform = 'scaleY(1)'; }));
      }
    }
    svg.appendChild(rf);
    svg.appendChild(rv);

    svg.appendChild(el('text', {
      class: 'lbl-value', x: x + barW / 2, y: yv - 6, 'text-anchor': 'middle',
      fill: 'var(--series-1)', text: yenFmt(p.variable),
    }));
    svg.appendChild(el('text', {
      x: padL + band * i + band / 2, y: padT + innerH + 17, 'text-anchor': 'middle',
      text: p.month.slice(5) + '月', fill: selected ? 'var(--ink)' : undefined,
    }));
    if (p.incomplete) {
      svg.appendChild(el('text', {
        x: padL + band * i + band / 2, y: padT + innerH + 31, 'text-anchor': 'middle',
        'font-size': 10, fill: 'var(--warning-line)', 'font-weight': 600, text: '不完全',
      }));
    }

    const hit = el('rect', {
      class: 'hit', x: padL + band * i, y: padT, width: band, height: innerH, 'aria-hidden': 'true',
      onclick: () => selectMonth(p.month),
    });
    bindTip(hit, () => {
      const share = p.total ? (p.variable / p.total) * 100 : 0;
      return `<div class="t-val">${yenFmt(p.variable)}円</div>`
        + `<div class="t-sub">${esc(p.month)} の変動費${p.incomplete ? '・明細範囲外あり' : ''}</div>`
        + `<div class="t-row"><span class="t-key"><span class="legend-swatch" style="background:var(--series-1)"></span>変動費</span><span>${yenFmt(p.variable)}円</span></div>`
        + `<div class="t-row"><span class="t-key"><span class="legend-swatch" style="background:var(--series-3)"></span>固定費</span><span>${yenFmt(p.fixed)}円</span></div>`
        + `<div class="t-row"><span class="t-key">変動費の割合</span><span>${share.toFixed(1)}%</span></div>`;
    });
    hit.style.cursor = 'pointer';
    svg.appendChild(hit);
  });

  host.appendChild(svg);
  host.appendChild(el('div', { class: 'legend' }, [
    el('span', { class: 'legend-item' }, [el('span', { class: 'legend-swatch', style: 'background: var(--series-1)' }), '変動費（自分で動かせる分）']),
    el('span', { class: 'legend-item' }, [el('span', { class: 'legend-swatch', style: 'background: var(--series-3); opacity:.72' }), '固定費']),
    el('span', { class: 'legend-item' }, [el('span', { class: 'legend-swatch hatched' }), '不完全な月']),
    el('span', { class: 'legend-item' }, [el('span', { class: 'legend-dash' }), '変動費の平均（完全な月のみ）']),
  ]));
}

/** 期間フィルタに追随するカードに、対象期間を明示する（追随しないカードと見分けるため） */
function scopeLabel() {
  return state.month ?? '全期間';
}

/**
 * 「今月の色」— その期間のデータから地の色を決める。
 *
 * 乱数を使わないので、同じデータなら必ず同じ色になる（再現性がある）。
 * 月ごとに画面の空気が変わることで「あの赤かった月」が記憶の索引になる。
 *
 * ★ 変えるのは背景だけ。系列色（--series-*）には触れない。
 *   月ごとに系列色が変わると、月をまたいだ比較が成立しなくなる。
 */
function applyMonthTone() {
  const rows = byCategory(TX, state.month);
  const total = rows.reduce((a, c) => a + c.amount, 0);
  const root = document.documentElement.style;
  if (total <= 0) { root.setProperty('--month-a', '0'); return; }

  // カテゴリ構成の集中度。1つに偏っていれば0、まんべんなく散っていれば1
  const share = rows.map((c) => c.amount / total).filter((p) => p > 0);
  const ent = share.length > 1
    ? -share.reduce((a, p) => a + p * Math.log2(p), 0) / Math.log2(share.length)
    : 0;

  const income = state.month
    ? (DATA.incomes ?? []).filter((i) => i.date.slice(0, 7) === state.month).reduce((a, i) => a + (i.net_amount ?? 0), 0)
    : (DATA.incomes ?? []).reduce((a, i) => a + (i.net_amount ?? 0), 0);
  const bal = income > 0 ? (income - total) / income : 0;

  /* 色相を連続的に動かすと、青(208)から暖色(20)へ行く途中で紫や黄を通り、
     何の色なのか読めなくなる。そこで「黒字＝青緑 / 赤字＝暖色」の2つの
     アンカーに寄せ、強さ（彩度と濃度）で程度を表す。
     こうすると「あの赤かった月」がひと目で思い出せる。
     ※ 収支が5%以内ならどちらにも寄せない（誤差で色が跳ぶのを防ぐ） */
  const t = Math.max(-1, Math.min(1, bal * 4));   // ±25%で振り切る
  let hue, strength;
  if (Math.abs(bal) < 0.05) { hue = 208; strength = 0.15; }
  else if (t > 0) { hue = 178; strength = t; }     // 黒字 → 青緑
  else { hue = 18; strength = -t; }                // 赤字 → 暖色
  if (risk && !risk.covered) { hue = 8; strength = 1; }  // 残高不足は必ず警戒色

  root.setProperty('--month-h', hue.toFixed(1));
  root.setProperty('--month-s', (18 + ent * 10 + strength * 32).toFixed(1) + '%');
  root.setProperty('--month-a', (0.05 + strength * 0.11).toFixed(3));   // 上からの光
  root.setProperty('--month-a2', (0.02 + strength * 0.06).toFixed(3));  // 画面全体の地
}

/** 増減の表示。支出は「増えたら赤」（家計では増加が悪い） */
function deltaEl(delta, isNew) {
  if (isNew) return el('span', { class: 'barrow-delta is-new', text: '新規' });
  if (delta === null || delta === 0) return el('span', { class: 'barrow-delta is-flat', text: '±0' });
  return el('span', {
    class: 'barrow-delta ' + (delta > 0 ? 'is-up' : 'is-down'),
    text: (delta > 0 ? '▲ +' : '▼ −') + yenFmt(Math.abs(delta)),
  });
}

/** カテゴリ別（横棒・単一色のランキング）。値と構成比を直接ラベルする＝表を兼ねる。 */
function renderCategories() {
  const host = $('#categories');
  const { rows: cats, prevMonth, disappeared } = byCategoryWithDelta(TX, state.month, months);
  $('#cat-note').textContent = scopeLabel() + (prevMonth ? `　前月比 vs ${prevMonth}` : '');
  const total = cats.reduce((a, c) => a + c.amount, 0);
  host.replaceChildren();
  if (cats.length === 0) { host.appendChild(el('div', { class: 'empty', text: 'この期間の支出はありません' })); return; }
  const max = Math.max(...cats.map((c) => c.amount), 1);

  const list = el('div', { class: 'barlist' });
  let ri = 0;
  for (const c of cats) {
    const pct = total ? (c.amount / total) * 100 : 0;
    const subs = c.subs.filter((s) => s.name !== '—').slice(0, 4);
    const tipDelta = prevMonth && !c.isNew && c.delta !== null
      ? `<div class="t-sub">前月 ${yenFmt(c.prevAmount)}円 → ${c.delta >= 0 ? '+' : '−'}${yenFmt(Math.abs(c.delta))}円</div>` : '';
    list.appendChild(el('div', { class: 'barrow' }, [
      el('div', { class: 'barrow-name', text: c.category, title: c.category }),
      el('div', { class: 'barrow-track' }, [
        (() => {
          const fill = el('div', {
            class: 'barrow-fill',
            style: `width: ${Math.max(0.4, (c.amount / max) * 100)}%`,
          });
          bindTip(fill, () => `<div class="t-val">${yenFmt(c.amount)}円</div><div class="t-sub">${esc(c.category)}・${c.count}件・${pct.toFixed(1)}%</div>${tipDelta}`);
          // 最終幅のまま scaleX(0)→1。width を動かすと毎フレーム再レイアウトになり、
          // かつ角丸が横に引き伸ばされて歪む
          if (!REDUCE && firstPaint) {
            const d = ri * 40;
            fill.style.transformOrigin = 'left';
            fill.style.transform = 'scaleX(0)';
            fill.style.transition = `transform 620ms var(--e-figure) ${d}ms`;
            requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.transform = 'scaleX(1)'; }));
          }
          ri++;
          return fill;
        })(),
      ]),
      el('div', { class: 'barrow-val' }, [
        el('span', { text: yenFmt(c.amount) }),
        el('span', { class: 'barrow-pct', text: `${pct.toFixed(1)}%` }),
        prevMonth ? deltaEl(c.delta, c.isNew) : null,
      ].filter(Boolean)),
      subs.length > 1
        ? el('div', { class: 'barrow-subs', text: subs.map((s) => `${s.name} ${yenFmt(s.amount)}`).join('　/　') })
        : null,
    ]));
  }
  host.appendChild(list);

  // 前月にあって今月ゼロになったカテゴリ。「最も減ったもの」なのに
  // 行が存在しないため、リストだけでは絶対に気づけない
  if (disappeared.length > 0) {
    host.appendChild(el('div', {
      class: 'hint',
      text: `前月にあって今月なし：${disappeared.map((d) => `${d.category} −${yenFmt(d.amount)}`).join('　/　')}`,
    }));
  }
}

/** 固定費と変動費（2系列＝凡例必須） */
function renderFixedSplit() {
  const host = $('#fixedsplit');
  $('#split-note').textContent = scopeLabel();
  const fv = fixedVsVariable(TX, state.month);
  host.replaceChildren();
  if (fv.total <= 0) { host.appendChild(el('div', { class: 'empty', text: 'データがありません' })); return; }
  const fPct = (fv.fixed / fv.total) * 100;

  const segFixed = el('div', { class: 'split-seg s1', style: `width: ${Math.max(fPct, 0.5)}%` });
  const segVar = el('div', { class: 'split-seg s2', style: `width: ${Math.max(100 - fPct, 0.5)}%` });
  bindTip(segFixed, () => `<div class="t-val">${yenFmt(fv.fixed)}円</div><div class="t-sub">固定費・${fPct.toFixed(1)}%</div>`);
  bindTip(segVar, () => `<div class="t-val">${yenFmt(fv.variable)}円</div><div class="t-sub">変動費・${(100 - fPct).toFixed(1)}%</div>`);
  host.appendChild(el('div', { class: 'split' }, [segFixed, segVar]));
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
  // 注記はデータから生成する。以前は「口座振替分は未登録」と固定文で書いていたが、
  // 家賃などを登録した時点で嘘になり、二重に足し算する事故につながっていた。
  const methods = new Map([['bank_transfer', '口座振替'], ['card', 'カード'], ['cash', '現金']]);
  const used = new Set();
  for (const t of TX) {
    if (!t.is_fixed_cost) continue;
    if (state.month && t.date.slice(0, 7) !== state.month) continue;
    used.add(methods.get(t.payment_method) ?? (t.source === 'card' ? 'カード' : 'その他'));
  }
  // 警告するのは「生成する設定なのに金額が無い」ものだけ。
  // auto_generate: false のもの（イオンカード払い）は CSV に実額が出るため
  // amount が null でも集計から漏れていない。ここを区別しないと注記自体が嘘になる。
  const unset = (DATA.fixedCosts ?? []).filter(
    (f) => f.auto_generate === true && f.amount === null && f.amount_type !== 'computed',
  );
  host.appendChild(el('div', {
    class: 'hint',
    text: `固定費として印を付けた取引から集計しています（${[...used].join('・') || '該当なし'}）。`
      + (unset.length ? `　⚠ ${unset.map((f) => f.name).join('・')} は金額未登録のため含まれていません。` : ''),
  }));
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
    el('td', { class: 'num strong' }, [
      el('span', { text: f.actualAvg === null ? '—' : yenFmt(f.actualAvg) }),
      // 登録額と実績の乖離。サブスクの値上げや料金改定は、
      // 気づかないまま何年も払い続けるのが一番損なので、数字が揃っている以上は出す
      f.drift ? el('span', { class: 'drift ' + (f.drift.up ? 'is-up' : 'is-down'),
        text: (f.drift.up ? ' ▲+' : ' ▼−') + yenFmt(Math.abs(f.drift.diff)) }) : null,
    ].filter(Boolean)),
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
  $('#mer-note').textContent = scopeLabel();
  const list = byMerchant(TX, state.month).slice(0, 20);
  host.replaceChildren();
  if (list.length === 0) { host.appendChild(el('div', { class: 'empty', text: 'データがありません' })); return; }
  const rows = [];
  list.forEach((m, i) => {
    const open = state.openMerchant === m.merchant;
    rows.push(el('tr', {
      class: 'mer-row' + (open ? ' is-open' : ''),
      // 総額だけでは「回数が増えた」のか「1回あたりが上がった」のかが分からない。
      // 押したときだけ推移を開く（常時展開すると20行が縦に伸びて一覧性を失う）
      onclick: () => { state.openMerchant = open ? null : m.merchant; renderMerchants(); },
    }, [
      el('td', { text: String(i + 1), class: 'num' }),
      el('td', { class: 'strong' }, [
        el('span', { class: 'mer-caret', text: open ? '▾' : '▸' }),
        m.merchant,
      ]),
      el('td', {}, [el('span', { class: 'tag', text: m.category })]),
      el('td', { class: 'num', text: String(m.count) }),
      el('td', { class: 'num strong', text: yenFmt(m.amount) }),
    ]));
    if (open) rows.push(el('tr', { class: 'mer-detail' }, [el('td', { colspan: 5 }, [merchantPanel(m.merchant)])]));
  });

  host.appendChild(el('div', { class: 'tbl-wrap' }, [
    el('table', {}, [
      el('thead', {}, [el('tr', {}, [
        el('th', { class: 'num', text: '#' }), el('th', { text: '店名' }), el('th', { text: 'カテゴリ' }),
        el('th', { class: 'num', text: '件数' }), el('th', { class: 'num', text: '金額' }),
      ])]),
      el('tbody', {}, rows),
    ]),
  ]));
  host.appendChild(el('div', { class: 'hint', text: '行を押すと、その店の月ごとの金額・件数・1回あたりの推移が開きます（推移は常に全期間）。' }));
}

/**
 * 1店舗の月次推移。
 *
 * ★ 金額だけでなく件数と1回あたりも出す。
 *   総額が増えたとき、行く回数が増えたのか単価が上がったのかで打ち手が変わる。
 * ★ 推移は期間フィルタに追随させない。
 *   月で絞った状態で開くと1本しか出ず、推移として意味を成さない。
 */
function merchantPanel(merchant) {
  const mt = merchantTrend(TX, months, merchant);
  const wrap = el('div', { class: 'mer-panel' });

  wrap.appendChild(el('div', { class: 'mer-stats' }, [
    el('span', {}, [el('b', { text: yenFmt(mt.total) }), '円 / 全期間']),
    el('span', {}, [el('b', { text: String(mt.count) }), '件']),
    el('span', {}, ['1回あたり ', el('b', { text: yenFmt(mt.unit) }), '円']),
    el('span', {}, [el('b', { text: String(mt.monthsSeen) }), `ヶ月 / ${months.length}ヶ月で利用`]),
  ]));

  const bars = el('div', { class: 'mer-bars' });
  for (const p of mt.points) {
    const col = el('div', { class: 'mer-col' + (p.count === 0 ? ' is-none' : '') + (state.month === p.month ? ' is-sel' : '') });
    const bar = el('div', { class: 'mer-bar' });
    bar.style.height = `${p.amount ? Math.max(4, (p.amount / mt.max) * 100) : 0}%`;
    if (p.incomplete) bar.classList.add('is-incomplete');
    col.appendChild(el('div', { class: 'mer-bartrack' }, [bar]));
    col.appendChild(el('div', { class: 'mer-mon', text: p.month.slice(5) }));
    col.appendChild(el('div', { class: 'mer-cnt', text: p.count ? `${p.count}件` : '—' }));
    bindTip(col, () => (p.count === 0
      ? `<div class="t-val">利用なし</div><div class="t-sub">${esc(p.month)}</div>`
      : `<div class="t-val">${yenFmt(p.amount)}円</div><div class="t-sub">${esc(p.month)}${p.incomplete ? '・明細範囲外あり' : ''}</div>`
        + `<div class="t-row"><span class="t-key">件数</span><span>${p.count}件</span></div>`
        + `<div class="t-row"><span class="t-key">1回あたり</span><span>${yenFmt(p.unit)}円</span></div>`));
    bars.appendChild(col);
  }
  wrap.appendChild(bars);
  return wrap;
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
  // 注記は状況に応じて出し分ける。以前は「基準日以降のデータがまだない」と
  // 無条件に断言していたため、来月データが入って差額が出た瞬間に嘘になり、
  // 実際の記録漏れを見逃させる文面になっていた。
  const allZero = withData.every((r) => r.diff === 0);
  const latest = withData.map((r) => r.asOf).sort().pop();
  const hasNewer = TX.some((t) => t.date > latest);
  host.appendChild(el('div', {
    class: 'hint',
    text: '理論残高は「基準日の実残高 ＋ その後の収入 − その後の支出」で計算します。'
      + (allZero && !hasNewer
        ? '　基準日以降の取引がまだないため、現在は実残高と一致します。次回の残高入力から差額が意味を持ちます。'
        : allZero
          ? '　差額なし。記録漏れは見つかっていません。'
          : '　⚠ 差額は記録漏れの可能性があります（現金支出など）。'),
  }));
}

function renderPayments() {
  const host = $('#payments');
  host.replaceChildren();
  if (payments.length === 0) { host.appendChild(el('div', { class: 'empty', text: '引落予定はありません' })); return; }

  // 行動に繋がるのは「次回」だけ。過去の引落済みが上を占めて
  // 未来の予定が最下行に埋没していたので、次回を主役に置き直す
  const upcoming = payments.filter((p) => !p.past);
  const past = payments.filter((p) => p.past);

  if (upcoming.length > 0) {
    const n = upcoming[0];
    const days = Math.round((Date.parse(n.date) - Date.parse(DATA.today)) / 86400000);
    const when = days <= 0 ? '本日' : days === 1 ? '明日' : `${days}日後`;
    host.appendChild(el('div', { class: 'nextpay' + (risk && !risk.covered ? ' is-short' : '') }, [
      el('div', { class: 'nextpay-label', text: '次の引落' }),
      el('div', { class: 'nextpay-value', html: yenFmt(n.amount) + '<span class="unit">円</span>' }),
      el('div', { class: 'nextpay-sub', text: `${when}・${n.date}　${n.label}` }),
      risk
        ? el('div', {
            class: 'nextpay-check ' + (risk.covered ? 'is-ok' : 'is-short'),
            text: risk.covered
              ? `✅ ${risk.account.name} の残高 ${yenFmt(risk.balance)}円で足ります`
              : `⚠ ${risk.account.name} の残高 ${yenFmt(risk.balance)}円 → ${yenFmt(risk.shortfall)}円 不足`,
          })
        : el('div', { class: 'nextpay-check', text: '口座残高が未登録のため、足りるか判定できません' }),
    ]));
  }

  if (past.length > 0) {
    const rows = past.slice().reverse().map((p) => el('tr', {}, [
      el('td', { text: p.date }),
      el('td', { text: p.label }),
      el('td', { class: 'num', text: yenFmt(p.amount) }),
    ]));
    host.appendChild(el('details', { class: 'foldable' }, [
      el('summary', { text: `引落済み ${past.length}件を表示` }),
      el('div', { class: 'tbl-wrap' }, [
        el('table', {}, [
          el('thead', {}, [el('tr', {}, [
            el('th', { text: '引落日' }), el('th', { text: '内容' }), el('th', { class: 'num', text: '金額' }),
          ])]),
          el('tbody', {}, rows),
        ]),
      ]),
    ]));
  }
  host.appendChild(el('div', { class: 'hint', text: 'カード請求額は明細の「今回ご請求金額」から自動取得しています（手入力なし）。' }));
}

// ------------------------------------------------------------------ 取引一覧

function renderTable() {
  const host = $('#txtable');
  $('#tx-note').textContent = `${scopeLabel()}／見出しをクリックで並べ替え`;
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

  // 表示件数。既に456件あり、固定400件では56件が到達不能になっていた。
  // DOM量を抑えつつ、押せば必ず全件に到達できるようにする
  const limit = state.txLimit;
  const body = rows.slice(0, limit).map((t) => el('tr', {}, [
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
    el('div', { class: 'rowcount' }, [
      el('span', { text: `${scopeLabel()}｜${rows.length}件 / 合計 ${yenFmt(sum)}円` }),
      rows.length > limit
        ? el('button', {
            class: 'more-btn', type: 'button',
            text: `残り ${rows.length - limit}件を表示`,
            onclick: () => { state.txLimit = rows.length; renderTable(); },
          })
        : null,
    ].filter(Boolean)),
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

  // 押した指の位置から夜が広がる。View Transitions のスナップショット1枚に対して
  // clip-path をかけるだけなので、要素数に関係なくコンポジタで完結する
  toggle.addEventListener('click', (ev) => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    if (REDUCE || !document.startViewTransition) { apply(next); return; }
    const b = toggle.getBoundingClientRect();
    const x = b.left + b.width / 2;
    const y = b.top + b.height / 2;
    const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    const vt = document.startViewTransition(() => apply(next));
    // View Transition のコールバックは描画機会に紐づくため、
    // 描画が絞られている状況（バックグラウンド等）では遅れることがある。
    // テーマの切り替え自体が演出の完了に依存してはいけないので保険を置く
    setTimeout(() => {
      if (document.documentElement.getAttribute('data-theme') !== next) apply(next);
    }, 600);
    vt.ready.then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: 520, easing: 'cubic-bezier(.65,0,.35,1)', pseudoElement: '::view-transition-new(root)' },
      );
    }).catch(() => {});
  });

  // 指で操作した直後に飛んでくるエミュレート mousemove で位置がずれないようにする
  window.addEventListener('mousemove', (e) => {
    if (!isTouching() && tip.classList.contains('is-on')) moveTip(e);
  });
}

initControls();
initTabs();
render();

/**
 * カードを下から順に立ち上げる。
 * ★ js-motion は「JS がここまで到達した」証明でもある。先に CSS で
 *   opacity:0 にしておくと、JS が落ちたとき画面が真っ白のまま戻らない。
 */
if (!REDUCE) {
  const cards = [...document.querySelectorAll('.card')];
  document.documentElement.classList.add('js-motion');   // ここで全カードが opacity:0 になる
  cards.forEach((c, i) => { c.style.transitionDelay = `${Math.min(i, 5) * 60}ms`; });
  // 開始状態を1フレーム描かせないとトランジションが起きない
  requestAnimationFrame(() => cards.forEach((c) => c.classList.add('is-in')));

  /**
   * ★ 保険：内容が見えないまま残ることだけは絶対に避ける。
   *
   * is-in を付けるだけでは足りない。is-in は「トランジションで opacity 1 になる」
   * 指定なので、トランジションが走らない環境（省電力・バックグラウンド・
   * 一部のヘッドレス）では opacity:0 の基底ルールが残って見えないままになる。
   * そこで js-motion ごと外し、opacity を指定しない素の状態に戻す。
   */
  setTimeout(() => {
    document.documentElement.classList.remove('js-motion');
    cards.forEach((c) => { c.style.transitionDelay = ''; });
  }, 1200);
}

firstPaint = false;   // 以降の再描画では伸長アニメーションを再生しない

// Web版（暗号化）の boot() が「描画まで到達したか」を判定するための目印。
// これが立たないまま復号ゲートを閉じると、空の枠だけが残って復帰不能になる。
window.__kakeiRendered = true;
