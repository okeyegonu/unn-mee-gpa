/**
 * transcript-ui.js — the sessional statement form, and the sheet it prints.
 *
 * The statement is produced through the browser's own print dialogue rather
 * than by a PDF library. That is deliberate: the sheet is meant to be printed
 * on pre-printed University letterhead, so printing is the primary use and
 * "Save as PDF" is the same dialogue. It also keeps the calculator free of a
 * third-party dependency, which matters because the whole application is also
 * shipped as one offline file.
 *
 * Nothing here computes a GPA; that is gpa-engine.js by way of transcript.js.
 */

import {
  GENDERS, ADVISER_SALUTATIONS_1, ADVISER_SALUTATIONS_2, ADVISER_SALUTATION_2_APPLIES_TO,
  yearOfStudyOptions, formatAdviser, parseSession,
  transcriptProblems, prerequisiteCheck, buildTranscript,
} from './transcript.js';
import { attemptsOf, evaluateCourse } from './gpa-engine.js';

const pick = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * @param {object} opts
 * @param {() => object}   opts.getState        current results
 * @param {() => object[]} opts.getCourses      resolved course records
 * @param {number}         opts.programmeYears  denominator of "Year of Study"
 * @param {(year:number, state:object, courses:object[]) => object[]} opts.requiredCoursesForYear
 * @param {object}         [opts.prefs]         PreferencesStore, to remember the details
 * @param {string}         [opts.institution]
 * @param {string}         [opts.department]
 */
export function initTranscript(opts) {
  const els = {
    open: pick('#btn-pdf'),
    overlay: pick('#pdf-overlay'),
    close: pick('#pdf-close'),
    cancel: pick('#t-cancel'),
    form: pick('#pdf-form'),
    messages: pick('#t-messages'),
    courses: pick('#t-courses'),
    year: pick('#t-year'),
    gender: pick('#t-gender'),
    session: pick('#t-session'),
    sal1: pick('#t-sal1'),
    sal2: pick('#t-sal2'),
    sal2Field: pick('#t-sal2-field'),
    adviserPreview: pick('#t-adviser-preview'),
    printRoot: pick('#print-root'),
    preview: pick('#preview-overlay'),
    previewClose: pick('#preview-close'),
    previewPrint: pick('#preview-print'),
    previewBack: pick('#preview-back'),
    first: pick('#t-first'), middle: pick('#t-middle'), surname: pick('#t-surname'),
    regno: pick('#t-regno'),
    init1: pick('#t-init1'), init2: pick('#t-init2'), init3: pick('#t-init3'),
    adviserSurname: pick('#t-adviser-surname'),
  };
  if (!els.open || !els.overlay) return { open() {} };

  fillSelects();
  restoreDetails();
  wire();

  /** The programme length may be fixed, or read fresh when it can change. */
  function programmeYears() {
    return typeof opts.programmeYears === 'function' ? opts.programmeYears() : opts.programmeYears;
  }

  /**
   * How far the year of study may run. A five-year programme with eight years
   * allowed reaches 8/5; a seven-year programme such as Medicine, with ten
   * allowed, reaches 10/7. Tying this to eight would cut such a student off.
   */
  function maxYearOfStudy() {
    const raw = typeof opts.maxYearOfStudy === 'function' ? opts.maxYearOfStudy() : opts.maxYearOfStudy;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1) return Math.min(15, n);
    return Math.max(8, Number(programmeYears()) || 0);
  }

  function fillSelects() {
    const keep = els.year.value;
    els.year.innerHTML = '';
    for (const o of yearOfStudyOptions(programmeYears(), maxYearOfStudy())) {
      els.year.append(new Option(o.label, String(o.value)));
    }
    if (keep) els.year.value = keep;


    els.sal1.innerHTML = '';
    for (const s of ADVISER_SALUTATIONS_1) els.sal1.append(new Option(s, s));
    els.sal2.innerHTML = '';
    for (const s of ADVISER_SALUTATIONS_2) els.sal2.append(new Option(s, s));
  }

  /** The second title belongs only to "Engr.". */
  function syncSalutation2() {
    const applies = els.sal1.value === ADVISER_SALUTATION_2_APPLIES_TO;
    els.sal2Field.hidden = !applies;
    // A title on its own names nobody, so the preview waits for a surname.
    const composed = formatAdviser(readAdviser());
    els.adviserPreview.textContent =
      composed && readAdviser().surname.trim() ? `Will read: ${composed}` : '';
  }

  function readStudent() {
    return {
      first: els.first.value,
      middle: els.middle.value,
      surname: els.surname.value,
      regNo: els.regno.value,
      gender: els.gender.value,
    };
  }

  function readAdviser() {
    return {
      salutation1: els.sal1.value,
      salutation2: els.sal1.value === ADVISER_SALUTATION_2_APPLIES_TO ? els.sal2.value : '',
      initial1: els.init1.value,
      initial2: els.init2.value,
      initial3: els.init3.value,
      surname: els.adviserSurname.value,
    };
  }

  /**
   * The details are worth remembering — a student produces a statement once a
   * session, and retyping a name and registration number each time is a chore.
   * They are kept with the display preferences, never with the results, and
   * never leave the browser.
   */
  function rememberDetails() {
    opts.prefs?.set('transcript', { student: readStudent(), adviser: readAdviser() });
  }

  function restoreDetails() {
    const saved = opts.prefs?.get('transcript');
    if (!saved || typeof saved !== 'object') { syncSalutation2(); return; }
    const s = saved.student ?? {}, h = saved.adviser ?? {};
    els.first.value = s.first ?? '';
    els.middle.value = s.middle ?? '';
    els.surname.value = s.surname ?? '';
    els.regno.value = s.regNo ?? '';
    if (GENDERS.includes(s.gender)) els.gender.value = s.gender;
    if (ADVISER_SALUTATIONS_1.includes(h.salutation1)) els.sal1.value = h.salutation1;
    if (ADVISER_SALUTATIONS_2.includes(h.salutation2)) els.sal2.value = h.salutation2;
    els.init1.value = h.initial1 ?? '';
    els.init2.value = h.initial2 ?? '';
    els.init3.value = h.initial3 ?? '';
    els.adviserSurname.value = h.surname ?? '';
    syncSalutation2();
  }

  /* ------------------------------------------------------- course ticking */

  /**
   * Only graded courses are offered: a course with no result cannot appear on a
   * statement. Nothing is ticked — the student says what they sat this session.
   */
  function renderCourses() {
    const state = opts.getState();
    const graded = opts.getCourses().filter((c) => attemptsOf(c, state).length > 0);

    els.courses.innerHTML = '';
    if (graded.length === 0) {
      els.courses.innerHTML =
        '<p class="pick-empty">You have not entered any grades yet, so there is nothing to put on a statement.</p>';
      return;
    }

    // A student sits mostly the courses of one curriculum year, so the list
    // opens on the year being reported and can be widened for anyone carrying
    // a course from an earlier year.
    const years = [...new Set(graded.map((c) => c.year))].sort((a, b) => a - b);
    const tools = document.createElement('div');
    tools.className = 'pick-tools';
    tools.innerHTML = '<label class="field narrow"><span>Show courses from</span></label>';
    const filter = document.createElement('select');
    filter.id = 't-course-year';
    filter.append(new Option('All years', 'all'));
    for (const y of years) filter.append(new Option(`Year ${y}`, String(y)));
    const wanted = els.year.value;
    filter.value = years.includes(Number(wanted)) ? wanted : 'all';
    filter.addEventListener('change', () => applyPickFilter());
    tools.querySelector('label').append(filter);
    els.courses.append(tools);

    for (const semester of [1, 2]) {
      const here = graded.filter((c) => c.semester === semester);
      const wrap = document.createElement('div');
      wrap.className = 'pick-semester';
      const h4 = document.createElement('h4');
      h4.textContent = semester === 1 ? 'First semester' : 'Second semester';
      wrap.append(h4);

      const list = document.createElement('div');
      list.className = 'pick-list';
      if (here.length === 0) {
        list.innerHTML = '<p class="pick-empty">No graded courses.</p>';
      } else {
        for (const c of here) {
          const ev = evaluateCourse(c, state);
          const grades = ev.attempts.map((a) => a.grade).join(' / ');
          const failed = ev.attempts.some((a) => a.grade === 'F');
          const row = document.createElement('label');
          row.className = 'pick-row';
          row.dataset.year = String(c.year);
          row.innerHTML =
            `<input type="checkbox" value="${esc(c.id)}" data-semester="${semester}">` +
            `<span class="pick-code">${esc(c.code)}</span>` +
            `<span class="pick-title">${esc(c.title ?? '')}</span>` +
            `<span class="pick-year">Year ${c.year}</span>` +
            `<span class="pick-grade" data-fail="${failed ? 'yes' : 'no'}">${esc(grades)}</span>`;
          list.append(row);
        }
      }
      wrap.append(list);
      els.courses.append(wrap);
    }
    applyPickFilter();
  }

  /** Narrow the picker to one curriculum year, or show them all. */
  function applyPickFilter() {
    const want = els.courses.querySelector('#t-course-year')?.value ?? 'all';
    for (const row of els.courses.querySelectorAll('.pick-row')) {
      const show = want === 'all' || row.dataset.year === want;
      row.hidden = !show;
      // A hidden course must not be silently carried onto the statement.
      if (!show) row.querySelector('input').checked = false;
    }
  }

  const ticked = (semester) => {
    const state = opts.getState();
    const byId = new Map(opts.getCourses().map((c) => [c.id, c]));
    return [...els.courses.querySelectorAll(`input[type=checkbox][data-semester="${semester}"]:checked`)]
      .map((box) => byId.get(box.value))
      .filter((c) => c && attemptsOf(c, state).length > 0);
  };

  /* ------------------------------------------------------------- messages */

  function showProblems(list, heading) {
    if (list.length === 0) { els.messages.hidden = true; els.messages.innerHTML = ''; return; }
    const head = heading ? `<p class="msg error"><strong>${esc(heading)}</strong></p>` : '';
    els.messages.innerHTML = head + list.map((p) => `<p class="msg error">${esc(p)}</p>`).join('');
    els.messages.hidden = false;
    els.messages.scrollIntoView({ block: 'nearest' });
  }

  /* -------------------------------------------------------------- the sheet */

  function renderSheet(t) {
    const semesterBlock = (label, rows, session) => {
      if (rows.length === 0) return '';
      return `<section class="sheet-semester">
        <h3>${esc(label)} ${esc(session)} ACADEMIC SESSION</h3>
        <table class="results"><tbody>${rows.map((r) => `
          <tr>
            <td class="r-code">${esc(r.code)}</td>
            <td class="r-title">${esc(r.title)}</td>
            <td class="r-grade">${esc(r.grade)}</td>
          </tr>`).join('')}</tbody></table>
      </section>`;
    };

    els.printRoot.innerHTML = `<div class="sheet">
      <p class="addressee">To: ${esc(t.addressee)}</p>
      <p class="statement-title">SESSIONAL STATEMENT OF RESULT</p>
      <p class="details">
        <span><b>Name:</b> ${esc(t.name)}</span>
        <span><b>Reg. No:</b> ${esc(t.regNo)}</span>
        <span><b>Year:</b> ${esc(t.yearOfStudy)}</span>
        <span><b>Gender:</b> ${esc(t.gender)}</span>
      </p>
      ${semesterBlock(t.semesters[0].label, t.semesters[0].rows, t.session)}
      ${semesterBlock(t.semesters[1].label, t.semesters[1].rows, t.session)}
      <div class="figures">
        <div>GPA: ${esc(t.gpa)}</div>
        <div>CGPA: ${esc(t.cgpa)}</div>
      </div>
      <div class="signature">
        <div class="adviser">${esc(t.adviser)}</div>
        <div class="role">Academic Adviser</div>
      </div>
    </div>`;
  }

  /* --------------------------------------------------------------- events */

  function open() {
    renderCourses();
    els.messages.hidden = true;
    els.overlay.hidden = false;
    document.body.style.overflow = 'hidden';
    els.first.focus();
  }

  function close() {
    els.overlay.hidden = true;
    els.preview.hidden = true;
    document.body.style.overflow = '';
  }

  /** Back from the preview to the form, keeping everything that was entered. */
  function backToForm() {
    els.preview.hidden = true;
    els.overlay.hidden = false;
  }

  function wire() {
    els.open.addEventListener('click', open);
    els.close.addEventListener('click', close);
    els.cancel.addEventListener('click', close);
    els.overlay.addEventListener('click', (e) => { if (e.target === els.overlay) close(); });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!els.preview.hidden) { backToForm(); return; }
      if (!els.overlay.hidden) close();
    });

    els.year.addEventListener('change', () => {
      const filter = els.courses.querySelector('#t-course-year');
      if (!filter) return;
      const wanted = els.year.value;
      if ([...filter.options].some((o) => o.value === wanted)) filter.value = wanted;
      applyPickFilter();
    });

    els.previewClose.addEventListener('click', close);
    els.previewBack.addEventListener('click', backToForm);
    els.previewPrint.addEventListener('click', () => window.print());
    els.preview.addEventListener('click', (e) => { if (e.target === els.preview) close(); });

    els.sal1.addEventListener('change', syncSalutation2);
    for (const el of [els.sal2, els.init1, els.init2, els.init3, els.adviserSurname]) {
      el.addEventListener('input', syncSalutation2);
    }

    els.form.addEventListener('submit', (e) => {
      e.preventDefault();
      produce();
    });
  }

  function produce() {
    const state = opts.getState();
    const student = readStudent();
    const adviser = readAdviser();
    const year = Number(els.year.value);
    const session = parseSession(els.session.value).year;
    const firstSemester = ticked(1);
    const secondSemester = ticked(2);

    const problems = transcriptProblems({ student, adviser, session, yearOfStudy: year, firstSemester, secondSemester });
    if (problems.length > 0) { showProblems(problems); return; }

    // A statement is a cumulative document, so every earlier year must be
    // complete before one can be produced.
    const pre = prerequisiteCheck(year, state,
      (y) => opts.requiredCoursesForYear(y, state, opts.getCourses()));
    if (!pre.ok) {
      const lines = pre.missingByYear.map(({ year: y, courses }) => {
        const codes = courses.map((c) => c.code);
        const shown = codes.slice(0, 12).join(', ');
        const more = codes.length > 12 ? ` and ${codes.length - 12} more` : '';
        return `Year ${y}: ${codes.length} result${codes.length === 1 ? '' : 's'} missing — ${shown}${more}.`;
      });
      showProblems(lines,
        `A statement for year ${year} cannot be produced until every earlier year is complete. ` +
        `${pre.missingCount} result${pre.missingCount === 1 ? ' is' : 's are'} still missing:`);
      return;
    }

    // The CGPA covers every result entered for this year and the years before it.
    const cumulativeCourses = opts.getCourses().filter((c) => c.year <= year);

    const t = buildTranscript({
      student, adviser, session, yearOfStudy: year, programmeYears: programmeYears(),
      firstSemester, secondSemester, cumulativeCourses, state,
      uppercaseTitles: opts.uppercaseTitles !== false,
    });

    rememberDetails();
    renderSheet(t);
    els.messages.hidden = true;
    // The statement is shown before it is printed. On a phone especially, a
    // print dialogue with nothing to check first is a leap of faith.
    els.overlay.hidden = true;
    els.preview.hidden = false;
    els.preview.scrollTop = 0;
    els.previewPrint.focus();
  }

  return { open, close };
}
