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
 * Per-course computed row. `active` is true only when a valid grade is present
 * AND the unit load is known.
 */
export function evaluateCourse(course, state) {
  const grade = normaliseGrade(state?.grades?.[course.id]);
  const units = effectiveUnits(course, state);
  const gp = grade === NOT_ENTERED ? null : gradePoint(grade);
  const unitsKnown = Number.isFinite(units);
  const active = grade !== NOT_ENTERED && unitsKnown;
  return {
    course,
    grade,
    units,
    unitsKnown,
    gradePoint: gp,
    coursePoint: active ? units * gp : null,
    active,
    // A grade was entered but we do not know the unit load: the student must
    // supply it before the course can join the calculation.
    blocked: grade !== NOT_ENTERED && !unitsKnown,
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
  let units = 0;
  let points = 0;
  let blocked = 0;
  for (const r of rows) {
    if (r.blocked) blocked++;
    if (!r.active) continue;
    gradedCourses++;
    units += r.units;
    points += r.coursePoint;
  }
  const gpa = units > 0 ? points / units : null;
  return {
    gradedCourses,
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
  return { curriculumVersion: curriculumVersion ?? null, grades: {}, unitOverrides: {} };
}

/**
 * UPSERT a grade. Returns a NEW state object; never mutates the input.
 * Setting the grade to NOT_ENTERED (null / '' / '—') removes the record
 * entirely, which returns the course to the dormant state.
 */
export function setGrade(state, id, value) {
  const grade = normaliseGrade(value);
  const grades = { ...state.grades };
  if (grade === NOT_ENTERED) delete grades[id];
  else grades[id] = grade; // same key -> overwrite, so no duplicate can arise
  return { ...state, grades };
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
  return { ...state, grades: {}, unitOverrides: {} };
}
