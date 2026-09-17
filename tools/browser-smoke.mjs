#!/usr/bin/env node
/**
 * End-to-end smoke test in a real Firefox, driven over WebDriver.
 *
 * Prerequisites (both already present on a standard Ubuntu desktop):
 *   - firefox
 *   - geckodriver, running:  geckodriver --port 4444
 *   - the app being served:  python3 -m http.server 8000
 *
 * Run:  node tools/browser-smoke.mjs [appUrl] [driverUrl]
 */
const APP = process.argv[2] ?? 'http://localhost:8000/';
const DRIVER = process.argv[3] ?? 'http://localhost:4444';

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

async function call(method, path, body) {
  const res = await fetch(`${DRIVER}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json.value;
}

const session = await call('POST', '/session', {
  capabilities: {
    alwaysMatch: {
      browserName: 'firefox',
      'moz:firefoxOptions': { args: ['-headless', '-width', '1280', '-height', '1400'] },
    },
  },
});
const sid = session.sessionId;
const exec = (script, args = []) => call('POST', `/session/${sid}/execute/sync`, { script, args });
const go = (url) => call('POST', `/session/${sid}/url`, { url });

const waitFor = async (script, label, timeoutMs = 15000) => {
  const started = Date.now();
  for (;;) {
    if (await exec(`return (${script});`)) return true;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 150));
  }
};

/** Read the live summary strip. */
const readSummary = () => exec(`
  return {
    gpa:     document.getElementById('stat-gpa').textContent.trim(),
    courses: document.getElementById('stat-courses').textContent.trim(),
    units:   document.getElementById('stat-units').textContent.trim(),
    points:  document.getElementById('stat-points').textContent.trim(),
    cumGpa:  document.getElementById('cum-gpa').textContent.trim(),
    bootErrorShown: !document.getElementById('boot-error').hidden,
  };
`);

/** Set a grade exactly as a student would: change the select, fire 'change'. */
const setGrade = async (courseId, grade) => {
  const ok = await exec(`
    var tr = document.querySelector('tr[data-id="' + arguments[0] + '"]');
    if (!tr) return false;
    var sel = tr.querySelector('select.grade');
    sel.value = arguments[1];
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `, [courseId, grade]);
  if (!ok) throw new Error(`no row for ${courseId}`);
  // Persistence is awaited inside the handler; give the microtask queue a turn.
  await new Promise((r) => setTimeout(r, 120));
};

try {
  console.log(`\nDriving ${APP} in headless Firefox\n`);

  // Trap runtime errors for the whole run.
  await go(APP);
  await waitFor(`document.querySelectorAll('tr[data-id]').length > 0`, 'the course tables to render');

  const rows = await exec(`return document.querySelectorAll('tr[data-id]').length;`);
  check('the page boots and renders every course', rows === 103, `${rows} rows`);

  let s = await readSummary();
  check('no boot error is shown', s.bootErrorShown === false);
  check('an empty calculator shows no GPA', s.gpa === '—' && s.courses === '0' && s.units === '0', JSON.stringify(s));

  // --- Monday: one result. MTH 101 is 2 units. ---
  await setGrade('y1s1-MTH101', 'A');
  s = await readSummary();
  check('one 2-unit A gives GPA 5.00 over 2 units / 10 points',
    s.gpa === '5.00' && s.units === '2' && s.points === '10' && s.courses === '1', JSON.stringify(s));

  // --- Wednesday: a second result, from a different year entirely. MEE 202 is 3 units. ---
  await setGrade('y2s2-MEE202', 'B');
  s = await readSummary();
  check('adding a 3-unit B from another year gives 22 / 5 = 4.40',
    s.gpa === '4.40' && s.units === '5' && s.points === '22' && s.courses === '2', JSON.stringify(s));

  // --- Friday: a third, from a fourth-year first semester. MEE 443 is 3 units. ---
  await setGrade('y4s1-MEE443', 'C');
  s = await readSummary();
  check('a third result from a fourth-year semester recalculates to 31 / 8 = 3.88',
    s.gpa === '3.88' && s.units === '8' && s.points === '31' && s.courses === '3', JSON.stringify(s));

  // --- An F is active; its units stay in the denominator. MEE 313 is 3 units. ---
  await setGrade('y3s1-MEE313', 'F');
  s = await readSummary();
  check('an F adds 3 units and 0 points: 31 / 11 = 2.82',
    s.gpa === '2.82' && s.units === '11' && s.points === '31' && s.courses === '4', JSON.stringify(s));

  // --- Grade correction. ---
  await setGrade('y2s2-MEE202', 'A');
  s = await readSummary();
  check('correcting B to A replaces it (34 / 11 = 3.09), still four graded courses',
    s.gpa === '3.09' && s.units === '11' && s.points === '34' && s.courses === '4', JSON.stringify(s));

  // --- Removing a grade returns the course to dormancy. ---
  await setGrade('y4s1-MEE443', '');
  s = await readSummary();
  check('returning a grade to the dash removes it: 25 / 8 = 3.13',
    s.gpa === '3.13' && s.units === '8' && s.points === '25' && s.courses === '3', JSON.stringify(s));

  // --- Semester and year panels. ---
  const y1 = await exec(`
    var rows = document.querySelectorAll('#year-totals tbody tr');
    return Array.from(rows).map(function(r){
      return Array.from(r.children).map(function(c){ return c.textContent.trim(); });
    });
  `);
  check('the per-year panel reports First Year separately', y1[0][1] === '1' && y1[0][4] === '5.00', JSON.stringify(y1[0]));
  check('a year with no results entered shows no GPA', y1[4][1] === '0' && y1[4][4] === '—', JSON.stringify(y1[4]));

  // --- Every course in the shipped curriculum now has a known unit load. ---
  const unitState = await exec(`
    return {
      inputs: document.querySelectorAll('input.units-input').length,
      phy104: document.querySelector('tr[data-id="y1s2-PHY104"] .cell-units').textContent.trim(),
      sta112: document.querySelector('tr[data-id="y1s2-STA112"] .cell-units').textContent.trim()
    };
  `);
  check('no course is left asking the student for its unit load',
    unitState.inputs === 0, JSON.stringify(unitState));
  check('the unit loads supplied by the department are in place (PHY 104 = 2, STA 112 = 3)',
    unitState.phy104 === '2' && unitState.sta112 === '3', JSON.stringify(unitState));

  // PHY 104 is a 2-unit course, so an A on it behaves like any other: +10 points.
  await setGrade('y1s2-PHY104', 'A');
  s = await readSummary();
  check('grading PHY 104 counts normally: 35 / 10 = 3.50',
    s.gpa === '3.50' && s.units === '10' && s.points === '35' && s.courses === '4', JSON.stringify(s));
  const noBlockNotice = await exec(`return document.getElementById('version-notice').hidden;`);
  check('no "waiting for a unit load" warning is shown', noBlockNotice === true);

  // --- Persistence across a genuine browser reload. ---
  const before = await readSummary();
  await go('about:blank');
  await go(APP);
  await waitFor(`document.querySelectorAll('tr[data-id]').length > 0`, 'the page to render after reload');
  await waitFor(`document.getElementById('stat-courses').textContent.trim() !== '0'`, 'saved results to load');
  const after = await readSummary();
  check('every figure survives a full page reload',
    after.gpa === before.gpa && after.units === before.units &&
    after.points === before.points && after.courses === before.courses,
    `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);

  const restored = await exec(`
    return {
      mth101: document.querySelector('tr[data-id="y1s1-MTH101"] select').value,
      mee202: document.querySelector('tr[data-id="y2s2-MEE202"] select').value,
      mee313: document.querySelector('tr[data-id="y3s1-MEE313"] select').value,
      mee443: document.querySelector('tr[data-id="y4s1-MEE443"] select').value,
      phy104: document.querySelector('tr[data-id="y1s2-PHY104"] select').value
    };
  `);
  check('the grade controls come back showing the saved grades',
    restored.mth101 === 'A' && restored.mee202 === 'A' && restored.mee313 === 'F' &&
    restored.mee443 === '' && restored.phy104 === 'A', JSON.stringify(restored));

  const stored = await exec(`
    var env = JSON.parse(localStorage.getItem('unn-mee-gpa-calculator'));
    var rec = env.records['unn-mee-beng-5yr@2023.1'];
    return { records: Object.keys(env.records).length, grades: Object.keys(rec.grades).length, keys: Object.keys(rec.grades).sort() };
  `);
  check('storage holds exactly one record per curriculum version, with no duplicates',
    stored.records === 1 && stored.grades === 4, JSON.stringify(stored));

  // --- The full-precision switch is display-only and remembers itself. ---
  const precBefore = await readSummary();
  precBefore.klass = await exec(`return document.getElementById('stat-class').textContent.trim();`);
  check('the switch starts off, showing the conventional 2 d.p.',
    (await exec(`return document.getElementById('toggle-precision').checked;`)) === false &&
    /^\d\.\d{2}$/.test(precBefore.gpa), JSON.stringify(precBefore));

  await exec(`
    var t = document.getElementById('toggle-precision');
    t.checked = true;
    t.dispatchEvent(new Event('change', { bubbles: true }));
  `);
  await new Promise((r) => setTimeout(r, 200));
  const precOn = await exec(`
    return {
      gpa: document.getElementById('stat-gpa').textContent.trim(),
      klass: document.getElementById('stat-class').textContent.trim(),
      units: document.getElementById('stat-units').textContent.trim(),
      points: document.getElementById('stat-points').textContent.trim(),
      semester: document.querySelectorAll('.sem-summary')[0].textContent.trim(),
      yearGpa: document.querySelectorAll('#year-totals tbody tr')[0].children[4].textContent.trim()
    };
  `);
  check('switching it on shows 5 d.p. everywhere',
    precOn.gpa === '3.50000' && precOn.yearGpa === '5.00000' && precOn.semester.includes('5.00000'),
    JSON.stringify(precOn));
  check('the underlying units and points are untouched',
    precOn.units === precBefore.units && precOn.points === precBefore.points,
    `${precBefore.units}/${precBefore.points} -> ${precOn.units}/${precOn.points}`);
  check('the degree classification does not move',
    precOn.klass === precBefore.klass, `${precBefore.klass} -> ${precOn.klass}`);

  // It must survive a reload, and must not have contaminated the results record.
  await go('about:blank');
  await go(APP);
  await waitFor(`document.querySelectorAll('tr[data-id]').length > 0`, 'reload after toggling precision');
  await waitFor(`document.getElementById('stat-courses').textContent.trim() !== '0'`, 'results to load');
  const precAfter = await exec(`
    return {
      checked: document.getElementById('toggle-precision').checked,
      gpa: document.getElementById('stat-gpa').textContent.trim(),
      prefsKey: localStorage.getItem('unn-mee-gpa-calculator:prefs'),
      resultsRecord: Object.keys(JSON.parse(localStorage.getItem('unn-mee-gpa-calculator')).records['unn-mee-beng-5yr@2023.1']).sort().join(',')
    };
  `);
  check('the switch is remembered across a reload',
    precAfter.checked === true && precAfter.gpa === '3.50000', JSON.stringify(precAfter));
  check('the preference is stored apart from the results',
    precAfter.prefsKey === '{"fullPrecision":true}' &&
    precAfter.resultsRecord === 'curriculum_id,curriculum_version,grades,saved_at,unitOverrides',
    JSON.stringify(precAfter));

  // Back off again for the remaining checks.
  await exec(`
    var t = document.getElementById('toggle-precision');
    t.checked = false;
    t.dispatchEvent(new Event('change', { bubbles: true }));
  `);
  await new Promise((r) => setTimeout(r, 200));
  check('switching it back off returns to 2 d.p.',
    (await readSummary()).gpa === '3.50', JSON.stringify(await readSummary()));

  // --- Filtering is display-only and must not disturb the GPA. ---
  await exec(`
    var f = document.getElementById('filter-text');
    f.value = 'thermodynamics';
    f.dispatchEvent(new Event('input', { bubbles: true }));
  `);
  await new Promise((r) => setTimeout(r, 120));
  const filtered = await exec(`
    return { visible: Array.from(document.querySelectorAll('tr[data-id]')).filter(function(r){ return !r.classList.contains('hidden'); }).length,
             gpa: document.getElementById('stat-gpa').textContent.trim() };
  `);
  check('searching filters the tables without touching the GPA',
    filtered.visible === 4 && filtered.gpa === before.gpa, JSON.stringify(filtered));
  await exec(`var f=document.getElementById('filter-text'); f.value=''; f.dispatchEvent(new Event('input',{bubbles:true}));`);

  // --- Export payload. ---
  const payload = await exec(`
    return JSON.stringify(JSON.parse(localStorage.getItem('unn-mee-gpa-calculator')).records['unn-mee-beng-5yr@2023.1']);
  `);
  check('the saved record carries the curriculum version and a timestamp',
    payload.includes('"curriculum_version":"2023.1"') && payload.includes('saved_at'));

  // --- Screenshot for the record. ---
  const shot = await call('GET', `/session/${sid}/screenshot`);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(process.env.SMOKE_SHOT ?? '/tmp/gpa-smoke.png', Buffer.from(shot, 'base64'));
  console.log(`\n  screenshot written to ${process.env.SMOKE_SHOT ?? '/tmp/gpa-smoke.png'}`);

  // Leave the browser profile clean for a repeat run.
  await exec(`localStorage.removeItem('unn-mee-gpa-calculator');`);
  await exec(`localStorage.removeItem('unn-mee-gpa-calculator:prefs');`);
} finally {
  await call('DELETE', `/session/${sid}`).catch(() => {});
}

console.log(`\n${failures === 0 ? 'All browser checks passed.' : `${failures} browser check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
