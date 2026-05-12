'use strict';

require('dotenv').config();

const fs      = require('fs');
const path    = require('path');
const xml2js  = require('xml2js');
const { google } = require('googleapis');

const QUOTES_DIR = path.join(__dirname, 'quotes', 'raw');
const parser     = new xml2js.Parser({ explicitArray: false });

const UPLOAD       = process.argv.includes('--upload');
const PROCESSED_PATH = path.join(__dirname, 'processed.json');

// ── helpers ──────────────────────────────────────────────────────────────────

function toArr(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function attrVal(node) {
  return (node && node.$ && node.$.Value !== undefined) ? node.$.Value : '';
}

function nodeText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  return node._ || '';
}

function decodeEntities(s) {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#xD;&#xA;/g, ' | ')
    .replace(/&#xD;/g, ' ')
    .replace(/&#xA;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseExtraFields(cdataStr) {
  const map = {};
  if (!cdataStr) return map;
  const re = /<clsnamevalue>\s*<name\s+Value="([^"]+)"\s*\/?>\s*<value\s+Value="([^"]*)"/g;
  let m;
  while ((m = re.exec(cdataStr)) !== null) {
    map[m[1]] = decodeEntities(m[2]);
  }
  return map;
}

function extractGlassType(extraFields) {
  const raw = extraFields['Description_StandardDescription_Glass Options'] || '';
  if (!raw) return '';
  const get = (pat) => ((raw.match(pat) || [])[1] || '').trim();
  const pane = get(/Pane Type\s*=\s*([^,|\r\n]+)/);
  const ext  = get(/Exterior Glass\s*=\s*([^,|\r\n]+)/);
  const int_ = get(/Interior Glass\s*=\s*([^,|\r\n]+)/);
  return [pane, ext, int_].filter(Boolean).join('/');
}

function csvCell(v) {
  const s = (v === null || v === undefined)
    ? ''
    : String(v).replace(/\r\n|\r|\n/g, ' ').trim();
  if (s.includes(',') || s.includes('"')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ── per-file extraction ───────────────────────────────────────────────────────

async function processFile(filePath) {
  const xml    = fs.readFileSync(filePath, 'utf8');
  const parsed = await parser.parseStringPromise(xml);
  const q      = parsed.quote;

  const sourceId = attrVal(q.userquotenumber) || path.basename(filePath, '.xml');
  const rows   = [];
  const errors = [];

  for (const master of toArr(q.lineitemmasters?.lineitemmaster)) {
    for (const item of toArr(master.lineitems?.lineitem)) {
      const lineNum = attrVal(item.linenumber) || '?';
      try {
        const description = nodeText(item.description);
        const frameWidth  = attrVal(item.FrameWidth);
        const frameHeight = attrVal(item.FrameHeight);
        const custPrice   = attrVal(item.customerprice);
        const dealPrice   = attrVal(item.dealerprice);

        const firstWindow = toArr(item.extradata?.windows?.window)[0];
        const seriesName  = (firstWindow && typeof firstWindow.seriesname === 'string')
          ? firstWindow.seriesname
          : nodeText(firstWindow?.seriesname);

        const efRaw = typeof item.extradata?.extrafields === 'string'
          ? item.extradata.extrafields
          : nodeText(item.extradata?.extrafields);
        const extraFields = parseExtraFields(efRaw);
        const glassType   = extractGlassType(extraFields);

        rows.push([sourceId, lineNum, description, frameWidth, frameHeight,
                   custPrice, dealPrice, glassType, seriesName]);
      } catch (e) {
        errors.push(`  Line ${lineNum}: ${e.message}`);
      }
    }
  }

  return { rows, errors, sourceId };
}

// ── processed-file tracking ───────────────────────────────────────────────────

function loadProcessed() {
  if (!fs.existsSync(PROCESSED_PATH)) return new Set();
  try {
    return new Set(JSON.parse(fs.readFileSync(PROCESSED_PATH, 'utf8')));
  } catch { return new Set(); }
}

function saveProcessed(set) {
  fs.writeFileSync(PROCESSED_PATH, JSON.stringify([...set], null, 2));
}

// ── Google Sheets upload ──────────────────────────────────────────────────────

async function appendToSheets(newRows) {
  const sheetId = process.env.SHEET_ID;
  const tabName = process.env.SHEET_TAB || 'RAW_QUOTE_DATA';

  if (!sheetId || sheetId === 'your_spreadsheet_id_here') {
    throw new Error('SHEET_ID not set — add it to your .env file');
  }

  const { authorize } = require('./auth');
  const log = (...a) => process.stderr.write(a.join(' ') + '\n');

  log('Authorizing with Google...');
  const auth   = await authorize();
  const sheets = google.sheets({ version: 'v4', auth });

  log(`Appending ${newRows.length} new rows to "${tabName}"...`);
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${tabName}!A1`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: newRows },
  });

  log(`✓ Appended ${newRows.length} rows to "${tabName}"`);
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const t0  = Date.now();
  const log = (...a) => process.stderr.write(a.join(' ') + '\n');

  log(`PNW XML Extractor${UPLOAD ? ' [--upload]' : ''}`);
  log(`Reading from: ${QUOTES_DIR}\n`);

  if (!fs.existsSync(QUOTES_DIR)) {
    log(`ERROR: Directory not found — ${QUOTES_DIR}`);
    log(`Create the folder and drop XML files into it, then re-run.`);
    process.exit(1);
  }

  const allFiles = fs.readdirSync(QUOTES_DIR).filter(f => /\.xml$/i.test(f));
  if (!allFiles.length) {
    log('ERROR: No .xml files found in quotes/raw/');
    process.exit(1);
  }

  const processed = loadProcessed();
  const newFiles  = allFiles.filter(f => !processed.has(f));
  const skipped   = allFiles.length - newFiles.length;

  if (skipped) log(`Skipping ${skipped} already-processed file(s).`);
  if (!newFiles.length) {
    log('No new files to process. Done.');
    process.exit(0);
  }
  log(`Processing ${newFiles.length} new file(s): ${newFiles.join(', ')}\n`);

  const HEADER = ['SourceQuoteID','LineNumber','Description','FrameWidth','FrameHeight',
                  'CustomerPrice','DealerPrice','GlassType','SeriesName'];

  const newRows   = [];
  const allErrors = [];
  let totalItems  = 0;
  const succeeded = [];

  for (const file of newFiles) {
    try {
      const { rows, errors, sourceId } = await processFile(path.join(QUOTES_DIR, file));
      newRows.push(...rows);
      totalItems += rows.length;
      succeeded.push(file);
      log(`✓  ${file}  →  Quote ${sourceId}  (${rows.length} line items)`);
      if (errors.length) {
        errors.forEach(e => { log(e); allErrors.push(e); });
      }
    } catch (e) {
      const msg = `✗  ${file}: ${e.message}`;
      log(msg);
      allErrors.push(msg);
    }
  }

  // Always print CSV to stdout (header + new rows only)
  console.log(HEADER.join(','));
  newRows.forEach(row => console.log(row.map(csvCell).join(',')));

  // Optionally append new rows to Google Sheets
  if (UPLOAD) {
    log('');
    if (newRows.length) {
      try {
        await appendToSheets(newRows);
      } catch (e) {
        log(`ERROR uploading to Sheets: ${e.message}`);
        allErrors.push(e.message);
      }
    } else {
      log('Nothing new to upload.');
    }
  }

  // Mark successfully processed files so they are skipped next run
  succeeded.forEach(f => processed.add(f));
  saveProcessed(processed);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(2);
  log(`\n─────────────────────────────────────`);
  log(`Items extracted : ${totalItems}`);
  log(`Errors          : ${allErrors.length}`);
  log(`Time            : ${elapsed}s`);
  if (allErrors.length) {
    log('\nError detail:');
    allErrors.forEach(e => log(`  ${e}`));
  }
}

main().catch(e => {
  process.stderr.write(`Fatal: ${e.message}\n`);
  process.exit(1);
});
