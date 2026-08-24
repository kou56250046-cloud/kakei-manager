/**
 * 集計ロジック（Node の CLI とブラウザの両方から使う）。
 *
 * ★ 集計値はファイルに保存しない。カード明細は利用日と請求月がずれ、
 *   過去月の集計は後から変わり得るため、常に取引データから再計算する。
 *
 * build.js はこのファイルの中身から `export ` を落として HTML に埋め込む。
 * そのため、ここでは import を書かないこと（自己完結させる）。
 */

export function yenFmt(n) {
  const v = Math.round(n ?? 0);
  return (v < 0 ? '−' : '') + Math.abs(v).toLocaleString('ja-JP');
}

/** 支出として集計する取引か（振替・カード引落は二重計上になるため除外） */
export function isSpending(t) {
  return t.type === 'expense' || t.type === 'refund';
}

/** 利用日ベースの月別集計 */
export function monthlyTotals(transactions) {
  const map = new Map();
  for (const t of transactions) {
    if (!isSpending(t)) continue;
    const m = t.date.slice(0, 7);
    const e = map.get(m) ?? { month: m, amount: 0, count: 0 };
    e.amount += t.amount; e.count++;
    map.set(m, e);
  }
  return [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/**
 * 「その月が明細でカバーされているか」を判定する。
 *
 * カード明細は締め日の関係で1ファイルに2ヶ月分の利用日が混在し、
 * 期間の両端の月は必ず一部しか含まれない。
 * 端の月をそのまま前月比に使うと誤った減少に見えるため、明示的に印を付ける。
 */
export function markIncompleteMonths(months, importLog, startMonth = null) {
  if (months.length === 0) return months;

  // 取り込んだ明細がカバーする利用日の範囲を求める
  const froms = (importLog ?? []).map((e) => e.usage_from).filter(Boolean).sort();
  const tos = (importLog ?? []).map((e) => e.usage_to).filter(Boolean).sort();
  if (froms.length === 0 || tos.length === 0) {
    // 旧形式の import_log（範囲情報なし）へのフォールバック
    const first = months[0].month, last = months[months.length - 1].month;
    return months.map((m) => ({ ...m, incomplete: m.month === first || m.month === last }));
  }

  // 意図的に切り捨てた期間より前は「範囲外」であって「不完全」ではない
  let coveredFrom = froms[0];
  if (startMonth && coveredFrom < `${startMonth}-01`) coveredFrom = `${startMonth}-01`;
  const coveredTo = tos[tos.length - 1];

  return months.map((m) => {
    const monthStart = `${m.month}-01`;
    const monthEnd = `${m.month}-${String(daysInMonth(m.month)).padStart(2, '0')}`;
    return { ...m, incomplete: monthStart < coveredFrom || monthEnd > coveredTo };
  });
}

function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

/** カテゴリ別集計（金額降順） */
export function byCategory(transactions, month = null) {
  const map = new Map();
  for (const t of transactions) {
    if (!isSpending(t)) continue;
    if (month && t.date.slice(0, 7) !== month) continue;
    const e = map.get(t.category) ?? { category: t.category, amount: 0, count: 0, subs: new Map() };
    e.amount += t.amount; e.count++;
    const sk = t.subcategory ?? '—';
    e.subs.set(sk, (e.subs.get(sk) ?? 0) + t.amount);
    map.set(t.category, e);
  }
  const list = [...map.values()].map((e) => ({
    ...e,
    subs: [...e.subs.entries()].map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount),
  }));
  return list.sort((a, b) => b.amount - a.amount);
}

/**
 * カテゴリ別に前月比を付ける。
 *
 * 月1回しか開かないツールで一番知りたいのは「今月いくら使ったか」ではなく
 * 「先月と何が違ったか」。金額だけ並べても、その額が「いつも通り」なのか
 * 「今月だけ高い」のかが読み取れない。
 *
 * ※ このファイルは公開HTMLに埋め込まれる。コメントに実際の金額を書かないこと
 *   （書くとビルド時の平文混入チェックで弾かれる）。
 *
 * 不完全な月（カード明細の範囲外の日がある月）は比較に使わない。
 * 前月比を出すと誤った減少に見えるため（ヒーローの前月比と同じ扱い）。
 */
export function byCategoryWithDelta(transactions, month, months) {
  const cur = byCategory(transactions, month);
  if (!month) return { rows: cur, prevMonth: null, disappeared: [] };

  const idx = (months ?? []).findIndex((m) => m.month === month);
  const curInfo = months?.[idx];
  const prevInfo = months?.[idx - 1];
  if (!curInfo || !prevInfo || curInfo.incomplete || prevInfo.incomplete) {
    return { rows: cur, prevMonth: null, disappeared: [] };
  }

  const prev = new Map(byCategory(transactions, prevInfo.month).map((c) => [c.category, c.amount]));
  const rows = cur.map((c) => {
    const before = prev.get(c.category);
    return {
      ...c,
      prevAmount: before ?? 0,
      // 前月に無かったカテゴリは「増えた」ではなく「新規」として扱う
      isNew: before === undefined,
      delta: before === undefined ? null : c.amount - before,
    };
  });

  // 前月にあって今月ゼロになったもの（減少としては最も大きいのに、行が無いと見えない）
  const disappeared = [...prev.entries()]
    .filter(([name]) => !cur.some((c) => c.category === name))
    .map(([name, amount]) => ({ category: name, amount }))
    .sort((a, b) => b.amount - a.amount);

  return { rows, prevMonth: prevInfo.month, disappeared };
}

/** 店舗別集計（表示名でまとめる） */
export function byMerchant(transactions, month = null) {
  const map = new Map();
  for (const t of transactions) {
    if (!isSpending(t)) continue;
    if (month && t.date.slice(0, 7) !== month) continue;
    const k = t.merchant || t.merchant_key;
    const e = map.get(k) ?? { merchant: k, amount: 0, count: 0, category: t.category };
    e.amount += t.amount; e.count++;
    map.set(k, e);
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount);
}

/** 固定費と変動費の比率 */
export function fixedVsVariable(transactions, month = null) {
  let fixed = 0, variable = 0;
  for (const t of transactions) {
    if (!isSpending(t)) continue;
    if (month && t.date.slice(0, 7) !== month) continue;
    if (t.is_fixed_cost) fixed += t.amount; else variable += t.amount;
  }
  return { fixed, variable, total: fixed + variable };
}

// ------------------------------------------------------------------ 献金

/** 端数処理（金額は必ず整数円で扱う） */
export function roundTithe(value, rounding = 'ceil', unit = 100) {
  const u = unit > 0 ? unit : 1;
  const q = value / u;
  const r = rounding === 'floor' ? Math.floor(q) : rounding === 'round' ? Math.round(q) : Math.ceil(q);
  return r * u;
}

/**
 * 月ごとの献金額を計算する。
 * 対象は is_tithe_target の収入の net_amount（手取り基準）。
 * add_back_savings_deduction が true なら天引き積立を対象に戻す。
 */
export function titheByMonth(incomes, titheRecords, config, transactions = []) {
  const cfg = config?.tithe ?? {};
  const rate = cfg.rate ?? 0.1;
  const addBack = cfg.add_back_savings_deduction === true;

  const map = new Map();
  for (const inc of incomes ?? []) {
    if (inc.is_tithe_target === false) continue;
    const m = inc.date.slice(0, 7);
    const e = map.get(m) ?? { month: m, base: 0, sources: [] };
    const base = (inc.net_amount ?? 0) + (addBack ? (inc.savings_deduction ?? 0) : 0);
    e.base += base;
    e.sources.push({ name: inc.name, amount: base });
    map.set(m, e);
  }

  // 献金済みの額は「什一献金の支出取引」から数える。
  // 献金は支出としても計上されるため（仕様書7.5）、ここを別管理にすると
  // 「支出には出ているのに未献金と表示される」という矛盾が起きる。
  // tithe.json に記録がある月は、そちらを正として上書きする。
  const paidByMonth = new Map();
  for (const t of transactions ?? []) {
    if (t.category !== '献金' || t.subcategory !== '什一献金') continue;
    const m = t.date.slice(0, 7);
    paidByMonth.set(m, (paidByMonth.get(m) ?? 0) + t.amount);
  }
  for (const rec of titheRecords ?? []) {
    paidByMonth.set(rec.month, rec.paid_amount ?? 0);
  }

  const months = [...new Set([...map.keys(), ...paidByMonth.keys()])].sort();
  let carry = 0;
  return months.map((m) => {
    const e = map.get(m) ?? { month: m, base: 0, sources: [] };
    const calculated = roundTithe(e.base * rate, cfg.rounding ?? 'ceil', cfg.rounding_unit ?? 100);
    const paid = paidByMonth.get(m) ?? 0;
    carry += calculated - paid;
    return { month: m, base: e.base, sources: e.sources, rate, calculated, paid, remaining: calculated - paid, carryOver: carry };
  });
}

// ------------------------------------------------------------------ 口座

/**
 * 理論残高を計算する。
 * 直近のスナップショット以降の収入・支出・振替を積み上げる。
 * データが未登録なら null を返し、UI 側は「未設定」を表示する。
 */
export function accountBalances(accounts, balances, incomes, transactions) {
  if (!accounts || accounts.length === 0) return [];
  return accounts.map((acc) => {
    const snaps = (balances ?? [])
      .filter((b) => b.account_id === acc.id)
      .sort((a, b) => a.date.localeCompare(b.date));
    const latest = snaps[snaps.length - 1] ?? null;
    if (!latest) return { ...acc, actual: null, calculated: null, diff: null, asOf: null };

    let calc = latest.actual_balance;
    for (const inc of incomes ?? []) {
      if (inc.deposit_account_id === acc.id && inc.date > latest.date) calc += inc.net_amount ?? 0;
    }
    for (const t of transactions ?? []) {
      if (t.date <= latest.date) continue;
      if (t.type === 'transfer') {
        if (t.from_account_id === acc.id) calc -= t.amount;
        if (t.to_account_id === acc.id) calc += t.amount;
      } else if (t.settlement_account_id === acc.id || (t.account_id === acc.id && t.source !== 'card')) {
        calc -= t.amount;
      }
    }
    return {
      ...acc,
      actual: latest.actual_balance,
      calculated: calc,
      diff: latest.actual_balance - calc,
      asOf: latest.date,
    };
  });
}

/**
 * 引落に残高が足りるかを突合する。
 *
 * カード引落額（明細の「今回ご請求金額」）と口座残高は、どちらも既にデータとして
 * 持っているのに別々の場所に表示されていて、突き合わせていなかった。
 * 残高不足は延滞・手数料という実損に直結する、この家計ツールで数少ない
 * 「行動に繋がる警告」なので、明示的に計算する。
 *
 * 貯蓄口座は原資に数えない（動かすには本人の判断が要るため）。
 */
export function settlementRisk(accounts, balances, importLog, today) {
  const t = today ?? new Date().toISOString().slice(0, 10);

  // 引落先の口座（role に card_payment を持つもの）
  const payer = (accounts ?? []).find((a) => (a.roles ?? []).includes('card_payment'));
  if (!payer) return null;

  const snaps = (balances ?? [])
    .filter((b) => b.account_id === payer.id)
    .sort((a, b) => a.date.localeCompare(b.date));
  const latest = snaps[snaps.length - 1];
  if (!latest) return null;

  // 未来（当日を含む）の引落予定
  const upcoming = (importLog ?? [])
    .filter((e) => e.payment_date && e.payment_date >= t && e.billed)
    .sort((a, b) => a.payment_date.localeCompare(b.payment_date));
  if (upcoming.length === 0) return null;

  const next = upcoming[0];
  const balance = latest.actual_balance;
  const shortfall = next.billed - balance;

  return {
    account: payer,
    balance,
    balanceDate: latest.date,
    date: next.payment_date,
    amount: next.billed,
    billingMonth: next.billing_month,
    shortfall,                          // 正なら不足
    covered: shortfall <= 0,
    // 残高の基準日と引落日が同じ場合、引落後の残高を見ている可能性がある
    sameDay: latest.date === next.payment_date,
    daysLeft: Math.round((Date.parse(next.payment_date) - Date.parse(t)) / 86400000),
    totalUpcoming: upcoming.reduce((a, e) => a + e.billed, 0),
    upcomingCount: upcoming.length,
  };
}

/** 未払いのカード請求（引落予定） */
export function upcomingPayments(importLog, today) {
  const t = today ?? new Date().toISOString().slice(0, 10);
  return (importLog ?? [])
    .filter((e) => e.payment_date)
    .map((e) => ({
      date: e.payment_date,
      label: `イオンゴールド ${e.billing_month} 請求分`,
      amount: e.billed,
      past: e.payment_date < t,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 固定費マスタの一覧。
 * 生成される固定費は取引から実績を、CSVに実額が出る固定費は
 * match_pattern に一致した取引から実績を集計する。
 */
export function fixedCostList(fixedCosts, transactions, months) {
  const nMonths = Math.max(1, (months ?? []).length);
  return (fixedCosts ?? []).map((fc) => {
    let items;
    if (fc.auto_generate) {
      items = (transactions ?? []).filter((t) => t.fixed_cost_id === fc.id);
    } else if (fc.match_pattern) {
      const re = new RegExp(fc.match_pattern, 'i');
      items = (transactions ?? []).filter((t) => re.test(t.merchant_key ?? ''));
    } else {
      // マスタ上の括りだけで、対応する取引を一意に決められないもの
      items = (transactions ?? []).filter(
        (t) => t.is_fixed_cost && t.category === fc.category && t.subcategory === fc.subcategory && t.source === 'card',
      );
    }
    const actualTotal = items.reduce((a, t) => a + t.amount, 0);
    const monthsSeen = new Set(items.map((t) => t.date.slice(0, 7))).size;
    const avg = monthsSeen > 0 ? Math.round(actualTotal / monthsSeen) : null;

    // 登録額と実績平均の乖離。±10%を超えたら料金改定の可能性がある。
    // 値上げは気づかないまま何年も払い続けるのが最も損なので、明示的に出す。
    // 変動費（電気・ガス）は季節変動があるため、乖離が出ても即異常ではない点に注意。
    let drift = null;
    if (fc.amount && avg !== null && monthsSeen >= 2) {
      const diff = avg - fc.amount;
      if (Math.abs(diff) / fc.amount > 0.1) drift = { diff, up: diff > 0, pct: diff / fc.amount };
    }

    return {
      ...fc,
      drift,
      generated: fc.auto_generate === true,
      count: items.length,
      monthsSeen,
      actualTotal,
      // 月平均：実績のある月で割る（隔月請求の水道などを月額に均さないため）
      actualAvg: monthsSeen > 0 ? Math.round(actualTotal / monthsSeen) : null,
      monthlyEquivalent: actualTotal / nMonths,
      unset: fc.amount === null && fc.amount_type !== 'computed' && items.length === 0,
    };
  }).sort((a, b) => b.actualTotal - a.actualTotal);
}

/** 要確認キュー（金額の大きい順にまとめる） */
export function reviewQueue(transactions) {
  const map = new Map();
  for (const t of transactions) {
    if (!t.needs_review) continue;
    const k = t.merchant_key;
    const e = map.get(k) ?? { key: k, merchant: t.merchant, amount: 0, count: 0, items: [] };
    e.amount += t.amount; e.count++; e.items.push(t);
    map.set(k, e);
  }
  return [...map.values()].sort((a, b) => b.amount - a.amount);
}

/**
 * 水道光熱費を内訳別（電気・ガス・水道）に月別集計する。
 *
 * 合算した「水道光熱費」だけでは、増えたのが電気なのかガスなのかが分からない。
 * 光熱費は季節で動く上に単価改定もあるため、内訳ごとに並べて初めて
 * 「今年の冬は去年より高い」といった判断ができる。
 *
 * ★ 請求のない月は 0 ではなく null を返す。
 *   水道は隔月請求のため、0 として描くと「使わなかった月」に見えてしまう。
 *   線は null を飛ばしてつなぐ（app.js 側の責務）。
 *
 * 供給元が変わっても内訳（subcategory）でまとめるので、系列は途切れない。
 */
export function utilityTrend(transactions, months, category = '水道光熱費') {
  const ORDER = ['電気', 'ガス', '水道'];
  const monthList = (months ?? []).map((m) => m.month);
  const byName = new Map();

  for (const t of transactions) {
    if (!isSpending(t)) continue;
    if (t.category !== category) continue;
    const m = t.date.slice(0, 7);
    if (!monthList.includes(m)) continue;
    const name = t.subcategory ?? 'その他';
    const e = byName.get(name) ?? { name, points: new Map(), merchants: new Set() };
    e.points.set(m, (e.points.get(m) ?? 0) + t.amount);
    if (t.merchant) e.merchants.add(t.merchant);
    byName.set(name, e);
  }

  const series = [...byName.values()].map((e) => {
    const points = (months ?? []).map((mi) => ({
      month: mi.month,
      amount: e.points.has(mi.month) ? e.points.get(mi.month) : null,
      incomplete: mi.incomplete,
    }));
    const paid = points.filter((p) => p.amount !== null);
    const total = paid.reduce((a, p) => a + p.amount, 0);
    // 平均は「請求のあった月」で割る。隔月請求を月数で割ると実額より小さく見える
    return {
      name: e.name,
      points,
      total,
      avg: paid.length ? total / paid.length : 0,
      paidCount: paid.length,
      latest: paid.length ? paid[paid.length - 1] : null,
      prev: paid.length > 1 ? paid[paid.length - 2] : null,
      merchants: [...e.merchants],
    };
  });

  series.sort((a, b) => {
    const ia = ORDER.indexOf(a.name), ib = ORDER.indexOf(b.name);
    if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    return b.total - a.total;
  });

  const max = Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.amount ?? 0)));
  return { series, max, months: months ?? [] };
}
