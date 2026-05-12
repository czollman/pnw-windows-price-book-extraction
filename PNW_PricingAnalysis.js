'use strict';

require('dotenv').config();

const { google }    = require('googleapis');
const { authorize } = require('./auth');

const SHEET_ID    = process.env.SHEET_ID;
const RAW_TAB     = process.env.SHEET_TAB  || 'RAW_QUOTE_DATA';
const ANALYSIS_TAB = process.env.ANALYSIS_TAB || 'PRICING_ANALYSIS';

const PRODUCT_FILTER = 'PW';   // Description must contain this (case-insensitive)

// ── inch parsing ──────────────────────────────────────────────────────────────
// Handles: "36", "36.5", "36 1/2", "1/2"

function parseInches(s) {
  if (!s) return NaN;
  s = String(s).trim();
  const whole = s.match(/^(\d+(?:\.\d+)?)\s+(\d+)\/(\d+)$/);
  if (whole) return parseFloat(whole[1]) + parseInt(whole[2]) / parseInt(whole[3]);
  const frac = s.match(/^(\d+)\/(\d+)$/);
  if (frac) return parseInt(frac[1]) / parseInt(frac[2]);
  return parseFloat(s);
}

// ── statistics ────────────────────────────────────────────────────────────────

function mape(points, predictFn) {
  const errs = points.map(p => Math.abs((predictFn(p.ui) - p.price) / p.price));
  return (errs.reduce((a, e) => a + e, 0) / errs.length) * 100;
}

function linearRegression(points) {
  const n = points.length;
  if (n < 2) return null;
  const sUI   = points.reduce((a, p) => a + p.ui, 0);
  const sP    = points.reduce((a, p) => a + p.price, 0);
  const sUI2  = points.reduce((a, p) => a + p.ui ** 2, 0);
  const sUIP  = points.reduce((a, p) => a + p.ui * p.price, 0);
  const denom = n * sUI2 - sUI ** 2;
  if (Math.abs(denom) < 1e-10) return null;
  const rate = (n * sUIP - sUI * sP) / denom;
  const base = (sP - rate * sUI) / n;
  return { base, rate };
}

function fitTieredAtSplit(points, split) {
  const t1 = points.filter(p => p.ui < split);
  const t2 = points.filter(p => p.ui >= split);
  if (t1.length < 1 || t2.length < 1) return null;
  const r1 = t1.reduce((a, p) => a + p.price / p.ui, 0) / t1.length;
  const r2 = t2.reduce((a, p) => a + p.price / p.ui, 0) / t2.length;
  return { split, r1, r2 };
}

function findOptimalTiered(points) {
  // Collect unique UI values to use as candidate split points
  const sortedUIs = [...new Set(points.map(p => p.ui))].sort((a, b) => a - b);
  let best = null, bestErr = Infinity;
  for (let i = 1; i < sortedUIs.length; i++) {
    const split = (sortedUIs[i - 1] + sortedUIs[i]) / 2;
    const t = fitTieredAtSplit(points, split);
    if (!t) continue;
    const err = mape(points, ui => ui < split ? t.r1 * ui : t.r2 * ui);
    if (err < bestErr) { bestErr = err; best = t; }
  }
  return best;
}

function fmt2(n) { return isNaN(n) ? '' : n.toFixed(2); }
function fmt4(n) { return isNaN(n) ? '' : n.toFixed(4); }

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const log = (...a) => process.stderr.write(a.join(' ') + '\n');
  log('PNW Pricing Analysis');
  log(`Reading: ${RAW_TAB}  →  Writing: ${ANALYSIS_TAB}\n`);

  if (!SHEET_ID || SHEET_ID === 'your_spreadsheet_id_here') {
    throw new Error('SHEET_ID not set in .env');
  }

  const auth   = await authorize();
  const sheets = google.sheets({ version: 'v4', auth });

  // ── 1. Read RAW_QUOTE_DATA ─────────────────────────────────────────────────

  const readRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${RAW_TAB}!A1:Z`,
  });

  const [headerRow, ...dataRows] = readRes.data.values || [];
  if (!headerRow) throw new Error(`${RAW_TAB} is empty`);

  const col = {};
  headerRow.forEach((h, i) => { col[h] = i; });

  const need = ['Description','FrameWidth','FrameHeight','DealerPrice','GlassType','SeriesName'];
  for (const h of need) {
    if (col[h] === undefined) throw new Error(`Column "${h}" not found in ${RAW_TAB}`);
  }

  // ── 2. Filter and parse ────────────────────────────────────────────────────

  const rows = dataRows
    .map(r => ({
      description: r[col['Description']] || '',
      width:       parseInches(r[col['FrameWidth']]),
      height:      parseInches(r[col['FrameHeight']]),
      dealerPrice: parseFloat(r[col['DealerPrice']]),
      glassType:   r[col['GlassType']]   || 'Unknown',
      seriesName:  r[col['SeriesName']]  || 'Unknown',
    }))
    .filter(r =>
      r.description.toUpperCase().includes(PRODUCT_FILTER) &&
      !isNaN(r.width) && !isNaN(r.height) && !isNaN(r.dealerPrice) && r.dealerPrice > 0
    )
    .map(r => ({ ...r, ui: r.width + r.height }));

  if (!rows.length) {
    log(`No rows matched filter "${PRODUCT_FILTER}". Nothing to analyze.`);
    process.exit(0);
  }
  log(`Found ${rows.length} picture window rows matching "${PRODUCT_FILTER}".`);

  // ── 3. Group by (SeriesName, GlassType) ───────────────────────────────────

  const groups = {};
  for (const r of rows) {
    const key = `${r.seriesName}||${r.glassType}`;
    if (!groups[key]) groups[key] = { seriesName: r.seriesName, glassType: r.glassType, points: [] };
    groups[key].points.push({ ui: r.ui, price: r.dealerPrice });
  }

  const groupList = Object.values(groups);
  log(`Groups (Series × GlassType): ${groupList.length}\n`);

  // ── 4. Fit models per group ────────────────────────────────────────────────

  const ANALYSIS_HEADER = [
    'ProductType', 'SeriesName', 'GlassType', 'DataPoints',
    'AvgUI', 'MinUI', 'MaxUI', 'AvgCostPerUI',
    'WinningModel',
    'LinearBase', 'LinearRate', 'LinearMAPE%',
    'TieredSplit', 'TieredRate1', 'TieredRate2', 'TieredMAPE%',
    'RecommendedFormula',
  ];

  const analysisRows = [ANALYSIS_HEADER];

  for (const g of groupList) {
    const { seriesName, glassType, points } = g;
    const n = points.length;

    const avgUI    = points.reduce((a, p) => a + p.ui, 0) / n;
    const minUI    = Math.min(...points.map(p => p.ui));
    const maxUI    = Math.max(...points.map(p => p.ui));
    const avgCPUI  = points.reduce((a, p) => a + p.price / p.ui, 0) / n;

    // Linear model
    const lin     = linearRegression(points);
    const linMAPE = lin ? mape(points, ui => lin.base + lin.rate * ui) : NaN;

    // Tiered model (find optimal split)
    let tier = null, tierMAPE = NaN;
    if (n >= 4) {
      tier     = findOptimalTiered(points);
      tierMAPE = tier ? mape(points, ui => ui < tier.split ? tier.r1 * ui : tier.r2 * ui) : NaN;
    }

    // Pick winner
    let winner = 'Linear', formula = '';
    if (lin) {
      formula = `$${fmt2(lin.base)} + UI × $${fmt4(lin.rate)}`;
    }
    if (tier && !isNaN(tierMAPE) && !isNaN(linMAPE) && tierMAPE < linMAPE) {
      winner  = 'Tiered';
      formula = `IF(UI<${Math.round(tier.split)}, UI×$${fmt4(tier.r1)}, UI×$${fmt4(tier.r2)})`;
    }

    // Console summary
    log(`  ${seriesName} / ${glassType}  [n=${n}, UI ${minUI}–${maxUI}]`);
    if (lin)  log(`    Linear  : base=$${fmt2(lin.base)} rate=$${fmt4(lin.rate)}/UI  MAPE=${fmt2(linMAPE)}%`);
    if (tier) log(`    Tiered  : split=${Math.round(tier.split)} r1=$${fmt4(tier.r1)} r2=$${fmt4(tier.r2)}/UI  MAPE=${fmt2(tierMAPE)}%`);
    log(`    → Winner: ${winner}   Formula: ${formula}\n`);

    analysisRows.push([
      PRODUCT_FILTER,
      seriesName,
      glassType,
      n,
      fmt2(avgUI),
      minUI,
      maxUI,
      fmt4(avgCPUI),
      winner,
      lin ? fmt4(lin.base) : '',
      lin ? fmt4(lin.rate) : '',
      lin ? fmt2(linMAPE)  : '',
      tier ? Math.round(tier.split) : '',
      tier ? fmt4(tier.r1)  : '',
      tier ? fmt4(tier.r2)  : '',
      tier ? fmt2(tierMAPE) : '',
      formula,
    ]);
  }

  // ── 5. Write PRICING_ANALYSIS (clear + rewrite) ────────────────────────────

  log(`Writing ${analysisRows.length - 1} analysis rows to "${ANALYSIS_TAB}"...`);

  // Ensure the tab exists; create it if not
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const tabExists = meta.data.sheets.some(s => s.properties.title === ANALYSIS_TAB);
  if (!tabExists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: ANALYSIS_TAB } } }],
      },
    });
    log(`Created tab "${ANALYSIS_TAB}".`);
  }

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: `${ANALYSIS_TAB}!A1:Z`,
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${ANALYSIS_TAB}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: analysisRows },
  });

  log(`\n✓ PRICING_ANALYSIS updated — ${analysisRows.length - 1} product configuration(s).`);
  log(`  Re-run any time after adding new quotes to RAW_QUOTE_DATA.`);
}

main().catch(e => {
  process.stderr.write(`Fatal: ${e.message}\n`);
  process.exit(1);
});
