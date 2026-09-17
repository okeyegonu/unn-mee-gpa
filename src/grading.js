/**
 * grading.js — the grading rules, and nothing else.
 *
 * This module is deliberately free of curriculum knowledge, DOM knowledge and
 * storage knowledge. Changing the institution's grade scale should require a
 * change here only.
 */

/** Fixed UNN alphabetic grade -> grade point mapping. */
export const GRADE_POINTS = Object.freeze({
  A: 5,
  B: 4,
  C: 3,
  D: 2,
  E: 1,
  F: 0,
});

/** The ordered list of grades a student may choose. */
export const GRADES = Object.freeze(Object.keys(GRADE_POINTS));

/**
 * The sentinel meaning "no result entered yet".
 * NOTE: this is NOT the same thing as the grade "F".
 *   - NOT_ENTERED -> the course is dormant: 0 units, 0 points.
 *   - "F"         -> the course is active: 0 points, but its units COUNT.
 */
export const NOT_ENTERED = null;

/** Normalise user input to a canonical grade, or NOT_ENTERED. */
export function normaliseGrade(value) {
  if (value === undefined || value === null) return NOT_ENTERED;
  const g = String(value).trim().toUpperCase();
  if (g === '' || g === '-' || g === '—' || g === '--') return NOT_ENTERED;
  return Object.prototype.hasOwnProperty.call(GRADE_POINTS, g) ? g : NOT_ENTERED;
}

/** True only for a valid alphabetic grade A-F. */
export function isValidGrade(value) {
  if (typeof value !== 'string') return false;
  return Object.prototype.hasOwnProperty.call(GRADE_POINTS, value.toUpperCase());
}

/** Grade point for a grade; null when no valid grade is supplied. */
export function gradePoint(grade) {
  const g = normaliseGrade(grade);
  return g === NOT_ENTERED ? null : GRADE_POINTS[g];
}

/**
 * Quality point (course point) = course unit x grade point.
 * Returns null when the course is not active (no valid grade, or unknown units).
 */
export function coursePoint(units, grade) {
  const gp = gradePoint(grade);
  if (gp === null) return null;
  if (!Number.isFinite(units)) return null;
  return units * gp;
}

/**
 * The precomputed course/grade template of section 5: every possible outcome
 * for a course of the given unit load, including the inactive state.
 */
export function gradeMatrixForUnits(units) {
  const rows = [{ grade: NOT_ENTERED, label: '—', active: false, gradePoint: null, coursePoint: null }];
  for (const g of GRADES) {
    rows.push({
      grade: g,
      label: g,
      active: true,
      gradePoint: GRADE_POINTS[g],
      coursePoint: Number.isFinite(units) ? units * GRADE_POINTS[g] : null,
    });
  }
  return rows;
}

/** Build the template for every distinct unit load occurring in a curriculum. */
export function buildGradeTemplates(unitValues) {
  const table = {};
  for (const u of new Set(unitValues)) {
    if (Number.isFinite(u)) table[u] = gradeMatrixForUnits(u);
  }
  return table;
}

/** Classification commonly used alongside the 5-point scale. Display only. */
export function classOfDegree(gpa) {
  if (gpa === null || gpa === undefined) return null;
  if (gpa >= 4.5) return 'First Class';
  if (gpa >= 3.5) return 'Second Class (Upper Division)';
  if (gpa >= 2.4) return 'Second Class (Lower Division)';
  if (gpa >= 1.5) return 'Third Class';
  if (gpa >= 1.0) return 'Pass';
  return 'Fail';
}
