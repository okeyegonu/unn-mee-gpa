#!/usr/bin/env node
/**
 * Produces a real PDF of the sessional statement, printed by the browser
 * itself through WebDriver's Print Page command — the same path a student
 * takes when they choose "Save as PDF".
 *
 * This is a mock-up: the details and grades are invented so the sheet can be
 * looked at and compared with the departmental reference.
 *
 * Prerequisites: geckodriver --port 4444, and the app served.
 * Run:  node tools/mockup-statement.mjs <appUrl> <out.pdf> [mee|unn]
 */
const APP = process.argv[2] ?? 'http://localhost:8000/';
const OUT = process.argv[3] ?? '/tmp/statement.pdf';
const KIND = process.argv[4] ?? 'unn';
const DRIVER = process.argv[5] ?? 'http://localhost:4444';

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
  capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless', '-width', '1280', '-height', '1400'] } } },
});
const sid = session.sessionId;
const exec = (s) => call('POST', `/session/${sid}/execute/sync`, { script: s, args: [] });
const go = (url) => call('POST', `/session/${sid}/url`, { url });
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (expr, label) => {
  for (let i = 0; i < 200; i++) {
    if (await exec(`return (${expr});`)) return;
    await settle(120);
  }
  throw new Error(`timed out waiting for ${label}`);
};

try {
  await go(APP);
  await waitFor(
    KIND === 'mee'
      ? `document.querySelectorAll('tr[data-id]').length > 0`
      : `document.getElementById('btn-add') && !document.getElementById('btn-add').disabled`,
    'the page',
  );
  await exec(`localStorage.clear();`);
  await go(APP);
  await waitFor(
    KIND === 'mee'
      ? `document.querySelectorAll('tr[data-id]').length > 0`
      : `document.getElementById('btn-add') && !document.getElementById('btn-add').disabled`,
    'a clean page',
  );

  if (KIND === 'mee') {
    // Years 1 and 2 at B, year 3 mostly A with one failed-then-passed course.
    await exec(`
      Array.from(document.querySelectorAll('tr[data-id]')).forEach(function (tr) {
        var m = /^y(\\d+)s\\d/.exec(tr.dataset.id);
        if (!m || Number(m[1]) > 3) return;
        if (tr.dataset.id.indexOf('pre-ccmas') >= 0) return;
        var sel = tr.querySelector('select.grade');
        if (!sel || sel.value) return;
        sel.value = Number(m[1]) === 3 ? 'A' : 'B';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
    `);
    await settle(900);
    // One third-year course failed and then passed, to show both sittings.
    await exec(`
      var t = document.getElementById('toggle-repeats');
      t.checked = true; t.dispatchEvent(new Event('change', { bubbles: true }));
    `);
    await settle(400);
    await exec(`
      var tr = document.querySelector('tr[data-id="y3s1-MEE313"]');
      var ss = tr.querySelectorAll('select.grade');
      ss[0].value = 'F'; ss[0].dispatchEvent(new Event('change', { bubbles: true }));
    `);
    await settle(400);
    await exec(`
      var ss = document.querySelectorAll('tr[data-id="y3s1-MEE313"] select.grade');
      ss[1].value = 'C'; ss[1].dispatchEvent(new Event('change', { bubbles: true }));
    `);
    await settle(400);
  } else {
    // A Medicine student: seven years to graduate, ten allowed.
    await exec(`
      document.getElementById('profile-department').value = 'Medicine and Surgery';
      document.getElementById('profile-programme').value = 'M.B.B.S.';
      document.getElementById('profile-min-years').value = '7';
      document.getElementById('profile-max-years').value = '10';
      document.getElementById('profile-max-years').dispatchEvent(new Event('change', { bubbles: true }));
    `);
    await settle(400);
    const add = async (code, title, dept, units, year, semester) => {
      await exec(`
        document.getElementById('f-code').value = ${'x'};
      `).catch(() => {});
      await exec(`
        document.getElementById('f-code').value = ${JSON.stringify(code)};
        document.getElementById('f-title').value = ${JSON.stringify(title)};
        document.getElementById('f-department').value = ${JSON.stringify(dept)};
        document.getElementById('f-units').value = '${units}';
        document.getElementById('f-year').value = '${year}';
        document.getElementById('f-semester').value = '${semester}';
        document.getElementById('add-form').requestSubmit();
      `);
      await settle(200);
    };
    for (const c of [
      ['MBB 101', 'Introduction to Medical Practice', 'Medicine and Surgery', 3, 1, 1],
      ['ANA 101', 'Gross Anatomy of the Upper Limb', 'Anatomy', 4, 1, 1],
      ['BCH 101', 'General Biochemistry', 'Biochemistry', 3, 1, 1],
      ['GST 111', 'Use of English', 'General Studies', 2, 1, 1],
      ['ANA 102', 'Gross Anatomy of the Lower Limb', 'Anatomy', 4, 1, 2],
      ['PIO 102', 'General Physiology', 'Physiology', 3, 1, 2],
      ['BCH 102', 'Metabolic Biochemistry', 'Biochemistry', 3, 1, 2],
      ['GST 112', 'Nigerian Peoples and Culture', 'General Studies', 2, 1, 2],
      ['ANA 201', 'Neuroanatomy', 'Anatomy', 4, 2, 1],
      ['PIO 201', 'Cardiovascular Physiology', 'Physiology', 4, 2, 1],
      ['BCH 201', 'Molecular Biology', 'Biochemistry', 3, 2, 1],
      ['ANA 202', 'Histology and Embryology', 'Anatomy', 3, 2, 2],
      ['PIO 202', 'Renal and Respiratory Physiology', 'Physiology', 4, 2, 2],
      ['PHA 202', 'General Pharmacology', 'Pharmacology', 3, 2, 2],
    ]) await add(...c);

    // Year 1 mixed, year 2 strong.
    await exec(`
      var grades = { 'MBB 101': 'B', 'ANA 101': 'C', 'BCH 101': 'B', 'GST 111': 'A',
                     'ANA 102': 'B', 'PIO 102': 'C', 'BCH 102': 'B', 'GST 112': 'A',
                     'ANA 201': 'A', 'PIO 201': 'A', 'BCH 201': 'B', 'ANA 202': 'A',
                     'PIO 202': 'A', 'PHA 202': 'B' };
      Array.from(document.querySelectorAll('tr[data-id]')).forEach(function (tr) {
        var code = tr.querySelector('.c-code').childNodes[0].textContent.trim();
        var g = grades[code];
        if (!g) return;
        var sel = tr.querySelector('select.grade');
        if (!sel || sel.value) return;
        sel.value = g;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
    `);
    await settle(900);
  }

  // Fill the statement form.
  await exec(`document.getElementById('btn-pdf').click();`);
  await settle(400);
  const details = KIND === 'mee'
    ? { first: 'Ifeoma', middle: 'Blessing', surname: 'Okechukwu', gender: 'Female', year: '3', reg: '2021/242857' }
    // The university-wide dropdown carries the programme length with the year.
    : { first: 'Chidi', middle: 'Emeka', surname: 'Nwosu', gender: 'Male', year: '2/7', reg: '2022/198443' };
  await exec(`
    document.getElementById('t-first').value = ${JSON.stringify(details.first)};
    document.getElementById('t-middle').value = ${JSON.stringify(details.middle)};
    document.getElementById('t-surname').value = ${JSON.stringify(details.surname)};
    document.getElementById('t-regno').value = ${JSON.stringify(details.reg)};
    document.getElementById('t-gender').value = ${JSON.stringify(details.gender)};
    var s1 = document.getElementById('t-sal1'); s1.value = 'Engr.';
    s1.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('t-sal2').value = 'Dr.';
    document.getElementById('t-init1').value = 'M';
    document.getElementById('t-init2').value = 'N';
    document.getElementById('t-adviser-surname').value = 'Eke';
    document.getElementById('t-adviser-surname').dispatchEvent(new Event('input', { bubbles: true }));
    var y = document.getElementById('t-year');
    y.value = ${JSON.stringify(details.year)};
    if (!y.value) y.value = y.options[0].value;
    y.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('t-session').value = '2023/2024';
  `);
  await settle(400);
  if (KIND !== 'mee') {
    // A Medicine adviser is not an engineer.
    await exec(`
      var s1 = document.getElementById('t-sal1'); s1.value = 'Prof.';
      s1.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('t-init1').value = 'C';
      document.getElementById('t-init2').value = 'U';
      document.getElementById('t-adviser-surname').value = 'Anyanwu';
      document.getElementById('t-adviser-surname').dispatchEvent(new Event('input', { bubbles: true }));
    `);
    await settle(200);
  }
  const ticked = await exec(`
    var n = 0;
    document.querySelectorAll('#t-courses .pick-row').forEach(function (r) {
      if (!r.hidden) { r.querySelector('input').checked = true; n++; }
    });
    return n;
  `);
  await exec(`document.getElementById('pdf-form').requestSubmit();`);
  await settle(700);

  const shown = await exec(`return document.getElementById('preview-overlay').hidden === false;`);
  if (!shown) {
    const msg = await exec(`return document.getElementById('t-messages').textContent.trim();`);
    throw new Error(`the statement was refused: ${msg}`);
  }

  // Print the page to PDF, exactly as the browser would.
  const pdf = await call('POST', `/session/${sid}/print`, {
    page: { width: 21.0, height: 29.7 },      // A4 in centimetres
    margin: { top: 0, bottom: 0, left: 0, right: 0 },
    background: false,
    shrinkToFit: false,
  });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(OUT, Buffer.from(pdf, 'base64'));

  const figures = await exec(`
    return {
      addressee: document.querySelector('#print-root .addressee').textContent.trim(),
      details: document.querySelector('#print-root .details').textContent.replace(/\\s+/g, ' ').trim(),
      headings: Array.from(document.querySelectorAll('#print-root .sheet-semester h3')).map(function (h) { return h.textContent.trim(); }),
      rows: document.querySelectorAll('#print-root table.results tr').length,
      figures: Array.from(document.querySelectorAll('#print-root .figures div')).map(function (d) { return d.textContent.trim(); }),
      adviser: document.querySelector('#print-root .signature .adviser').textContent.trim()
    };
  `);
  console.log(`${OUT}  (${ticked} courses ticked)`);
  console.log(`  ${figures.addressee}`);
  console.log(`  ${figures.details}`);
  for (const h of figures.headings) console.log(`  ${h}`);
  console.log(`  ${figures.rows} course rows · ${figures.figures.join(' · ')} · ${figures.adviser}`);
} finally {
  await call('DELETE', `/session/${sid}`).catch(() => {});
}
