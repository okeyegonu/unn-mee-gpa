/**
 * gpa-engine.js — the GPA calculation engine. Pure functions, no DOM, no storage.
 *
 * The single computational rule:
 *
 *     ACTIVE COURSE = a valid alphabetic grade A-F has been entered
 *
 *     GPA = SUM(unit_i x gradePoint_i) over active courses
 *           ------------------------------------------------
 *           SUM(unit_i)                over active courses
 *
 * Year, semester, curriculum position and course ordering are NOT inputs to
 * this rule. They are only ever used to *partition* an already-computed set of
 * active courses for reporting.
 */

import { normaliseGrade, gradePoint, NOT_ENTERED, classOfDegree } from './grading.js';

/**
 * The unit load actually used for a course: the curriculum value, unless the
 * student has supplied one for a course whose unit load is missing from the
 * source document.
 */
export function effectiveUnits(course, state) {
  const override = state?.unitOverrides?.[course.id];
  if (Number.isFinite(override)) return override;
  return Number.isFinite(course.units) ? course.units : null;
}

/**
 * Was this sitting a failure, and therefore does it entitle the student to
 * another one? Which grades count as failures comes from the curriculum file
 * (`progression.failing_grades`) and is resolved onto the course.
 */
export function isFailingGrade(course, grade) {
  const g = normaliseGrade(grade);
  if (g === NOT_ENTERED) return false;
  const failing = course?.failingGrades ?? ['F'];
  return failing.includes(g);
}

/**
 * The canonical record of a course's sittings.
 *
 * Exactly one list of grades represents any given academic record, so that the
 * same history can never be stored two different ways. The rules, in order:
 *
 *   - a blank or invalid entry is not a sitting, so it is dropped;
 *   - the list stops at the year's allowance;
 *   - the list stops at the first pass, because a passed course is not re-sat.
 *
 * Every write goes through this, so the stored form is canonical by
 * construction and re-recording the same result — an F included — can never
 * append a second copy of it.
 */
export function canonicalSittings(course, grades) {
  const max = Math.max(1, course?.maxAttempts ?? 1);
  const out = [];
  for (const raw of grades ?? []) {
    const g = normaliseGrade(raw);
    if (g === NOT_ENTERED) continue;          // not a sitting
    out.push(g);
    if (out.length >= max) break;             // allowance spent
    if (!isFailingGrade(course, g)) break;    // passed: never sat again
  }
  return out;
}

/** Write a canonical sitting list back into the state, first sitting first. */
function writeSittings(state, course, list) {
  const canon = canonicalSittings(course, list);
  const grades = { ...state.grades };
  const repeats = { ...(state.repeats ?? {}) };
  if (canon.length === 0) {
    delete grades[course.id];
    delete repeats[course.id];
  } else {
    grades[course.id] = canon[0];
    if (canon.length > 1) repeats[course.id] = canon.slice(1);
    else delete repeats[course.id];
  }
  return { ...state, grades, repeats };
}

/**
 * Bring a whole state into canonical form.
 *
 * Applied to anything arriving from outside the engine — a record loaded from
 * storage, or an imported file — so that a hand-edited or older file is tidied
 * once rather than carried around. Entries for courses this curriculum does not
 * contain are left untouched rather than discarded, since they may belong to a
 * different curriculum version.
 */
export function canonicaliseState(courses, state) {
  const known = new Set(courses.map((c) => c.id));
  const grades = {};
  const repeats = {};
  for (const [id, g] of Object.entries(state?.grades ?? {})) {
    if (!known.has(id)) { grades[id] = g; if (state?.repeats?.[id]) repeats[id] = state.repeats[id]; }
  }
  for (const course of courses) {
    const raw = [state?.grades?.[course.id], ...(state?.repeats?.[course.id] ?? [])];
    const canon = canonicalSittings(course, raw);
    if (canon.length === 0) continue;
    grades[course.id] = canon[0];
    if (canon.length > 1) repeats[course.id] = canon.slice(1);
  }
  return { ...state, grades, repeats };
}

/**
 * Every sitting of a course, in order, as a list of valid grades.
 *
 * The first sitting lives in `state.grades` and any repeats in `state.repeats`.
 * Splitting them this way means a result saved before repeats existed still
 * loads, and an older copy of the interface reading the same record still finds
 * the first sitting where it expects it.
 *
 * A repeat is only meaningful after a first sitting, so if the first sitting is
 * blank the whole course is treated as not attempted.
 */
export function attemptsOf(course, state) {
  const first = state?.grades?.[course.id];
  if (normaliseGrade(first) === NOT_ENTERED) return [];
  const rest = Array.isArray(state?.repeats?.[course.id]) ? state.repeats[course.id] : [];
  return canonicalSittings(course, [first, ...rest]);
}

/**
 * Per-course computed row.
 *
 * A repeated course contributes once per sitting: its units enter the
 * denominator again and its points enter the numerator again. Repeating a
 * 3-unit course that was failed and then passed with a B therefore contributes
 * 6 units and 12 points, exactly as though it were two separate courses.
 *
 * `active` is true only when at least one valid grade is present AND the unit
 * load is known.
 */
export function evaluateCourse(course, state) {
  const grades = attemptsOf(course, state);
  const units = effectiveUnits(course, state);
  const unitsKnown = Number.isFinite(units);
  const maxAttempts = Math.max(1, course.maxAttempts ?? 1);

  const attempts = grades.map((g, i) => ({
    index: i,
    grade: g,
    gradePoint: gradePoint(g),
    coursePoint: unitsKnown ? units * gradePoint(g) : null,
  }));

  const active = attempts.length > 0 && unitsKnown;
  const first = attempts[0] ?? null;
  const last = attempts[attempts.length - 1] ?? null;
  const passed = Boolean(last) && !isFailingGrade(course, last.grade);

  return {
    course,
    // The first sitting, kept under the original names so that anything reading
    // a single-sitting row continues to work unchanged.
    grade: first ? first.grade : NOT_ENTERED,
    gradePoint: first ? first.gradePoint : null,

    attempts,
    attemptCount: attempts.length,
    repeatCount: Math.max(0, attempts.length - 1),
    maxAttempts,
    // Another sitting is allowed only where the last one was a failure and the
    // year's allowance has not been used up.
    canAddAttempt: attempts.length > 0 && attempts.length < maxAttempts && !passed,
    passed,

    baseUnits: units,
    // What this course actually contributes, summed over every sitting.
    units: active ? units * attempts.length : units,
    coursePoint: active ? attempts.reduce((a, x) => a + x.coursePoint, 0) : null,

    unitsKnown,
    active,
    // A grade was entered but we do not know the unit load: the student must
    // supply it before the course can join the calculation.
    blocked: attempts.length > 0 && !unitsKnown,
  };
}

/** Evaluate every course in curriculum order. */
export function evaluateAll(courses, state) {
  return courses.map((c) => evaluateCourse(c, state));
}

/**
 * How many decimal places a GPA is reported to. Two is the conventional
 * presentation and the default; the interface overrides it from
 * `reporting.gpa_decimal_places` in the curriculum file.
 *
 * Note that this is a *reporting* setting only. The GPA itself is always
 * computed at full double precision from integer points and integer units, so
 * raising this number reveals more of a figure that was already there — it does
 * not make the calculation more accurate.
 */
export const DEFAULT_GPA_DECIMALS = 2;

/** Clamp a requested precision to something a Number can actually express. */
function decimalsOrDefault(dp) {
  if (!Number.isFinite(dp)) return DEFAULT_GPA_DECIMALS;
  return Math.min(Math.max(Math.trunc(dp), 0), 15);
}

/** Round a GPA to the reporting precision. */
export function roundGpa(value, dp = DEFAULT_GPA_DECIMALS) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const places = decimalsOrDefault(dp);
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/** Format a GPA for display; an empty set of active courses has no GPA. */
export function formatGpa(value, dp = DEFAULT_GPA_DECIMALS) {
  const places = decimalsOrDefault(dp);
  const r = roundGpa(value, places);
  return r === null ? '—' : r.toFixed(places);
}

/**
 * Summarise a set of evaluated rows.
 * Only `active` rows contribute anything at all: an unentered course adds
 * 0 units to the denominator and 0 points to the numerator.
 */
export function summariseRows(rows, { decimals = DEFAULT_GPA_DECIMALS } = {}) {
  let gradedCourses = 0;
  let attempts = 0;
  let repeats = 0;
  let repeatedCourses = 0;
  let units = 0;
  let points = 0;
  let blocked = 0;
  for (const r of rows) {
    if (r.blocked) blocked++;
    if (!r.active) continue;
    gradedCourses++;
    attempts += r.attemptCount;
    repeats += r.repeatCount;
    if (r.repeatCount > 0) repeatedCourses++;
    units += r.units;
    points += r.coursePoint;
  }
  const gpa = units > 0 ? points / units : null;
  return {
    gradedCourses,
    // Every sitting counts separately, so these can exceed gradedCourses.
    attempts,
    repeats,
    repeatedCourses,
    units,
    points,
    gpa,
    gpaRounded: roundGpa(gpa, decimals),
    gpaText: formatGpa(gpa, decimals),
    // Classification always uses the conventional 2 d.p. figure, so that a
    // reporting-precision change can never move a student between classes.
    classification: classOfDegree(roundGpa(gpa, DEFAULT_GPA_DECIMALS)),
    blocked,
  };
}

/** Cumulative summary over every course for which a grade has been entered. */
export function summarise(courses, state, options) {
  return summariseRows(evaluateAll(courses, state), options);
}

/**
 * Partition an evaluation into buckets and summarise each bucket.
 * Used purely for reporting: semester GPA, year GPA, and so on. The bucket key
 * has no influence on whether a course is active.
 */
export function summariseBy(courses, state, keyFn, options) {
  const rows = evaluateAll(courses, state);
  const buckets = new Map();
  for (const r of rows) {
    const key = keyFn(r.course);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(r);
  }
  const out = new Map();
  for (const [key, list] of buckets) out.set(key, summariseRows(list, options));
  return out;
}

/** Convenience: GPA per semester, keyed "y<year>s<semester>". */
export function semesterSummaries(courses, state, options) {
  return summariseBy(courses, state, (c) => `y${c.year}s${c.semester}`, options);
}

/** Convenience: GPA per academic year, keyed "y<year>". */
export function yearSummaries(courses, state, options) {
  return summariseBy(courses, state, (c) => `y${c.year}`, options);
}

/** An empty, valid state object. */
export function emptyState(curriculumVersion) {
  return { curriculumVersion: curriculumVersion ?? null, grades: {}, repeats: {}, unitOverrides: {} };
}

/**
 * UPSERT a grade. Returns a NEW state object; never mutates the input.
 * Setting the grade to NOT_ENTERED (null / '' / '—') removes the record
 * entirely, which returns the course to the dormant state.
 */
export function setGrade(state, id, value, course = null) {
  const grade = normaliseGrade(value);
  const grades = { ...state.grades };
  const repeats = { ...(state.repeats ?? {}) };
  // Correcting the first sitting to a pass removes any repeats recorded after
  // it: a course that was passed first time was never sat again.
  if (course && grade !== NOT_ENTERED && !isFailingGrade(course, grade)) delete repeats[id];
  if (grade === NOT_ENTERED) {
    // Clearing the first sitting clears the course: a repeat of a course that
    // was never sat is meaningless.
    delete grades[id];
    delete repeats[id];
  } else {
    grades[id] = grade; // same key -> overwrite, so no duplicate can arise
  }
  return { ...state, grades, repeats };
}

/**
 * UPSERT one sitting of a course. Index 0 is the first sitting; 1 and above are
 * repeats. Setting a repeat to NOT_ENTERED removes that sitting and closes the
 * gap, so the remaining sittings stay contiguous.
 */
export function setAttempt(state, course, index, value) {
  const id = typeof course === 'string' ? course : course.id;
  if (typeof course === 'string' || index === 0) {
    if (index === 0) return setGrade(state, id, value, typeof course === 'string' ? null : course);
    return state;
  }

  const current = attemptsOf(course, state);
  const grade = normaliseGrade(value);
  const next = [...current];

  if (index < next.length) {
    if (grade === NOT_ENTERED) next.splice(index, 1);   // remove, closing the gap
    else next[index] = grade;
  } else if (grade !== NOT_ENTERED) {
    next.push(grade);                                    // one more sitting
  } else {
    return state;                                        // blank into a blank slot
  }

  return writeSittings(state, course, next);
}

/** Append one more sitting, if the course's allowance has room for it. */
export function addAttempt(state, course, value) {
  const grade = normaliseGrade(value);
  if (grade === NOT_ENTERED) return state;               // a blank is not a sitting
  const current = attemptsOf(course, state);
  if (current.length === 0) return state;                // nothing sat yet
  if (!evaluateCourse(course, state).canAddAttempt) return state;   // passed, or allowance spent
  return writeSittings(state, course, [...current, grade]);
}

/** Drop every repeat of a course, keeping the first sitting. */
export function clearRepeats(state, id) {
  const repeats = { ...(state.repeats ?? {}) };
  delete repeats[id];
  return { ...state, repeats };
}

/** UPSERT a student-supplied unit load for a course whose units are unknown. */
export function setUnitOverride(state, id, value) {
  const overrides = { ...state.unitOverrides };
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? '').trim(), 10);
  if (!Number.isFinite(n) || n <= 0) delete overrides[id];
  else overrides[id] = n;
  return { ...state, unitOverrides: overrides };
}

/** Remove every entered result. */
export function clearAll(state) {
  return { ...state, grades: {}, repeats: {}, unitOverrides: {} };
}
