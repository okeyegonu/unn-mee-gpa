/**
 * ui.js — presentation only.
 *
 * This module knows about the DOM. It does not know how a GPA is computed
 * (gpa-engine.js), what the grade scale is (grading.js), where results are kept
 * (storage.js), or what the courses are (data/curriculum.json).
 */

import { GRADES } from './grading.js';
import { flattenCurriculum, semesterKeys, maxAttemptsForYear, courseId, indexCourses } from './curriculum.js';
import {
  emptyState, setGrade, setUnitOverride, clearAll,
  evaluateCourse, summarise, semesterSummaries, yearSummaries, formatGpa,
  setAttempt, canonicaliseState, attemptsOf,
} from './gpa-engine.js';
import { ResultsRepository, PreferencesStore } from './storage.js';
import { initTranscript } from './transcript-ui.js';

const $ = (sel) => document.querySelector(sel);

const els = {
  bootError: $('#boot-error'),
  versionNotice: $('#version-notice'),
  meta: $('#curriculum-meta'),
  root: $('#curriculum-root'),
  yearnav: $('#yearnav'),
  filterText: $('#filter-text'),
  filterEntered: $('#filter-entered'),
  togglePrecision: $('#toggle-precision'),
  togglePrecisionLabel: $('#toggle-precision-label'),
  toggleRepeats: $('#toggle-repeats'),
  toggleRepeatsLabel: $('#toggle-repeats-label'),
  toggleCohort: $('#toggle-cohort'),
  toggleCohortLabel: $('#toggle-cohort-label'),
  cohortNotice: $('#cohort-notice'),
  attemptsNote: $('#stat-attempts'),
  gpa: $('#stat-gpa'),
  klass: $('#stat-class'),
  courses: $('#stat-courses'),
  units: $('#stat-units'),
  points: $('#stat-points'),
  saveState: $('#save-state'),
  yearTotals: $('#year-totals').tBodies[0],
  cumCourses: $('#cum-courses'),
  cumUnits: $('#cum-units'),
  cumPoints: $('#cum-points'),
  cumGpa: $('#cum-gpa'),
  colophon: $('#colophon'),
  btnExport: $('#btn-export'),
  btnImport: $('#btn-import'),
  btnReset: $('#btn-reset'),
  fileImport: $('#file-import'),
};

let doc = null;         // the curriculum document
let prefs = null;       // display preferences, per viewer
let precision = { normal: 2, full: 5 };   // from reporting.* in the data file
let courses = [];       // flat course records
let byId = new Map();   // id -> course
let state = null;       // { curriculumVersion, grades, unitOverrides }
let repo = null;
const rowRefs = new Map();   // courseId -> { tr, select, unitCell, gpCell, pointCell }
const semRefs = new Map();   // "y1s1"  -> summary element

/* ------------------------------------------------------------------ boot */

async function boot() {
  try {
    // The single-file build (dist/) embeds the curriculum so that the page works
    // straight from a downloaded file, with no server and no network.
    if (globalThis.__UNN_CURRICULUM__) {
      doc = globalThis.__UNN_CURRICULUM__;
    } else {
      const res = await fetch('./data/curriculum.json', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status} fetching data/curriculum.json`);
      doc = await res.json();
    }
  } catch (err) {
    els.bootError.hidden = false;
    els.bootError.innerHTML =
      `<strong>Could not load the curriculum data.</strong><br>${escapeHtml(String(err.message || err))}` +
      `<br><br>If you opened this file directly from disk, browsers block the data file for security reasons. ` +
      `Start the small local server instead:<br><code>cd gpa-calculator &amp;&amp; python3 -m http.server 8000</code>` +
      `<br>then open <code>http://localhost:8000/</code>.`;
    return;
  }

  courses = flattenCurriculum(doc);
  byId = indexCourses(courses);
  precision = {
    normal: doc.reporting?.gpa_decimal_places ?? 2,
    full: doc.reporting?.gpa_full_precision_places ?? 5,
  };
  prefs = new PreferencesStore();
  repo = new ResultsRepository({
    curriculumId: doc.curriculum_id,
    curriculumVersion: doc.curriculum_version,
  });

  const loaded = await repo.load();
  const raw = loaded.state ?? emptyState(doc.curriculum_version);

  // Anything arriving from storage is brought into canonical form, and the
  // tidied version written straight back, so a record left non-canonical by an
  // earlier version or by hand-editing is repaired once and for all rather than
  // carried around.
  state = canonicaliseState(courses, raw);
  if (loaded.found && JSON.stringify(state) !== JSON.stringify(raw)) await repo.save(state);

  if (!loaded.found && loaded.otherVersions.length > 0) offerCarryOver(loaded.otherVersions);

  els.meta.textContent =
    `${doc.programme_track} · curriculum version ${doc.curriculum_version} · ${courses.length} courses`;

  buildYearNav();
  buildTables();
  wireGlobalControls();
  wireTranscript();
  refreshAll();
  els.saveState.textContent = loaded.found
    ? `Loaded saved results${loaded.savedAt ? ` (saved ${formatWhen(loaded.savedAt)})` : ''}`
    : 'No results entered yet';
  renderColophon();
}

/* --------------------------------------------------------------- building */

function buildYearNav() {
  els.yearnav.innerHTML = '';
  for (const y of doc.years) {
    const a = document.createElement('a');
    a.href = `#year-${y.year}`;
    a.textContent = y.label;
    els.yearnav.append(a);
  }
}

function buildTables() {
  els.root.innerHTML = '';
  for (const year of doc.years) {
    const section = document.createElement('section');
    section.className = 'year';
    section.id = `year-${year.year}`;

    const h2 = document.createElement('h2');
    h2.textContent = year.label;
    section.append(h2);

    for (const sem of year.semesters) {
      section.append(buildSemester(year, sem));
    }
    els.root.append(section);
  }
}

function buildSemester(year, sem) {
  const key = `y${year.year}s${sem.semester}`;
  const wrap = document.createElement('article');
  wrap.className = 'semester';

  const header = document.createElement('header');
  const h3 = document.createElement('h3');
  h3.textContent = sem.label;
  const summary = document.createElement('div');
  summary.className = 'sem-summary';
  semRefs.set(key, summary);
  header.append(h3, summary);
  wrap.append(header);

  const currentGroups = sem.groups.filter((g) => g.type !== 'cohort').length;
  for (const group of sem.groups) {
    const isElective = group.type === 'elective';
    const isCohort = group.type === 'cohort';
    // A heading appears for electives and cohorts, and for the current courses
    // only where there was already more than one group of them — so adding a
    // cohort never changes how the current list looks.
    if (isElective || isCohort || currentGroups > 1) {
      const gh = document.createElement('div');
      gh.className = 'group-head' + (isElective ? ' elective' : '') + (isCohort ? ' cohort' : '');
      if (isCohort) gh.dataset.cohort = group.cohort_id;
      gh.innerHTML = `<strong>${escapeHtml(group.label)}</strong>` +
        (isCohort ? ` — ${escapeHtml(group.note ?? '')}` : '') +
        (isElective && group.choose
          ? ` — the programme says choose ${group.choose} course${group.choose > 1 ? 's' : ''}` +
            (group.choose_units ? ` (${group.choose_units} units)` : '') +
            `. Just enter grades for the electives you actually took; the calculator counts whatever you enter.`
          : '');
      wrap.append(gh);
    }

    const table = document.createElement('table');
    table.className = 'courses';
    if (isCohort) table.dataset.cohort = group.cohort_id;
    table.innerHTML =
      '<thead><tr>' +
      '<th>Course</th><th class="col-title">Title</th>' +
      '<th class="num">Units</th><th>Grade</th>' +
      '<th class="num">Grade&nbsp;pt</th><th class="num">Course&nbsp;pt</th>' +
      '</tr></thead><tbody></tbody>';
    const tbody = table.tBodies[0];

    for (const c of group.courses) {
      tbody.append(buildRow(year, sem, group, c));
    }
    wrap.append(table);
  }
  return wrap;
}

function buildRow(year, sem, group, rawCourse) {
  // Look the course up by its id, not by its code: a code can appear in both
  // the current curriculum and an alternative cohort, and the two are
  // different courses with different ids.
  const id = courseId(year.year, sem.semester, rawCourse.code, group.cohort_id ?? null);
  const course = byId.get(id);
  if (!course) throw new Error(`no flattened course for ${id}`);
  const tr = document.createElement('tr');
  tr.dataset.id = course.id;
  if (course.cohortId) tr.dataset.cohort = course.cohortId;

  const tdCode = document.createElement('td');
  tdCode.className = 'c-code';
  tdCode.textContent = course.code;
  if (course.legacyCode) {
    const s = document.createElement('div');
    s.className = 'legacy';
    s.textContent = `was ${course.legacyCode}`;
    tdCode.append(s);
  }

  const tdTitle = document.createElement('td');
  tdTitle.className = 'c-title';
  if (course.titleUnknown) {
    tdTitle.innerHTML = '<span class="unknown">Title not stated in the source document</span>';
  } else {
    tdTitle.textContent = course.title;
  }
  if (course.notes) {
    const n = document.createElement('span');
    n.className = 'c-note';
    n.textContent = course.notes;
    tdTitle.append(n);
  }

  const tdUnits = document.createElement('td');
  tdUnits.className = 'num cell-units';
  tdUnits.dataset.label = 'Units';

  const tdGrade = document.createElement('td');
  tdGrade.className = 'cell-grade';
  const stack = document.createElement('div');
  stack.className = 'attempt-stack';
  tdGrade.append(stack);

  const tdGp = document.createElement('td');
  tdGp.className = 'num cell-gp';
  tdGp.dataset.label = 'Grade pt';
  const tdPt = document.createElement('td');
  tdPt.className = 'num cell-pt';
  tdPt.dataset.label = 'Course pt';

  tr.append(tdCode, tdTitle, tdUnits, tdGrade, tdGp, tdPt);
  rowRefs.set(course.id, { tr, stack, selects: [], tdUnits, tdGp, tdPt, course });
  return tr;
}

/**
 * Make the row show exactly `count` grade controls, reusing the ones already
 * there. Reusing rather than rebuilding is what keeps the control the student
 * just changed from losing focus when the row re-renders.
 */
function syncSelects(ref, count) {
  while (ref.selects.length < count) {
    const index = ref.selects.length;
    const sel = document.createElement('select');
    sel.className = 'grade';
    sel.append(new Option('—', ''));
    for (const g of GRADES) sel.append(new Option(g, g));
    sel.addEventListener('change', () => onAttemptChange(ref.course, index, sel.value));
    const wrap = document.createElement('span');
    wrap.className = 'attempt';
    wrap.dataset.sitting = String(index + 1);
    wrap.append(sel);
    ref.stack.append(wrap);
    ref.selects.push(sel);
  }
  while (ref.selects.length > count) {
    ref.selects.pop().closest('.attempt').remove();
  }
}

/* ---------------------------------------------------------------- events */

async function onAttemptChange(course, index, value) {
  state = setAttempt(state, course, index, value);
  await persist();
  refreshAll();
}

async function onUnitOverride(id, value) {
  state = setUnitOverride(state, id, value);
  await persist();
  refreshAll();
}

async function persist() {
  try {
    await repo.save(state);
    els.saveState.textContent = `Saved ${formatWhen(new Date().toISOString())}`;
  } catch (err) {
    els.saveState.textContent = `Could not save: ${err.message}`;
  }
}

function wireGlobalControls() {
  els.filterText.addEventListener('input', applyFilter);
  els.filterEntered.addEventListener('change', applyFilter);

  els.togglePrecisionLabel.textContent = `Show full precision (${precision.full} d.p.)`;
  els.togglePrecision.title =
    `The GPA is always calculated at full precision; this shows ${precision.full} decimal places ` +
    `instead of the usual ${precision.normal}. Your degree classification is unaffected.`;
  els.togglePrecision.checked = prefs.get('fullPrecision', false) === true;
  els.togglePrecision.addEventListener('change', () => {
    prefs.set('fullPrecision', els.togglePrecision.checked);
    refreshAll();
  });

  const maxFirst = maxAttemptsForYear(1, doc.progression);
  const maxLast = maxAttemptsForYear(doc.years.length, doc.progression);
  els.toggleRepeatsLabel.textContent = 'I repeated a course';
  els.toggleRepeats.title =
    `Show a grade box for every sitting of a course. Each sitting counts separately: its units go ` +
    `into the total again and its points are added again, so repeating a course lowers the GPA. ` +
    `A First Year course allows up to ${maxFirst} sittings and a Final Year course up to ${maxLast}, ` +
    `within the ${doc.progression?.maximum_years_to_graduate ?? 8}-year maximum.`;
  els.toggleRepeats.checked = prefs.get('showRepeats', false) === true;
  els.toggleRepeats.addEventListener('change', () => {
    prefs.set('showRepeats', els.toggleRepeats.checked);
    refreshAll();
  });

  const cohort = (doc.cohorts ?? [])[0] ?? null;
  els.toggleCohortLabel.textContent = 'Show pre-CCMAS first-year courses';
  els.toggleCohort.title = cohort?.description ??
    'Show the First Year as printed in the 2023 programme, for students who began before the CCMAS revision.';
  els.toggleCohort.checked = prefs.get('showCohort', false) === true;
  els.toggleCohort.addEventListener('change', () => {
    prefs.set('showCohort', els.toggleCohort.checked);
    refreshAll();
  });

  els.btnExport.addEventListener('click', async () => {
    const payload = await repo.exportPayload(state, {
      institution: doc.institution,
      programme: doc.programme,
      summary: publicSummary(),
      course_records: courseRecords(),
    });
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `unn-mee-gpa-${doc.curriculum_version}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });

  els.btnImport.addEventListener('click', () => els.fileImport.click());
  els.fileImport.addEventListener('change', async () => {
    const file = els.fileImport.files?.[0];
    els.fileImport.value = '';
    if (!file) return;
    try {
      const parsed = repo.parseImport(JSON.parse(await file.text()));
      const n = Object.keys(parsed.state.grades).length;
      const warn = parsed.versionMismatch
        ? `\n\nNote: that file was exported under curriculum version ${parsed.importedVersion}, ` +
          `but this calculator is running curriculum version ${doc.curriculum_version}. ` +
          `Grades for courses that no longer exist will simply be ignored.`
        : '';
      if (!confirm(`Import ${n} grade(s)? This replaces the results currently entered here.${warn}`)) return;
      state = canonicaliseState(courses, parsed.state);
      await persist();
      syncControlsFromState();
      refreshAll();
    } catch (err) {
      alert(`Import failed: ${err.message}`);
    }
  });

  els.btnReset.addEventListener('click', async () => {
    const n = Object.keys(state.grades).length;
    if (n === 0) { alert('There are no results to reset.'); return; }
    if (!confirm(`Delete all ${n} entered grade(s)? This cannot be undone.`)) return;
    if (!confirm('Please confirm once more: erase every grade you have entered?')) return;
    state = clearAll(state);
    await repo.clear();
    syncControlsFromState();
    refreshAll();
    els.saveState.textContent = 'All results cleared';
  });
}

/**
 * Which courses must already be graded before a statement may be produced for a
 * later year.
 *
 * Electives are excluded: a student takes two of fourteen, so requiring all of
 * them would block everybody. The pre-CCMAS First Year is required in place of
 * the current one for a student who has graded any of it, since a student sat
 * one list or the other, never both.
 */
function requiredCoursesForYear(year, currentState, allCourses) {
  const usesCohort = year === 1 && allCourses.some(
    (c) => c.cohortId === 'pre-ccmas' && currentState?.grades?.[c.id],
  );
  return allCourses.filter((c) => {
    if (c.year !== year) return false;
    if (c.groupType === 'elective') return false;
    return usesCohort ? c.cohortId === 'pre-ccmas' : c.cohortId === null;
  });
}

function wireTranscript() {
  // The statement is an extra. If anything about it fails, the calculator
  // itself must still come up.
  try {
    wireTranscriptOrThrow();
  } catch (err) {
    const btn = document.getElementById('btn-pdf');
    if (btn) {
      btn.disabled = true;
      btn.title = `The PDF statement is unavailable: ${err.message}`;
    }
    console.error('Statement unavailable:', err);
  }
}

function wireTranscriptOrThrow() {
  initTranscript({
    getState: () => state,
    getCourses: () => courses,
    programmeYears: doc.years.length,
    // Five years to graduate, eight at most, so the year of study reaches 8/5.
    maxYearOfStudy: doc.progression?.maximum_years_to_graduate ?? 8,
    requiredCoursesForYear,
    prefs,
    institution: doc.institution,
    department: doc.department,
  });
}

function syncControlsFromState() {
  // refreshAll() rebuilds every stack from the state, so the controls only need
  // their stale values cleared first.
  for (const [, ref] of rowRefs) for (const sel of ref.selects) sel.value = '';
}

function applyFilter() {
  const q = els.filterText.value.trim().toLowerCase();
  const onlyEntered = els.filterEntered.checked;
  const showCohort = cohortVisible();
  for (const [id, ref] of rowRefs) {
    const c = ref.course;
    const hay = `${c.code} ${c.title ?? ''} ${c.legacyCode ?? ''}`.toLowerCase();
    const matches = (!q || hay.includes(q))
      && (!onlyEntered || Boolean(state.grades[id]))
      && (!c.cohortId || showCohort);

    ref.tr.classList.toggle('hidden', !matches);
  }
}

/* -------------------------------------------------------------- rendering */

/**
 * Whether the repeat-sitting controls are on show. The switch decides, but a
 * student who already has repeats recorded always sees them: hiding sittings
 * that are counting towards the GPA would make the figures unexplainable.
 */
function repeatsVisible() {
  return els.toggleRepeats.checked || anyRepeatsRecorded();
}

/**
 * Whether the alternative first-year list is on show. As with repeats, a
 * student who has already graded one of those courses always sees them: hiding
 * a course that is counting towards the GPA would make the figures
 * unexplainable.
 */
function cohortVisible() {
  return els.toggleCohort.checked || anyCohortGraded();
}

function anyCohortGraded() {
  for (const c of courses) {
    if (c.cohortId && state?.grades?.[c.id]) return true;
  }
  return false;
}

function applyCohortVisibility() {
  const show = cohortVisible();
  for (const el of document.querySelectorAll('[data-cohort]')) {
    if (el.tagName === 'TR') continue;          // rows are handled by the filter
    el.hidden = !show;
  }
}

function anyRepeatsRecorded() {
  const r = state?.repeats ?? {};
  return Object.keys(r).some((id) => Array.isArray(r[id]) && r[id].length > 0);
}

/** The reporting precision currently in force: the switch decides. */
function reportOpts() {
  return { decimals: els.togglePrecision.checked ? precision.full : precision.normal };
}

function refreshAll() {
  // Per-course rows.
  for (const [, ref] of rowRefs) {
    const ev = evaluateCourse(ref.course, state);

    // Units cell: an editable box only where the source document omitted units.
    if (ref.course.unitsUnknown) {
      if (!ref.unitInput) {
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.step = '1';
        input.className = 'units-input';
        input.placeholder = '?';
        input.title = 'The source document does not state this unit load. Enter it yourself to include this course.';
        input.setAttribute('aria-label', `Unit load for ${ref.course.code}`);
        input.addEventListener('change', () => onUnitOverride(ref.course.id, input.value));
        ref.tdUnits.textContent = '';
        ref.tdUnits.append(input);
        ref.unitInput = input;
      }
      const wanted = state.unitOverrides[ref.course.id];
      const str = Number.isFinite(wanted) ? String(wanted) : '';
      if (ref.unitInput.value !== str && document.activeElement !== ref.unitInput) ref.unitInput.value = str;
    }

    // How many grade controls this row needs: one per sitting so far, plus a
    // blank one to sit the course again — offered only while repeats are on
    // show, the last sitting was a failure, and the year's allowance has room.
    // A passed course is closed: it cannot be taken again.
    const wanted = repeatsVisible()
      ? Math.max(1, ev.attemptCount + (ev.canAddAttempt ? 1 : 0))
      : 1;
    syncSelects(ref, wanted);

    ref.selects.forEach((sel, i) => {
      const g = ev.attempts[i]?.grade ?? '';
      if (sel.value !== g && document.activeElement !== sel) sel.value = g;
      sel.classList.toggle('set', Boolean(g));
      sel.dataset.grade = g;
      sel.setAttribute('aria-label',
        wanted > 1 ? `${ref.course.code}, sitting ${i + 1} of up to ${ev.maxAttempts}`
                   : `Grade for ${ref.course.code}`);
      const wrap = sel.closest('.attempt');
      wrap.classList.toggle('numbered', wanted > 1);
      // The dashed "sit it again" styling belongs only to the trailing box of a
      // course being repeated. An ordinary ungraded course must look exactly as
      // it always has.
      wrap.classList.toggle('pending', !g && wanted > 1);
    });
    ref.stack.classList.toggle('multi', wanted > 1);
    ref.stack.title = ev.passed && ev.attemptCount > 1
      ? `Passed at sitting ${ev.attemptCount}. A passed course cannot be taken again.`
      : wanted > 1
        ? `Every sitting counts separately. This course allows up to ${ev.maxAttempts} sittings, ` +
          `and stops as soon as it is passed.`
        : '';

    // Units and points reflect every sitting.
    if (!ref.course.unitsUnknown) {
      ref.tdUnits.innerHTML = ev.attemptCount > 1
        ? `${ev.units}<span class="sub">${ev.baseUnits} × ${ev.attemptCount}</span>`
        : String(ref.course.units);
    }
    const gps = ev.attempts.map((a) => a.gradePoint);
    ref.tdGp.innerHTML = gps.length === 0 ? '<span class="dash">—</span>' : gps.join(' · ');
    ref.tdPt.innerHTML = ev.coursePoint === null ? '<span class="dash">—</span>' : String(ev.coursePoint);
    ref.tr.classList.toggle('active', ev.active);
    ref.tr.classList.toggle('blocked', ev.blocked);
    ref.tr.classList.toggle('repeated', ev.repeatCount > 0);
    ref.tr.classList.toggle('exhausted',
      !ev.passed && ev.attemptCount >= ev.maxAttempts && ev.attemptCount > 0);
  }

  // Semester strips.
  const sems = semesterSummaries(courses, state, reportOpts());
  for (const k of semesterKeys(doc)) {
    const key = `y${k.year}s${k.semester}`;
    const el = semRefs.get(key);
    const s = sems.get(key);
    if (!el) continue;
    el.innerHTML = !s || s.gradedCourses === 0
      ? '<span class="dash">no results entered</span>'
      : `${s.gradedCourses} graded · ${s.units} units · ${s.points} points · Semester GPA <b>${s.gpaText}</b>`;
  }

  // Year totals table.
  const years = yearSummaries(courses, state, reportOpts());
  els.yearTotals.innerHTML = '';
  for (const y of doc.years) {
    const s = years.get(`y${y.year}`);
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<th>${escapeHtml(y.label)}</th>` +
      `<td class="num">${s.gradedCourses}</td>` +
      `<td class="num">${s.units}</td>` +
      `<td class="num">${s.points}</td>` +
      `<td class="num">${s.gradedCourses ? s.gpaText : '<span class="dash">—</span>'}</td>`;
    els.yearTotals.append(tr);
  }

  // Cumulative.
  const total = summarise(courses, state, reportOpts());
  els.gpa.textContent = total.gpaText;
  els.klass.textContent = total.gradedCourses ? (total.classification ?? '') : 'no results entered yet';
  els.courses.textContent = String(total.gradedCourses);
  els.attemptsNote.textContent = total.repeats > 0
    ? `${total.attempts} sittings · ${total.repeats} repeat${total.repeats > 1 ? 's' : ''}`
    : '';
  els.units.textContent = String(total.units);
  els.points.textContent = String(total.points);
  els.cumCourses.textContent = String(total.gradedCourses);
  els.cumUnits.textContent = String(total.units);
  els.cumPoints.textContent = String(total.points);
  els.cumGpa.textContent = total.gpaText;

  if (total.blocked > 0) {
    els.versionNotice.hidden = false;
    els.versionNotice.innerHTML =
      `<strong>${total.blocked} graded course${total.blocked > 1 ? 's are' : ' is'} waiting for a unit load.</strong> ` +
      `The source document does not state the unit load for those courses, so they are highlighted and excluded ` +
      `from the GPA until you type the number of units into the Units box.`;
  } else if (els.versionNotice.dataset.sticky !== 'carryover') {
    els.versionNotice.hidden = true;
  }

  applyCohortVisibility();
  applyFilter();
  warnAboutDoubleListing();
}

/**
 * A handful of courses survived the CCMAS revision unchanged and so appear in
 * both lists. Grading one in both places counts it twice, which is almost
 * certainly a mistake — but it is the student's record, so this says so rather
 * than preventing it.
 */
function warnAboutDoubleListing() {
  const graded = new Map();
  for (const c of courses) {
    if (!state.grades?.[c.id]) continue;
    if (!graded.has(c.code)) graded.set(c.code, []);
    graded.get(c.code).push(c);
  }
  const doubled = [...graded.entries()]
    .filter(([, list]) => list.length > 1 && new Set(list.map((c) => c.cohortId)).size > 1)
    .map(([code]) => code);

  els.cohortNotice.hidden = doubled.length === 0;
  if (doubled.length > 0) {
    els.cohortNotice.innerHTML =
      `<strong>${doubled.map(escapeHtml).join(', ')} ${doubled.length > 1 ? 'are' : 'is'} graded ` +
      `in both the current and the pre-CCMAS first-year list.</strong> ` +
      `${doubled.length > 1 ? 'Those courses are' : 'That course is'} being counted twice. ` +
      `Keep the grade in whichever list you actually offered and clear the other.`;
  }
}

function publicSummary() {
  const t = summarise(courses, state, reportOpts());
  return {
    graded_courses: t.gradedCourses,
    units: t.units,
    quality_points: t.points,
    gpa: formatGpa(t.gpa, precision.normal),
    gpa_full_precision: formatGpa(t.gpa, precision.full),
  };
}

/**
 * One record per course the student has sat, listing every sitting in order.
 * `grades` and `repeats` remain the machine-readable source of truth; this is
 * the same information written out so that an export can be read and checked.
 */
function courseRecords() {
  const out = [];
  for (const course of courses) {
    const sittings = attemptsOf(course, state);
    if (sittings.length === 0) continue;
    const ev = evaluateCourse(course, state);
    out.push({
      course_id: course.id,
      code: course.code,
      year: course.year,
      semester: course.semester,
      units: ev.baseUnits,
      sittings,                       // e.g. ["F", "F", "B"], oldest first
      sittings_allowed: ev.maxAttempts,
      passed: ev.passed,
      units_counted: ev.units,        // units x number of sittings
      quality_points: ev.coursePoint,
    });
  }
  return out;
}

function offerCarryOver(others) {
  const best = others.find((o) => o.entries > 0);
  if (!best) return;
  els.versionNotice.hidden = false;
  els.versionNotice.dataset.sticky = 'carryover';
  els.versionNotice.innerHTML =
    `<strong>Results found under curriculum version ${escapeHtml(String(best.curriculum_version))}.</strong> ` +
    `This calculator is running curriculum version ${escapeHtml(doc.curriculum_version)}. ` +
    `Those results have been left exactly as they were. ` +
    `<button type="button" id="btn-carryover">Copy them into version ${escapeHtml(doc.curriculum_version)}</button>`;
  els.versionNotice.querySelector('#btn-carryover').addEventListener('click', async () => {
    const copied = await repo.adoptFrom(best.key);
    if (copied) {
      state = copied;
      delete els.versionNotice.dataset.sticky;
      els.versionNotice.hidden = true;
      syncControlsFromState();
      refreshAll();
    }
  });
}

function renderColophon() {
  const srcs = (doc.sources ?? []).map((s) => `<code>${escapeHtml(s.document)}</code>`).join(' and ');
  els.colophon.innerHTML =
    `Curriculum <code>${escapeHtml(doc.curriculum_id)}</code> version <code>${escapeHtml(doc.curriculum_version)}</code>, ` +
    `extracted from ${srcs}. Results are stored only in this browser; nothing is transmitted anywhere. ` +
    `Course data lives in <code>data/curriculum.json</code> and can be corrected without touching the GPA engine.`;
}

/* --------------------------------------------------------------- helpers */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function formatWhen(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

boot();
