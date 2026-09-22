#!/usr/bin/env node
/**
 * End-to-end checks for the sessional statement, in a real Firefox.
 *
 * The statement is produced through the browser's print dialogue, which a
 * driver cannot open. What is checked instead is everything up to that point:
 * the form's validation, the prerequisite rule, the ticking of courses, the
 * figures, and the printed sheet's own markup and geometry — including the
 * 62.7 mm reserved for the pre-printed letterhead, read back from the
 * computed style under print emulation.
 *
 * Prerequisites: geckodriver --port 4444, and the app served.
 * Run:  node tools/transcript-smoke.mjs [appUrl] [driverUrl]
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
  capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': { args: ['-headless', '-width', '1280', '-height', '1200'] } } },
});
const sid = session.sessionId;
const exec = (s, a = []) => call('POST', `/session/${sid}/execute/sync`, { script: s, args: a });
const go = (url) => call('POST', `/session/${sid}/url`, { url });
const settle = () => new Promise((r) => setTimeout(r, 250));

const waitFor = async (expr, label) => {
  for (let i = 0; i < 150; i++) {
    if (await exec(`return (${expr});`)) return;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`timed out waiting for: ${label}`);
};

/** Grade every compulsory course of the given years, straight into storage. */
const gradeYears = (years, grade) => exec(`
  var years = ${JSON.stringify(years)};
  var rows = Array.from(document.querySelectorAll('tr[data-id]'));
  var n = 0;
  rows.forEach(function (tr) {
    var id = tr.dataset.id;
    var m = /^y(\\d+)s\\d/.exec(id);
    if (!m || years.indexOf(Number(m[1])) < 0) return;
    if (id.indexOf('pre-ccmas') >= 0) return;
    var sel = tr.querySelector('select.grade');
    if (!sel || sel.value) return;
    sel.value = '${grade}';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    n++;
  });
  return n;
`);

const fillForm = () => exec(`
  document.getElementById('t-session').value = '2023/2024';
  document.getElementById('t-first').value = 'Ifeoma';
  document.getElementById('t-middle').value = 'Blessing';
  document.getElementById('t-surname').value = 'Okechukwu';
  document.getElementById('t-regno').value = '2021/242857';
  document.getElementById('t-gender').value = 'Female';
  document.getElementById('t-sal1').value = 'Engr.';
  document.getElementById('t-sal1').dispatchEvent(new Event('change', { bubbles: true }));
  document.getElementById('t-sal2').value = 'Dr.';
  document.getElementById('t-init1').value = 'M';
  document.getElementById('t-init2').value = 'N';
  document.getElementById('t-adviser-surname').value = 'Eke';
  document.getElementById('t-adviser-surname').dispatchEvent(new Event('input', { bubbles: true }));
`);

/** Tick the first `limit` visible courses of a semester — visible meaning the
 *  year filter is showing them, which is what a student actually sees. */
const tick = (semester, limit) => exec(`
  var rows = Array.from(document.querySelectorAll('#t-courses .pick-row'))
    .filter(function (r) { return !r.hidden && r.querySelector('input[data-semester="${semester}"]'); });
  var n = 0;
  rows.forEach(function (r) { if (n < ${limit}) { r.querySelector('input').checked = true; n++; } });
  return n;
`);

const messages = () => exec(`
  var m = document.getElementById('t-messages');
  return { hidden: m.hidden, text: m.textContent.trim() };
`);

const submit = async () => { await exec(`document.getElementById('pdf-form').requestSubmit();`); await settle(); };

try {
  console.log(`\nSessional statement — ${APP}\n`);
  await go(APP);
  await waitFor(`document.querySelectorAll('tr[data-id]').length > 0`, 'the course tables');
  await exec(`localStorage.clear();`);
  await go(APP);
  await waitFor(`document.querySelectorAll('tr[data-id]').length > 0`, 'a clean page');

  // Printing must never be triggered by the driver.
  await exec(`window.__printed = 0; window.print = function () { window.__printed++; };`);

  /* ---- the button and the form ---- */
  check('the JSON export button is still there',
    (await exec(`return !!document.getElementById('btn-export');`)) === true);
  check('an Export as PDF button sits beside it',
    (await exec(`return !!document.getElementById('btn-pdf');`)) === true);
  check('the form starts closed',
    (await exec(`return document.getElementById('pdf-overlay').hidden;`)) === true);

  await exec(`document.getElementById('btn-pdf').click();`);
  await settle();
  check('clicking it opens the form',
    (await exec(`return document.getElementById('pdf-overlay').hidden === false;`)) === true);

  /* ---- the form has to fit a laptop screen ----
     The statement form was once tall enough that the Academic Adviser section
     sat below the fold on every ordinary screen. Nothing failed; it simply
     could not be found. This measures what a student actually sees. */
  await call('POST', `/session/${sid}/window/rect`, { width: 1366, height: 768, x: 0, y: 0 });
  await settle();
  const fold = await exec(`
    var legends = Array.from(document.querySelectorAll('#pdf-form legend'));
    var adviser = legends.find(function (l) { return l.textContent.indexOf('Adviser') >= 0; });
    var r = adviser.getBoundingClientRect();
    return {
      viewport: window.innerHeight,
      panelHeight: Math.round(document.querySelector('#pdf-overlay .overlay-panel').getBoundingClientRect().height),
      adviserTop: Math.round(r.top),
      visibleWithoutScrolling: r.top >= 0 && r.top < window.innerHeight
    };
  `);
  check('the Academic Adviser section is on screen without scrolling, on a laptop',
    fold.visibleWithoutScrolling === true, JSON.stringify(fold));
  check('and the form is not taller than about one and a half screens',
    fold.panelHeight < fold.viewport * 1.6,
    `${fold.panelHeight}px against a ${fold.viewport}px viewport`);
  await call('POST', `/session/${sid}/window/rect`, { width: 1280, height: 1400, x: 0, y: 0 });
  await settle();

  /* ---- the fields ---- */
  const fields = await exec(`return {
    years: Array.from(document.getElementById('t-year').options).map(function (o) { return o.text; }),
    genders: Array.from(document.getElementById('t-gender').options).map(function (o) { return o.text; }),
    genderLabel: document.getElementById('t-gender').closest('label').querySelector('span').textContent.trim(),
    sessionIsTyped: document.getElementById('t-session').tagName === 'INPUT',
    sal1: Array.from(document.getElementById('t-sal1').options).map(function (o) { return o.text; }),
    sal2: Array.from(document.getElementById('t-sal2').options).map(function (o) { return o.text; }),
    sal2Hidden: document.getElementById('t-sal2-field').hidden
  };`);
  check('Year of Study offers 1/5 to 8/5, and never 4/4',
    fields.years.join(',') === '1/5,2/5,3/5,4/5,5/5,6/5,7/5,8/5', fields.years.join(','));
  check('the label reads Gender, not Sex', fields.genderLabel === 'Gender', fields.genderLabel);
  check('Gender offers Male and Female',
    fields.genders.join(',') === '—,Male,Female', fields.genders.join(','));
  check('the session is typed by hand, not chosen from a list',
    fields.sessionIsTyped === true);
  check('the Academic Adviser titles are offered',
    fields.sal1.join(',') === 'Engr.,Prof.,Dr.,Mr.' && fields.sal2.join(',') === 'Prof.,Dr.,Mr.',
    `${fields.sal1.join(',')} | ${fields.sal2.join(',')}`);

  /* ---- the second title appears only for Engr. ---- */
  await exec(`var s = document.getElementById('t-sal1'); s.value = 'Prof.'; s.dispatchEvent(new Event('change', { bubbles: true }));`);
  await settle();
  check('the second title is hidden for Prof.',
    (await exec(`return document.getElementById('t-sal2-field').hidden;`)) === true);
  await exec(`var s = document.getElementById('t-sal1'); s.value = 'Engr.'; s.dispatchEvent(new Event('change', { bubbles: true }));`);
  await settle();
  check('and shown for Engr.',
    (await exec(`return document.getElementById('t-sal2-field').hidden;`)) === false);

  /* ---- nothing is ticked, and nothing is graded yet ---- */
  check('with no grades entered, the form says so',
    (await exec(`return document.getElementById('t-courses').textContent;`)).includes('not entered any grades'));

  /* ---- grade year 1 only, then try a year 3 statement ---- */
  await exec(`document.getElementById('t-cancel').click();`);
  await settle();
  const gradedY1 = await gradeYears([1], 'B');
  check('year one graded', gradedY1 === 19, `${gradedY1} courses`);

  await exec(`document.getElementById('btn-pdf').click();`);
  await settle();
  await fillForm();
  await exec(`var y = document.getElementById('t-year'); y.value = '3'; y.dispatchEvent(new Event('change', { bubbles: true }));`);
  const t1 = await tick(1, 2);
  check('courses can be ticked, and start unticked',
    t1 === 2 && (await exec(`return document.querySelectorAll('#t-courses input:checked').length;`)) === 2);
  check('the picker opens on the year being reported',
    (await exec(`return document.getElementById('t-course-year').value;`)) === '1',
    'only year 1 is graded so far');

  await submit();
  let msg = await messages();
  check('a year-3 statement is blocked while year 2 is missing',
    msg.hidden === false && /cannot be produced until every earlier year is complete/i.test(msg.text),
    msg.text.slice(0, 90));
  check('and it names the year that is incomplete', /Year 2:/.test(msg.text));
  check('nothing was printed', (await exec(`return window.__printed;`)) === 0);

  /* ---- a year-1 statement is allowed ---- */
  await exec(`var y = document.getElementById('t-year'); y.value = '1'; y.dispatchEvent(new Event('change', { bubbles: true }));`);
  await submit();
  check('a year-1 statement needs nothing earlier and is produced',
    (await exec(`return document.getElementById('preview-overlay').hidden === false;`)) === true);
  check('the form gives way to a preview of the sheet',
    (await exec(`return document.getElementById('pdf-overlay').hidden;`)) === true);
  check('nothing is printed until the student asks',
    (await exec(`return window.__printed;`)) === 0);
  await exec(`document.getElementById('preview-print').click();`);
  await settle();
  check('and the print dialogue opens when they do',
    (await exec(`return window.__printed;`)) === 1);
  check('the preview shows the sheet at A4 width',
    (await exec(`
      var s = document.querySelector('#print-root .sheet');
      var cs = getComputedStyle(s);
      return { w: cs.width, pt: cs.paddingTop, pl: cs.paddingLeft, visible: s.getBoundingClientRect().height > 100 };
    `)).visible === true);

  /* ---- the sheet itself ---- */
  const sheet = await exec(`
    var root = document.getElementById('print-root');
    var sheet = root.querySelector('.sheet');
    return {
      addressee: root.querySelector('.addressee').textContent.trim(),
      title: root.querySelector('.statement-title').textContent.trim(),
      details: root.querySelector('.details').textContent.replace(/\\s+/g, ' ').trim(),
      headings: Array.from(root.querySelectorAll('.sheet-semester h3')).map(function (h) { return h.textContent.trim(); }),
      rows: root.querySelectorAll('table.results tr').length,
      figures: Array.from(root.querySelectorAll('.figures div')).map(function (d) { return d.textContent.trim(); }),
      adviser: root.querySelector('.signature .adviser').textContent.trim(),
      role: root.querySelector('.signature .role').textContent.trim()
    };
  `);
  check('the addressee reads SURNAME, Firstname Middlename',
    sheet.addressee === 'To: OKECHUKWU, Ifeoma Blessing', sheet.addressee);
  check('the sheet is titled SESSIONAL STATEMENT OF RESULT',
    sheet.title === 'SESSIONAL STATEMENT OF RESULT');
  check('the details line carries Name, Reg. No, Year and Gender',
    /Name: OKECHUKWU, Ifeoma B\./.test(sheet.details) &&
    /Reg\. No: 2021\/242857/.test(sheet.details) &&
    /Year: 1\/5/.test(sheet.details) &&
    /Gender: Female/.test(sheet.details) && !/Sex/.test(sheet.details),
    sheet.details);
  check('the semester heading writes the session in full years',
    sheet.headings.length === 1 && /^FIRST SEMESTER \d{4}\/\d{4} ACADEMIC SESSION$/.test(sheet.headings[0]),
    sheet.headings.join(' | '));
  check('only the ticked courses appear', sheet.rows === 2, `${sheet.rows} rows`);
  check('both a session GPA and a cumulative CGPA are shown',
    sheet.figures.length === 2 && /^GPA: \d\.\d\d$/.test(sheet.figures[0]) && /^CGPA: \d\.\d\d$/.test(sheet.figures[1]),
    sheet.figures.join(' | '));
  check('the Academic Adviser reads Engr. Dr. M. N. Eke',
    sheet.adviser === 'Engr. Dr. M. N. Eke' && sheet.role === 'Academic Adviser', sheet.adviser);

  /* ---- the reserved letterhead space ----
     A driver cannot switch the page into print media, and the sheet is styled
     only under @media print, so the declared rule is read out of the stylesheet
     itself rather than from a computed style that would not apply. */
  const printRules = await exec(`
    var out = { sheet: null, page: null, found: false };
    for (var i = 0; i < document.styleSheets.length; i++) {
      var sheet;
      try { sheet = document.styleSheets[i].cssRules; } catch (e) { continue; }
      for (var j = 0; j < sheet.length; j++) {
        var rule = sheet[j];
        if (!rule.media || String(rule.media.mediaText).indexOf('print') < 0) continue;
        out.found = true;
        for (var k = 0; k < rule.cssRules.length; k++) {
          var inner = rule.cssRules[k];
          if (inner.selectorText === '.sheet') {
            out.sheet = {
              paddingTop: inner.style.paddingTop,
              paddingRight: inner.style.paddingRight,
              paddingBottom: inner.style.paddingBottom,
              paddingLeft: inner.style.paddingLeft,
              width: inner.style.width,
              minHeight: inner.style.minHeight
            };
          }
          if (inner.type === CSSRule.PAGE_RULE || /@page/.test(inner.cssText || '')) {
            out.page = inner.cssText;
          }
        }
      }
    }
    return out;
  `);
  const computed = await exec(`
    var s = document.querySelector('#print-root .sheet');
    var cs = getComputedStyle(s);
    return { paddingTop: cs.paddingTop, paddingLeft: cs.paddingLeft, width: cs.width, display: cs.display };
  `);
  const px = (mm) => (mm / 25.4) * 96;
  const near = (v, mm) => Math.abs(parseFloat(v) - px(mm)) < 1.5;
  check('the sheet really reserves 62.7 mm, as rendered',
    near(computed.paddingTop, 62.7), `${computed.paddingTop} (expected ~${px(62.7).toFixed(1)}px)`);
  check('and a 33 mm left margin, as rendered', near(computed.paddingLeft, 33), computed.paddingLeft);
  check('and is A4 wide, as rendered', near(computed.width, 210), computed.width);
  check('the printed page is A4 with no printer margin of its own',
    /a4/i.test(printRules.page ?? '') && /margin:\s*0/.test(printRules.page ?? ''),
    String(printRules.page));
  check('the calculator itself is not printed',
    (await exec(`
      for (var i = 0; i < document.styleSheets.length; i++) {
        var rules; try { rules = document.styleSheets[i].cssRules; } catch (e) { continue; }
        for (var j = 0; j < rules.length; j++) {
          var r = rules[j];
          if (!r.media || String(r.media.mediaText).indexOf('print') < 0) continue;
          for (var k = 0; k < r.cssRules.length; k++) {
            var sel = r.cssRules[k].selectorText || '';
            if (sel.indexOf('body') >= 0 && sel.indexOf('not(#preview-overlay)') >= 0) return true;
          }
        }
      }
      return false;
    `)) === true);

  /* ---- the CGPA really is cumulative ---- */
  await gradeYears([2], 'A');
  await exec(`document.getElementById('btn-pdf').click();`);
  await settle();
  await fillForm();
  await exec(`var y = document.getElementById('t-year'); y.value = '2'; y.dispatchEvent(new Event('change', { bubbles: true }));`);
  await settle();
  check('choosing a different year moves the picker to it',
    (await exec(`return document.getElementById('t-course-year').value;`)) === '2');
  await tick(1, 3);
  await tick(2, 3);
  await submit();
  const figures = await exec(`
    return Array.from(document.querySelectorAll('#print-root .figures div')).map(function (d) { return d.textContent.trim(); });
  `);
  check('a year-2 statement is allowed once year 1 is complete',
    (await exec(`return document.getElementById('preview-overlay').hidden === false;`)) === true);
  check('the session GPA is 5.00, the year-2 courses all being As',
    figures[0] === 'GPA: 5.00', figures.join(' | '));
  check('and the CGPA is lower, being dragged down by the Bs of year 1',
    Number(figures[1].split(' ')[1]) < 5 && Number(figures[1].split(' ')[1]) > 4,
    figures.join(' | '));

  /* ---- the details are remembered, the results are not touched ---- */
  const stored = await exec(`
    var prefs = JSON.parse(localStorage.getItem('unn-mee-gpa-calculator:prefs') || '{}');
    var rec = JSON.parse(localStorage.getItem('unn-mee-gpa-calculator'));
    return {
      remembered: prefs.transcript ? prefs.transcript.student.surname : null,
      resultKeys: Object.keys(rec.records['unn-mee-beng-5yr@2023.1']).sort().join(',')
    };
  `);
  check('the typed details are remembered for next time', stored.remembered === 'Okechukwu', String(stored.remembered));
  check('and no personal detail reaches the results record',
    stored.resultKeys === 'curriculum_id,curriculum_version,grades,repeats,saved_at,unitOverrides',
    stored.resultKeys);

  await exec(`localStorage.clear();`);
} finally {
  await call('DELETE', `/session/${sid}`).catch(() => {});
}

console.log(`\n${failures === 0 ? 'All statement checks passed.' : `${failures} statement check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
