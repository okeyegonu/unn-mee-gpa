/**
 * ui.js — presentation only.
 *
 * This module knows about the DOM. It does not know how a GPA is computed
 * (gpa-engine.js), what the grade scale is (grading.js), where results are kept
 * (storage.js), or what the courses are (data/curriculum.json).
 */

import { GRADES } from './grading.js';
import { flattenCurriculum, semesterKeys } from './curriculum.js';
import {
  emptyState, setGrade, setUnitOverride, clearAll,
  evaluateCourse, summarise, semesterSummaries, yearSummaries, formatGpa,
} from './gpa-engine.js';
import { ResultsRepository, PreferencesStore } from './storage.js';

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
  state = loaded.state ?? emptyState(doc.curriculum_version);

  if (!loaded.found && loaded.otherVersions.length > 0) offerCarryOver(loaded.otherVersions);

  els.meta.textContent =
    `${doc.programme_track} · curriculum version ${doc.curriculum_version} · ${courses.length} courses`;

  buildYearNav();
  buildTables();
  wireGlobalControls();
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

  for (const group of sem.groups) {
    const isElective = group.type === 'elective';
    if (isElective || sem.groups.length > 1) {
      const gh = document.createElement('div');
      gh.className = 'group-head' + (isElective ? ' elective' : '');
      gh.innerHTML = `<strong>${escapeHtml(group.label)}</strong>` +
        (isElective && group.choose
          ? ` — the programme says choose ${group.choose} course${group.choose > 1 ? 's' : ''}` +
            (group.choose_units ? ` (${group.choose_units} units)` : '') +
            `. Just enter grades for the electives you actually took; the calculator counts whatever you enter.`
          : '');
      wrap.append(gh);
    }

    const table = document.createElement('table');
    table.className = 'courses';
    table.innerHTML =
      '<thead><tr>' +
      '<th>Course</th><th class="col-title">Title</th>' +
      '<th class="num">Units</th><th>Grade</th>' +
      '<th class="num">Grade&nbsp;pt</th><th class="num">Course&nbsp;pt</th>' +
      '</tr></thead><tbody></tbody>';
    const tbody = table.tBodies[0];

    for (const c of group.courses) {
      tbody.append(buildRow(year, sem, c));
    }
    wrap.append(table);
  }
  return wrap;
}

function buildRow(year, sem, rawCourse) {
  const course = courses.find(
    (c) => c.year === year.year && c.semester === sem.semester && c.code === rawCourse.code,
  );
  const tr = document.createElement('tr');
  tr.dataset.id = course.id;

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
  const select = document.createElement('select');
  select.className = 'grade';
  select.setAttribute('aria-label', `Grade for ${course.code}`);
  select.append(new Option('—', ''));
  for (const g of GRADES) select.append(new Option(g, g));
  select.value = state.grades[course.id] ?? '';
  select.addEventListener('change', () => onGradeChange(course.id, select.value));
  tdGrade.append(select);

  const tdGp = document.createElement('td');
  tdGp.className = 'num cell-gp';
  tdGp.dataset.label = 'Grade pt';
  const tdPt = document.createElement('td');
  tdPt.className = 'num cell-pt';
  tdPt.dataset.label = 'Course pt';

  tr.append(tdCode, tdTitle, tdUnits, tdGrade, tdGp, tdPt);
  rowRefs.set(course.id, { tr, select, tdUnits, tdGp, tdPt, course });
  return tr;
}

/* ---------------------------------------------------------------- events */

async function onGradeChange(id, value) {
  state = setGrade(state, id, value);
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

  els.btnExport.addEventListener('click', async () => {
    const payload = await repo.exportPayload(state, {
      institution: doc.institution,
      programme: doc.programme,
      summary: publicSummary(),
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
      state = parsed.state;
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

function syncControlsFromState() {
  for (const [id, ref] of rowRefs) ref.select.value = state.grades[id] ?? '';
}

function applyFilter() {
  const q = els.filterText.value.trim().toLowerCase();
  const onlyEntered = els.filterEntered.checked;
  for (const [id, ref] of rowRefs) {
    const c = ref.course;
    const hay = `${c.code} ${c.title ?? ''} ${c.legacyCode ?? ''}`.toLowerCase();
    const matches = (!q || hay.includes(q)) && (!onlyEntered || Boolean(state.grades[id]));
    ref.tr.classList.toggle('hidden', !matches);
  }
}

/* -------------------------------------------------------------- rendering */

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
    } else {
      ref.tdUnits.textContent = String(ref.course.units);
    }

    ref.select.classList.toggle('set', ev.grade !== null);
    ref.select.dataset.grade = ev.grade ?? '';
    ref.tdGp.innerHTML = ev.gradePoint === null ? '<span class="dash">—</span>' : String(ev.gradePoint);
    ref.tdPt.innerHTML = ev.coursePoint === null ? '<span class="dash">—</span>' : String(ev.coursePoint);
    ref.tr.classList.toggle('active', ev.active);
    ref.tr.classList.toggle('blocked', ev.blocked);
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

  applyFilter();
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
