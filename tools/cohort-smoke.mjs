#!/usr/bin/env node
/**
 * End-to-end checks for the pre-CCMAS First Year cohort, in a real Firefox.
 *
 * Two things must hold:
 *   - the CCMAS curriculum is completely unaffected by the cohort's presence;
 *   - a cohort course, once shown, behaves like any other course — repeats,
 *     the pass rule, the allowance, canonical records and precision all apply.
 *
 * Prerequisites: geckodriver --port 4444, and the app served.
 * Run:  node tools/cohort-smoke.mjs [appUrl] [driverUrl]
 */
const APP = process.argv[2] ?? 'http://localhost:8000/';
const DRIVER = process.argv[3] ?? 'http://localhost:4444';

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

const session = await call('POST', '/session', {
  capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless', '-width', '1200', '-height', '1100'] } } },
});
const sid = session.sessionId;
const exec = (s, a = []) => call('POST', `/session/${sid}/execute/sync`, { script: s, args: a });
const go = (url) => call('POST', `/session/${sid}/url`, { url });
const settle = () => new Promise((r) => setTimeout(r, 220));

const waitFor = async (expr, label) => {
  for (let i = 0; i < 150; i++) {
    if (await exec(`return (${expr});`)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for: ${label}`);
};

const visibleRows = () => exec(`
  return Array.from(document.querySelectorAll('tr[data-id]'))
    .filter(function (tr) { return !tr.classList.contains('hidden') && tr.offsetParent !== null; }).length;
`);
const boxes = (id) => exec(`return document.querySelectorAll('tr[data-id="${id}"] select.grade').length;`);
const summary = () => exec(`return {
  gpa: document.getElementById('stat-gpa').textContent.trim(),
  units: document.getElementById('stat-units').textContent.trim(),
  points: document.getElementById('stat-points').textContent.trim(),
  note: document.getElementById('stat-attempts').textContent.trim()
};`);
const sit = async (id, index, grade) => {
  const ok = await exec(`
    var ss = document.querySelectorAll('tr[data-id="${id}"] select.grade');
    if (!ss[${index}]) return false;
    ss[${index}].value = '${grade}';
    ss[${index}].dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `);
  if (!ok) throw new Error(`no grade box ${index} on ${id}`);
  await settle();
};
const setSwitch = async (id, on) => {
  await exec(`var t = document.getElementById('${id}'); t.checked = ${on}; t.dispatchEvent(new Event('change', { bubbles: true }));`);
  await settle();
};
const repeatsRecord = () => exec(`
  return JSON.stringify(JSON.parse(localStorage.getItem('unn-mee-gpa-calculator')).records['unn-mee-beng-5yr@2023.1'].repeats);
`);

// Elementary Mathematics I, 3 units, First Year — pre-CCMAS only.
const MTH111 = 'y1s1-pre-ccmas-MTH111';

try {
  console.log(`\nPre-CCMAS First Year cohort — ${APP}\n`);
  await go(APP);
  await waitFor(`document.querySelectorAll('tr[data-id]').length > 0`, 'the course tables');

  /* ---- hidden by default; the CCMAS curriculum untouched ---- */
  check('pre-CCMAS courses are hidden by default: 103 visible, not 119',
    (await visibleRows()) === 103, String(await visibleRows()));
  check('the switch starts off',
    (await exec(`return document.getElementById('toggle-cohort').checked;`)) === false);

  const headings = await exec(`return {
    cohortHeads: Array.from(document.querySelectorAll('.group-head.cohort')).filter(function (e) { return !e.hidden; }).length,
    firstYearHeads: document.querySelectorAll('#year-1 .group-head:not([hidden])').length
  };`);
  check('First Year gains no visible heading while the cohort is hidden',
    headings.cohortHeads === 0 && headings.firstYearHeads === 0, JSON.stringify(headings));

  const ids = await exec(`
    var ids = Array.from(document.querySelectorAll('tr[data-id]')).map(function (t) { return t.dataset.id; });
    return { total: ids.length, unique: new Set(ids).size, chm: ids.filter(function (i) { return i.indexOf('CHM101') >= 0; }) };
  `);
  check('every row has a distinct id, CHM 101 appearing once per list',
    ids.total === 119 && ids.unique === 119 &&
    ids.chm.join(',') === 'y1s1-CHM101,y1s1-pre-ccmas-CHM101', JSON.stringify(ids));

  await sit('y1s1-MTH101', 0, 'A');
  let s = await summary();
  check('a CCMAS course counts exactly as it always did: 2 units, 10 points',
    s.units === '2' && s.points === '10' && s.gpa === '5.00', JSON.stringify(s));

  /* ---- revealing the cohort ---- */
  await setSwitch('toggle-cohort', true);
  check('switching it on reveals all 16 pre-CCMAS courses', (await visibleRows()) === 119);
  s = await summary();
  check('revealing them changes nothing until one is graded',
    s.units === '2' && s.points === '10', JSON.stringify(s));

  /* ---- a cohort course inherits everything ---- */
  await setSwitch('toggle-repeats', true);
  check('a pre-CCMAS course starts with one grade box', (await boxes(MTH111)) === 1);

  await sit(MTH111, 0, 'F');
  check('failing it offers a resit, exactly like a CCMAS course', (await boxes(MTH111)) === 2);

  await sit(MTH111, 1, 'F');
  await sit(MTH111, 2, 'B');
  s = await summary();
  check('all three sittings count: 10 + 12 points over 2 + 9 units',
    s.units === '11' && s.points === '22', JSON.stringify(s));
  check('passing closes it, as everywhere else', (await boxes(MTH111)) === 3);

  const row = await exec(`var tr = document.querySelector('tr[data-id="${MTH111}"]'); return {
    units: tr.querySelector('.cell-units').textContent.trim(),
    gp: tr.querySelector('.cell-gp').textContent.trim(),
    pt: tr.querySelector('.cell-pt').textContent.trim(),
    repeated: tr.classList.contains('repeated')
  };`);
  check('the row shows 9 units as 3 × 3, all three grade points, and 12 points',
    row.units.includes('9') && row.units.includes('3 × 3') &&
    row.gp === '0 · 0 · 4' && row.pt === '12' && row.repeated, JSON.stringify(row));

  // Reopen it and spend the whole First Year allowance.
  await sit(MTH111, 2, 'F');
  for (let i = 3; i < 8; i++) await sit(MTH111, i, 'F');
  const cap = await exec(`
    var ss = document.querySelectorAll('tr[data-id="${MTH111}"] select.grade');
    return { boxes: ss.length, filled: Array.from(ss).filter(function (x) { return x.value; }).length };
  `);
  check('it inherits the First Year allowance of 8 sittings',
    cap.boxes === 8 && cap.filled === 8, JSON.stringify(cap));
  s = await summary();
  check('eight sittings of a 3-unit course contribute 24 units',
    s.units === '26' && s.points === '10', JSON.stringify(s));

  const rec = await repeatsRecord();
  check('its stored record is canonical like any other',
    rec === '{"y1s1-pre-ccmas-MTH111":["F","F","F","F","F","F","F"]}', rec);
  for (let i = 0; i < 5; i++) await sit(MTH111, 3, 'F');
  check('re-recording the same F never grows it', (await repeatsRecord()) === rec);

  await setSwitch('toggle-precision', true);
  check('full precision applies to it too',
    (await summary()).gpa === (10 / 26).toFixed(5), (await summary()).gpa);
  await setSwitch('toggle-precision', false);

  /* ---- the double-listing guard ---- */
  await sit('y1s1-CHM101', 0, 'A');
  await sit('y1s1-pre-ccmas-CHM101', 0, 'A');
  const warned = await exec(`var n = document.getElementById('cohort-notice');
    return { shown: !n.hidden, text: n.textContent.trim() };`);
  check('grading CHM 101 in both lists is flagged, not blocked',
    warned.shown === true && warned.text.includes('CHM 101'), warned.text.slice(0, 70));
  await sit('y1s1-pre-ccmas-CHM101', 0, '');
  check('clearing one of them clears the warning',
    (await exec(`return document.getElementById('cohort-notice').hidden;`)) === true);

  /* ---- persistence, and the cohort showing itself when it must ---- */
  const before = await summary();
  await go('about:blank');
  await go(APP);
  await waitFor(`document.querySelectorAll('tr[data-id]').length > 0`, 'reload');
  await waitFor(`document.getElementById('stat-courses').textContent.trim() !== '0'`, 'saved results');
  check('everything survives a reload',
    JSON.stringify(await summary()) === JSON.stringify(before), JSON.stringify(await summary()));

  await exec(`localStorage.removeItem('unn-mee-gpa-calculator:prefs');`);
  await go('about:blank');
  await go(APP);
  await waitFor(`document.querySelectorAll('tr[data-id]').length > 0`, 'reload without preferences');
  await new Promise((r) => setTimeout(r, 500));
  check('a student with a graded pre-CCMAS course still sees it with the switch off',
    (await exec(`return document.getElementById('toggle-cohort').checked;`)) === false &&
    (await visibleRows()) === 119,
    `switch off, ${await visibleRows()} rows visible`);

  await exec(`localStorage.removeItem('unn-mee-gpa-calculator');`);
  await exec(`localStorage.removeItem('unn-mee-gpa-calculator:prefs');`);
} finally {
  await call('DELETE', `/session/${sid}`).catch(() => {});
}

console.log(`\n${failures === 0 ? 'All cohort checks passed.' : `${failures} cohort check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
