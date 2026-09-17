#!/usr/bin/env node
/**
 * End-to-end checks for repeat sittings, in a real Firefox.
 *
 * Covers the two rules that govern them:
 *   - every sitting counts separately in the GPA;
 *   - a course is repeated only on failure, and a pass closes it for good.
 *
 * Prerequisites: geckodriver --port 4444, and the app served.
 * Run:  node tools/repeat-smoke.mjs [appUrl] [driverUrl]
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
  capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless', '-width', '1200', '-height', '1000'] } } },
});
const sid = session.sessionId;
const exec = (s, a = []) => call('POST', `/session/${sid}/execute/sync`, { script: s, args: a });
const go = (url) => call('POST', `/session/${sid}/url`, { url });
const settle = () => new Promise((r) => setTimeout(r, 200));

const waitFor = async (expr, label) => {
  for (let i = 0; i < 150; i++) {
    if (await exec(`return (${expr});`)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for: ${label}`);
};

const boxes = (id) => exec(`return document.querySelectorAll('tr[data-id="${id}"] select.grade').length;`);
const summary = () => exec(`return {
  gpa: document.getElementById('stat-gpa').textContent.trim(),
  courses: document.getElementById('stat-courses').textContent.trim(),
  units: document.getElementById('stat-units').textContent.trim(),
  points: document.getElementById('stat-points').textContent.trim(),
  note: document.getElementById('stat-attempts').textContent.trim()
};`);
const row = (id) => exec(`var tr = document.querySelector('tr[data-id="${id}"]'); return {
  units: tr.querySelector('.cell-units').textContent.trim(),
  gp: tr.querySelector('.cell-gp').textContent.trim(),
  pt: tr.querySelector('.cell-pt').textContent.trim(),
  repeated: tr.classList.contains('repeated'),
  exhausted: tr.classList.contains('exhausted')
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

try {
  console.log(`\nRepeat sittings — ${APP}\n`);
  await go(APP);
  await waitFor(`document.querySelectorAll('tr[data-id]').length > 0`, 'the course tables');

  check('repeats are off by default: one grade box per course', (await boxes('y3s1-MEE313')) === 1);
  await exec(`var t = document.getElementById('toggle-repeats'); t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true }));`);
  await settle();
  check('switching repeats on still shows one box until a course is sat',
    (await boxes('y3s1-MEE313')) === 1);

  /* ---- a pass closes the course ---- */
  await sit('y3s1-MEE313', 0, 'B');
  check('passing first time offers no second box', (await boxes('y3s1-MEE313')) === 1);

  await sit('y3s1-MEE313', 0, 'F');
  check('changing that to F re-opens the course', (await boxes('y3s1-MEE313')) === 2);
  let s = await summary();
  check('a failed sitting puts its units in the denominator and no points',
    s.units === '3' && s.points === '0' && s.gpa === '0.00', JSON.stringify(s));

  /* ---- every sitting counts ---- */
  await sit('y3s1-MEE313', 1, 'B');          // MEE 313 is 3 units, Year 3
  s = await summary();
  check('the resit adds its units AGAIN and its points: 12 / 6 = 2.00',
    s.units === '6' && s.points === '12' && s.gpa === '2.00', JSON.stringify(s));
  check('it stays one course, with the sittings noted',
    s.courses === '1' && s.note === '2 sittings · 1 repeat', JSON.stringify(s));
  check('passing at the second sitting closes the course', (await boxes('y3s1-MEE313')) === 2);

  const r = await row('y3s1-MEE313');
  check('the row shows 6 units as 3 × 2, both grade points, and 12 points',
    r.units.includes('6') && r.units.includes('3 × 2') && r.gp === '0 · 4' && r.pt === '12' && r.repeated,
    JSON.stringify(r));

  /* ---- a run of failures, capped by the allowance ---- */
  await sit('y3s1-MEE313', 1, 'F');
  for (let i = 2; i < 6; i++) await sit('y3s1-MEE313', i, 'F');
  const capped = await exec(`
    var ss = document.querySelectorAll('tr[data-id="y3s1-MEE313"] select.grade');
    return { boxes: ss.length, filled: Array.from(ss).filter(function (x) { return x.value; }).length };
  `);
  check('a Year 3 course stops at its 6-sitting allowance, with no blank box offered',
    capped.boxes === 6 && capped.filled === 6, JSON.stringify(capped));
  check('a course that used every sitting without passing is flagged',
    (await row('y3s1-MEE313')).exhausted === true);
  s = await summary();
  check('six sittings of a 3-unit course contribute 18 units and no points',
    s.units === '18' && s.points === '0', JSON.stringify(s));
  check('an unrelated course is unaffected by that', (await boxes('y1s1-MTH101')) === 1);

  /* ---- persistence ---- */
  await go('about:blank');
  await go(APP);
  await waitFor(`document.querySelectorAll('tr[data-id]').length > 0`, 'reload');
  await waitFor(`document.getElementById('stat-courses').textContent.trim() !== '0'`, 'saved results');
  s = await summary();
  check('every sitting survives a reload',
    s.units === '18' && s.points === '0' && s.note.startsWith('6 sittings'), JSON.stringify(s));
  const stored = await exec(`
    var rec = JSON.parse(localStorage.getItem('unn-mee-gpa-calculator')).records['unn-mee-beng-5yr@2023.1'];
    return JSON.stringify({ grades: rec.grades, repeats: rec.repeats });
  `);
  check('the first sitting stays in grades, the repeats stored separately',
    stored === '{"grades":{"y3s1-MEE313":"F"},"repeats":{"y3s1-MEE313":["F","F","F","F","F"]}}', stored);
  check('the switch itself is remembered across a reload',
    (await exec(`return document.getElementById('toggle-repeats').checked;`)) === true);

  // Forget the switch but keep the results: a student who has repeats recorded
  // must still see them, otherwise the GPA would be unexplainable.
  await exec(`localStorage.removeItem('unn-mee-gpa-calculator:prefs');`);
  await go('about:blank');
  await go(APP);
  await waitFor(`document.querySelectorAll('tr[data-id]').length > 0`, 'reload without the preference');
  await waitFor(`document.getElementById('stat-courses').textContent.trim() !== '0'`, 'saved results');
  check('sittings stay visible even with the switch off, because they are counting',
    (await exec(`return document.getElementById('toggle-repeats').checked;`)) === false &&
    (await boxes('y3s1-MEE313')) === 6,
    `switch off, boxes ${await boxes('y3s1-MEE313')}`);
  check('a course with no repeats still shows just one box',
    (await boxes('y1s1-MTH101')) === 1);

  /* ---- correcting an earlier sitting to a pass ---- */
  await sit('y3s1-MEE313', 1, 'C');
  check('correcting sitting 2 to a pass drops sittings 3 to 6', (await boxes('y3s1-MEE313')) === 2);
  s = await summary();
  check('and the GPA follows: 9 / 6 = 1.50',
    s.units === '6' && s.points === '9' && s.gpa === '1.50', JSON.stringify(s));
  const after = await exec(`
    return JSON.stringify(JSON.parse(localStorage.getItem('unn-mee-gpa-calculator')).records['unn-mee-beng-5yr@2023.1'].repeats);
  `);
  check('the dropped sittings are not left behind in storage',
    after === '{"y3s1-MEE313":["C"]}', after);

  /* ---- removal ---- */
  await sit('y3s1-MEE313', 0, '');
  s = await summary();
  check('clearing the first sitting clears the whole course',
    s.courses === '0' && s.units === '0' && s.gpa === '—', JSON.stringify(s));
  check('the row collapses back to a single box', (await boxes('y3s1-MEE313')) === 1);

  /* ---- the stored record is canonical, and stays canonical ---- */
  const rec = () => exec(`
    var r = JSON.parse(localStorage.getItem('unn-mee-gpa-calculator')).records['unn-mee-beng-5yr@2023.1'];
    return JSON.stringify({ grades: r.grades, repeats: r.repeats });
  `);

  // Plant a deliberately messy record: blanks, an invalid grade, sittings
  // recorded after a pass, and more sittings than a Year 3 course allows.
  await exec(`localStorage.setItem('unn-mee-gpa-calculator', JSON.stringify({
    schema_version: 1, active: 'unn-mee-beng-5yr@2023.1',
    records: { 'unn-mee-beng-5yr@2023.1': {
      curriculum_id: 'unn-mee-beng-5yr', curriculum_version: '2023.1',
      saved_at: '2026-09-17T00:00:00.000Z',
      grades: { 'y3s1-MEE313': 'F' },
      repeats: { 'y3s1-MEE313': ['', 'F', null, 'Z', 'B', 'F', 'A', 'F', 'F', 'F', 'F'] },
      unitOverrides: {} } } }));`);
  await go('about:blank');
  await go(APP);
  await waitFor(`document.querySelectorAll('tr[data-id]').length > 0`, 'reload with a messy record');
  await waitFor(`document.getElementById('stat-courses').textContent.trim() !== '0'`, 'saved results');

  const CANON = '{"grades":{"y3s1-MEE313":"F"},"repeats":{"y3s1-MEE313":["F","B"]}}';
  const tidied = await rec();
  check('a record that was never canonical is repaired on load', tidied === CANON, tidied);
  s = await summary();
  check('and the GPA matches the repaired record: 12 / 9 = 1.33',
    s.units === '9' && s.points === '12' && s.gpa === '1.33', JSON.stringify(s));
  check('the row shows exactly the three sittings that survived',
    (await boxes('y3s1-MEE313')) === 3);

  const shapes = new Set([tidied]);
  for (let i = 0; i < 3; i++) {
    await go('about:blank');
    await go(APP);
    await waitFor(`document.querySelectorAll('tr[data-id]').length > 0`, 'reload');
    await new Promise((r) => setTimeout(r, 400));
    shapes.add(await rec());
  }
  check('repeated reloads never change the record', shapes.size === 1, [...shapes].join(' | '));

  for (let i = 0; i < 6; i++) await sit('y3s1-MEE313', 1, 'F');
  check('re-recording the same F six times still leaves exactly one',
    (await rec()) === CANON, await rec());

  await exec(`localStorage.removeItem('unn-mee-gpa-calculator');`);
  await exec(`localStorage.removeItem('unn-mee-gpa-calculator:prefs');`);
} finally {
  await call('DELETE', `/session/${sid}`).catch(() => {});
}

console.log(`\n${failures === 0 ? 'All repeat checks passed.' : `${failures} repeat check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
