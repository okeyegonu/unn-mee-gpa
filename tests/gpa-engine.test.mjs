/**
 * Calculation tests — section 13 of the specification, plus the properties the
 * rest of the specification depends on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyState, setGrade, setUnitOverride, clearAll,
  summarise, evaluateCourse, semesterSummaries, yearSummaries, formatGpa, roundGpa,
} from '../src/gpa-engine.js';
import { GRADE_POINTS, coursePoint, gradeMatrixForUnits, isValidGrade, normaliseGrade } from '../src/grading.js';

/** Minimal course records; the engine only needs id + units (+ year/semester for grouping). */
const C = (id, units, year = 1, semester = 1) => ({ id, code: id, title: id, units, year, semester, unitsUnknown: !Number.isFinite(units) });

const c1 = C('c1', 2);
const c2 = C('c2', 3);

test('Test 1 — a single 2-unit course graded A', () => {
  let s = emptyState('test');
  s = setGrade(s, 'c1', 'A');
  const r = summarise([c1, c2], s);
  assert.equal(r.points, 10, 'quality points');
  assert.equal(r.units, 2, 'activated units');
  assert.equal(r.gradedCourses, 1);
  assert.equal(r.gpaText, '5.00');
});

test('Test 2 — 2-unit A plus 3-unit B', () => {
  let s = emptyState('test');
  s = setGrade(s, 'c1', 'A');
  s = setGrade(s, 'c2', 'B');
  const r = summarise([c1, c2], s);
  assert.equal(r.points, 22);
  assert.equal(r.units, 5);
  assert.equal(r.gradedCourses, 2);
  assert.equal(r.gpaText, '4.40');
});

test('Test 3 — an unentered course contributes nothing at all', () => {
  let s = emptyState('test');
  s = setGrade(s, 'c1', 'A');           // c2 deliberately left unentered
  const r = summarise([c1, c2], s);
  assert.equal(r.points, 10);
  assert.equal(r.units, 2, 'the unentered 3-unit course must NOT enter the denominator');
  assert.equal(r.gradedCourses, 1);
  assert.equal(r.gpaText, '5.00');
});

test('Test 4 — F is active and keeps its units in the denominator', () => {
  let s = emptyState('test');
  s = setGrade(s, 'c1', 'A');
  s = setGrade(s, 'c2', 'F');
  const r = summarise([c1, c2], s);
  assert.equal(r.points, 10);
  assert.equal(r.units, 5, 'the failed 3-unit course MUST contribute its 3 units');
  assert.equal(r.gradedCourses, 2);
  assert.equal(r.gpaText, '2.00');
});

test('Test 4b — F and "not entered" are genuinely different states', () => {
  const failed = summarise([c1, c2], setGrade(setGrade(emptyState(), 'c1', 'A'), 'c2', 'F'));
  const blank = summarise([c1, c2], setGrade(emptyState(), 'c1', 'A'));
  assert.equal(failed.points, blank.points, 'both score 0 points for c2');
  assert.notEqual(failed.units, blank.units, 'but only the F contributes units');
  assert.notEqual(failed.gpaText, blank.gpaText);
});

test('Test 5 — correcting a grade replaces it; exactly one record survives', () => {
  let s = emptyState('test');
  s = setGrade(s, 'c1', 'B');
  assert.equal(summarise([c1], s).gpaText, '4.00');

  s = setGrade(s, 'c1', 'A');
  assert.equal(Object.keys(s.grades).length, 1, 'exactly one stored result for the course');
  assert.deepEqual(Object.keys(s.grades), ['c1']);
  const r = summarise([c1], s);
  assert.equal(r.gradedCourses, 1);
  assert.equal(r.points, 10);
  assert.equal(r.units, 2);
  assert.equal(r.gpaText, '5.00');
});

test('Test 6 — returning a grade to the dash removes it from the calculation', () => {
  let s = emptyState('test');
  s = setGrade(s, 'c1', 'A');
  s = setGrade(s, 'c2', 'B');
  assert.equal(summarise([c1, c2], s).gpaText, '4.40');

  s = setGrade(s, 'c2', '');            // back to "—"
  assert.equal(Object.keys(s.grades).length, 1);
  const r = summarise([c1, c2], s);
  assert.equal(r.gradedCourses, 1);
  assert.equal(r.units, 2);
  assert.equal(r.points, 10);
  assert.equal(r.gpaText, '5.00');
});

test('the em-dash, the hyphen, null and whitespace all mean "not entered"', () => {
  for (const blank of ['', ' ', '-', '—', null, undefined]) {
    const s = setGrade(setGrade(emptyState(), 'c1', 'A'), 'c1', blank);
    assert.equal(Object.keys(s.grades).length, 0, `"${String(blank)}" should clear the grade`);
  }
});

test('an invalid grade never enters the calculation', () => {
  for (const bad of ['G', 'Z', '5', 'AA', 'pass']) {
    assert.equal(isValidGrade(bad), false);
    const s = setGrade(emptyState(), 'c1', bad);
    assert.equal(Object.keys(s.grades).length, 0);
    assert.equal(summarise([c1], s).gradedCourses, 0);
  }
});

test('lower-case input is accepted and normalised', () => {
  assert.equal(normaliseGrade('a'), 'A');
  const s = setGrade(emptyState(), 'c1', 'b');
  assert.equal(s.grades.c1, 'B');
  assert.equal(summarise([c1], s).gpaText, '4.00');
});

test('no results at all yields no GPA rather than a division by zero', () => {
  const r = summarise([c1, c2], emptyState());
  assert.equal(r.units, 0);
  assert.equal(r.points, 0);
  assert.equal(r.gpa, null);
  assert.equal(r.gpaText, '—');
});

test('an all-F student has a GPA of 0.00, not "no GPA"', () => {
  let s = setGrade(emptyState(), 'c1', 'F');
  s = setGrade(s, 'c2', 'F');
  const r = summarise([c1, c2], s);
  assert.equal(r.units, 5);
  assert.equal(r.points, 0);
  assert.equal(r.gpaText, '0.00');
});

test('the grade scale is exactly A=5 .. F=0', () => {
  assert.deepEqual(GRADE_POINTS, { A: 5, B: 4, C: 3, D: 2, E: 1, F: 0 });
});

test('course point = unit x grade point, for every unit load in play', () => {
  for (const units of [1, 2, 3, 4, 6, 10]) {
    for (const [g, gp] of Object.entries(GRADE_POINTS)) {
      assert.equal(coursePoint(units, g), units * gp, `${units} units, grade ${g}`);
    }
    assert.equal(coursePoint(units, null), null, 'unentered is inactive');
  }
});

test('the precomputed template for a 2-unit course matches the specification', () => {
  const m = gradeMatrixForUnits(2);
  assert.equal(m.length, 7);
  assert.deepEqual(m[0], { grade: null, label: '—', active: false, gradePoint: null, coursePoint: null });
  assert.deepEqual(m.slice(1).map((r) => [r.grade, r.coursePoint]),
    [['A', 10], ['B', 8], ['C', 6], ['D', 4], ['E', 2], ['F', 0]]);
});

test('the precomputed template for a 3-unit course matches the specification', () => {
  const m = gradeMatrixForUnits(3);
  assert.deepEqual(m.slice(1).map((r) => [r.grade, r.coursePoint]),
    [['A', 15], ['B', 12], ['C', 9], ['D', 6], ['E', 3], ['F', 0]]);
});

/* ---- semester / year independence (section 6) ---- */

const across = [
  C('y1s1-A', 2, 1, 1),
  C('y2s2-B', 3, 2, 2),
  C('y4s1-C', 4, 4, 1),
  C('y5s2-D', 6, 5, 2),   // left unentered
];

test('grades from unrelated years and semesters combine without objection', () => {
  let s = emptyState();
  s = setGrade(s, 'y1s1-A', 'A');   // 2 x 5 = 10
  s = setGrade(s, 'y2s2-B', 'B');   // 3 x 4 = 12
  s = setGrade(s, 'y4s1-C', 'C');   // 4 x 3 = 12
  const r = summarise(across, s);
  assert.equal(r.gradedCourses, 3);
  assert.equal(r.units, 9);
  assert.equal(r.points, 34);
  assert.equal(r.gpaText, formatGpa(34 / 9));
  assert.equal(r.gpaText, '3.78');
});

test('the order in which grades arrive never changes the result', () => {
  const entries = [['y1s1-A', 'A'], ['y2s2-B', 'B'], ['y4s1-C', 'C']];
  const forward = entries.reduce((s, [id, g]) => setGrade(s, id, g), emptyState());
  const backward = [...entries].reverse().reduce((s, [id, g]) => setGrade(s, id, g), emptyState());
  assert.deepEqual(summarise(across, forward), summarise(across, backward));
});

test('semester and year summaries partition the same active set', () => {
  let s = emptyState();
  s = setGrade(s, 'y1s1-A', 'A');
  s = setGrade(s, 'y2s2-B', 'B');
  s = setGrade(s, 'y4s1-C', 'C');

  const sems = semesterSummaries(across, s);
  assert.equal(sems.get('y1s1').gpaText, '5.00');
  assert.equal(sems.get('y2s2').gpaText, '4.00');
  assert.equal(sems.get('y4s1').gpaText, '3.00');
  assert.equal(sems.get('y5s2').gradedCourses, 0);
  assert.equal(sems.get('y5s2').gpaText, '—');

  const years = yearSummaries(across, s);
  const totalUnits = [...years.values()].reduce((a, v) => a + v.units, 0);
  const totalPoints = [...years.values()].reduce((a, v) => a + v.points, 0);
  assert.equal(totalUnits, summarise(across, s).units);
  assert.equal(totalPoints, summarise(across, s).points);
});

test('a future / unreleased course is never counted', () => {
  const s = setGrade(emptyState(), 'y1s1-A', 'A');
  const r = summarise(across, s);
  assert.equal(r.units, 2, 'only the one entered course counts');
  assert.equal(yearSummaries(across, s).get('y5').gradedCourses, 0);
});

/* ---- courses whose unit load is missing from the source document ---- */

const unknownUnits = { id: 'u1', code: 'PHY 104', title: null, units: null, unitsUnknown: true, year: 1, semester: 2 };

test('a graded course with no known unit load is held back, not silently counted', () => {
  const s = setGrade(emptyState(), 'u1', 'A');
  const ev = evaluateCourse(unknownUnits, s);
  assert.equal(ev.active, false);
  assert.equal(ev.blocked, true);
  const r = summarise([c1, unknownUnits], setGrade(s, 'c1', 'A'));
  assert.equal(r.units, 2);
  assert.equal(r.points, 10);
  assert.equal(r.blocked, 1);
});

test('supplying the missing unit load activates the course', () => {
  let s = setGrade(emptyState(), 'u1', 'A');
  s = setUnitOverride(s, 'u1', 2);
  const r = summarise([unknownUnits], s);
  assert.equal(r.units, 2);
  assert.equal(r.points, 10);
  assert.equal(r.blocked, 0);
  assert.equal(r.gpaText, '5.00');
});

/* ---- purity and rounding ---- */

test('state transitions never mutate the previous state', () => {
  const s0 = setGrade(emptyState(), 'c1', 'A');
  const snapshot = JSON.stringify(s0);
  const s1 = setGrade(s0, 'c2', 'B');
  const s2 = clearAll(s1);
  assert.equal(JSON.stringify(s0), snapshot, 's0 must be untouched');
  assert.equal(Object.keys(s1.grades).length, 2);
  assert.equal(Object.keys(s2.grades).length, 0);
});

test('GPA is reported to two decimal places, rounded half up', () => {
  assert.equal(roundGpa(4.4), 4.4);
  assert.equal(formatGpa(4.4), '4.40');
  assert.equal(formatGpa(22 / 5), '4.40');
  assert.equal(formatGpa(34 / 9), '3.78');
  assert.equal(formatGpa(1 / 3), '0.33');
  assert.equal(formatGpa(3.005), '3.01');
  assert.equal(formatGpa(null), '—');
});
