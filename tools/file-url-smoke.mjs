#!/usr/bin/env node
/**
 * Verifies the single-file build works when opened straight from disk
 * (file:// URL) with no server at all — which is how a student who receives
 * it over WhatsApp will open it.
 *
 * Also reports whether localStorage survives on the file:// origin, since that
 * determines whether entered grades persist in the offline copy.
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = pathToFileURL(resolve(root, 'dist/unn-mee-gpa-calculator.html')).href;
const DRIVER = process.argv[2] ?? 'http://localhost:4444';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

const call = async (m, p, b) => {
  const r = await fetch(DRIVER + p, {
    method: m, headers: { 'content-type': 'application/json' },
    body: b === undefined ? undefined : JSON.stringify(b),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${m} ${p} -> ${r.status} ${JSON.stringify(j)}`);
  return j.value;
};

console.log(`\nOpening the single-file build directly from disk\n  ${FILE}\n`);

const session = await call('POST', '/session', {
  capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless', '-width', '390', '-height', '844'] } } },
});
const sid = session.sessionId;
const exec = (s, a = []) => call('POST', `/session/${sid}/execute/sync`, { script: s, args: a });

try {
  await call('POST', `/session/${sid}/url`, { url: FILE });
  // Start from a clean slate: every run of this file shares one file:// origin,
  // so anything an earlier run left behind would still be here.
  await exec(`try { localStorage.clear(); } catch (e) {}`);
  await call('POST', `/session/${sid}/url`, { url: FILE });
  for (let i = 0; i < 100; i++) {
    if (await exec(`return document.querySelectorAll('tr[data-id]').length > 0;`)) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const rows = await exec(`return {
    total: document.querySelectorAll('tr[data-id]').length,
    visible: Array.from(document.querySelectorAll('tr[data-id]'))
      .filter(function (tr) { return !tr.classList.contains('hidden') && tr.offsetParent !== null; }).length
  };`);
  check('the whole curriculum renders with no server and no network',
    rows.total === 119 && rows.visible === 103, JSON.stringify(rows));
  check('no boot error', (await exec(`return document.getElementById('boot-error').hidden;`)) === true);
  check('the page made no external requests',
    (await exec(`return performance.getEntriesByType('resource').filter(function(r){return !r.name.startsWith('file:');}).length;`)) === 0);

  await exec(`
    var g = { 'y1s1-MTH101': 'A', 'y2s2-MEE202': 'B' };
    Object.keys(g).forEach(function (id) {
      var sel = document.querySelector('tr[data-id="' + id + '"] select.grade');
      sel.value = g[id];
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
  `);
  await new Promise((r) => setTimeout(r, 300));
  const s = await exec(`return { gpa: document.getElementById('stat-gpa').textContent.trim(), units: document.getElementById('stat-units').textContent.trim() };`);
  check('grades entered offline recalculate correctly (22 / 5 = 4.40)', s.gpa === '4.40' && s.units === '5', JSON.stringify(s));

  const storageWorks = await exec(`
    try { localStorage.setItem('__probe__', '1'); var v = localStorage.getItem('__probe__'); localStorage.removeItem('__probe__'); return v === '1'; }
    catch (e) { return 'blocked: ' + e.name; }
  `);
  check('localStorage is available on the file:// origin', storageWorks === true, String(storageWorks));

  if (storageWorks === true) {
    await call('POST', `/session/${sid}/url`, { url: 'about:blank' });
    await call('POST', `/session/${sid}/url`, { url: FILE });
    for (let i = 0; i < 100; i++) {
      if (await exec(`return document.querySelectorAll('tr[data-id]').length > 0;`)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 400));
    const after = await exec(`return { gpa: document.getElementById('stat-gpa').textContent.trim(), courses: document.getElementById('stat-courses').textContent.trim() };`);
    check('grades survive reopening the downloaded file', after.gpa === '4.40' && after.courses === '2', JSON.stringify(after));
    await exec(`localStorage.removeItem('unn-mee-gpa-calculator');`);
  }
} finally {
  await call('DELETE', `/session/${sid}`).catch(() => {});
}

console.log(`\n${failures === 0 ? 'The offline single-file build works.' : `${failures} check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
