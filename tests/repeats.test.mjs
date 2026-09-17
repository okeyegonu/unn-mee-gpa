/**
 * Repeat attempts.
 *
 * Mechanical Engineering takes a minimum of five years and a maximum of eight.
 * A student who fails a course sits it again, and every sitting counts:
 *
 *     numerator   += units x gradePoint   for each sitting
 *     denominator += units                for each sitting
 *
 * So a failed sitting puts its units into the denominator while adding nothing
 * to the numerator, and doing that repeatedly degrades the GPA further each
 * time. It behaves exactly as though another course had been added.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  emptyState, setGrade, setAttempt, addAttempt, clearRepeats,
  evaluateCourse, attemptsOf, summarise,
} from '../src/gpa-engine.js';
import { flattenCurriculum, maxAttemptsForYear, indexCourses } from '../src/curriculum.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const doc = JSON.parse(await readFile(resolve(root, 'data/curriculum.json'), 'utf8'));
const courses = flattenCurriculum(doc);
const byId = indexCourses(courses);

/** A synthetic course with a generous allowance, for the arithmetic tests. */
const C = (id, units, maxAttempts = 8) =>
  ({ id, code: id, title: id, units, year: 1, semester: 1, maxAttempts });

/* ---------------------------------------------------------- the allowance */

test('a course allows (8 - year) repeats, so (9 - year) sittings', () => {
  assert.equal(doc.progression.maximum_years_to_graduate, 8);
  const expected = { 1: 8, 2: 7, 3: 6, 4: 5, 5: 4 };
  for (const [year, sittings] of Object.entries(expected)) {
    assert.equal(maxAttemptsForYear(Number(year), doc.progression), sittings, `year ${year}`);
  }
  // 7 repeats for a First Year course, 3 for a Fifth Year course.
  assert.equal(maxAttemptsForYear(1, doc.progression) - 1, 7);
  assert.equal(maxAttemptsForYear(5, doc.progression) - 1, 3);
});

test('every real course carries the allowance for its year', () => {
  assert.equal(byId.get('y1s1-MTH101').maxAttempts, 8);
  assert.equal(byId.get('y2s1-MEE211').maxAttempts, 7);
  assert.equal(byId.get('y3s1-MEE313').maxAttempts, 6);
  assert.equal(byId.get('y4s1-MEE443').maxAttempts, 5);
  assert.equal(byId.get('y5s2-MEE592').maxAttempts, 4);
});

/* ------------------------------------------------------- the core arithmetic */

test('a course failed once then passed counts BOTH sittings', () => {
  const c = C('c1', 3);
  let s = setGrade(emptyState(), 'c1', 'F');     // 3 x 0 =  0, 3 units
  s = setAttempt(s, c, 1, 'B');                  // 3 x 4 = 12, 3 units
  const ev = evaluateCourse(c, s);
  assert.equal(ev.attemptCount, 2);
  assert.equal(ev.repeatCount, 1);
  assert.equal(ev.units, 6, 'the units appear twice in the denominator');
  assert.equal(ev.coursePoint, 12, 'only the passing sitting adds points');

  const r = summarise([c], s);
  assert.equal(r.units, 6);
  assert.equal(r.points, 12);
  assert.equal(r.gpaText, '2.00', 'a B earned on the second attempt is worth 2.00, not 4.00');
});

test('each further failure degrades the GPA again', () => {
  const c = C('c1', 3);
  const gpaAfter = (...grades) => {
    let s = setGrade(emptyState(), 'c1', grades[0]);
    grades.slice(1).forEach((g, i) => { s = setAttempt(s, c, i + 1, g); });
    return summarise([c], s);
  };

  const once  = gpaAfter('A');              // 15 / 3
  const twice = gpaAfter('F', 'A');         // 15 / 6
  const third = gpaAfter('F', 'F', 'A');    // 15 / 9
  const forth = gpaAfter('F', 'F', 'F', 'A');

  assert.equal(once.gpaText,  '5.00');
  assert.equal(twice.gpaText, '2.50');
  assert.equal(third.gpaText, '1.67');
  assert.equal(forth.gpaText, '1.25');

  assert.ok(once.gpa > twice.gpa && twice.gpa > third.gpa && third.gpa > forth.gpa,
    'every extra sitting must lower the GPA');
  assert.deepEqual([once.units, twice.units, third.units, forth.units], [3, 6, 9, 12]);
  assert.deepEqual([once.points, twice.points, third.points, forth.points], [15, 15, 15, 15]);
});

test('a course failed every time contributes units and no points at all', () => {
  const c = C('c1', 2);
  let s = setGrade(emptyState(), 'c1', 'F');
  for (let i = 1; i < 5; i++) s = setAttempt(s, c, i, 'F');
  const r = summarise([c], s);
  assert.equal(r.attempts, 5);
  assert.equal(r.units, 10, '5 sittings x 2 units');
  assert.equal(r.points, 0);
  assert.equal(r.gpaText, '0.00');
});

test('a repeat behaves exactly like an extra course of the same size', () => {
  // One 3-unit course sat twice (F then B) ...
  const repeated = C('c1', 3);
  let a = setGrade(emptyState(), 'c1', 'F');
  a = setAttempt(a, repeated, 1, 'B');

  // ... against two distinct 3-unit courses graded F and B.
  const twoCourses = [C('x', 3), C('y', 3)];
  let b = setGrade(emptyState(), 'x', 'F');
  b = setGrade(b, 'y', 'B');

  const ra = summarise([repeated], a);
  const rb = summarise(twoCourses, b);
  assert.equal(ra.units, rb.units);
  assert.equal(ra.points, rb.points);
  assert.equal(ra.gpaText, rb.gpaText);
});

test('repeats mix correctly with untouched courses', () => {
  const c1 = C('c1', 2), c2 = C('c2', 3), c3 = C('c3', 4);
  let s = setGrade(emptyState(), 'c1', 'A');   // 2 x 5 = 10, 2 units
  s = setGrade(s, 'c2', 'F');                  // 3 x 0 =  0, 3 units
  s = setAttempt(s, c2, 1, 'C');               // 3 x 3 =  9, 3 units
  // c3 never sat: contributes nothing
  const r = summarise([c1, c2, c3], s);
  assert.equal(r.gradedCourses, 2);
  assert.equal(r.attempts, 3);
  assert.equal(r.repeats, 1);
  assert.equal(r.repeatedCourses, 1);
  assert.equal(r.units, 8);
  assert.equal(r.points, 19);
  assert.equal(r.gpaText, '2.38');
});

/* ----------------------------------------------------------- the boundaries */

test('the allowance is enforced: a Fifth Year course stops at 4 sittings', () => {
  const c = byId.get('y5s1-MEE511');            // 3 units, 4 sittings
  let s = setGrade(emptyState(), c.id, 'F');
  for (let i = 1; i < 10; i++) s = setAttempt(s, c, i, 'F');
  const ev = evaluateCourse(c, s);
  assert.equal(ev.attemptCount, 4, 'never more than the allowance');
  assert.equal(ev.canAddAttempt, false);
  assert.equal(summarise([c], s).units, 12, '4 x 3 units');
});

test('the allowance is enforced: a First Year course stops at 8 sittings', () => {
  const c = byId.get('y1s1-MTH101');            // 2 units, 8 sittings
  let s = setGrade(emptyState(), c.id, 'F');
  for (let i = 1; i < 20; i++) s = setAttempt(s, c, i, 'F');
  assert.equal(evaluateCourse(c, s).attemptCount, 8);
  assert.equal(summarise([c], s).units, 16);
});

test('addAttempt respects the allowance and needs a first sitting', () => {
  const c = byId.get('y5s1-MEE511');
  assert.deepEqual(addAttempt(emptyState(), c, 'B').repeats, {},
    'a repeat of a course never sat is refused');
  let s = setGrade(emptyState(), c.id, 'F');
  for (let i = 0; i < 10; i++) s = addAttempt(s, c, 'F');
  assert.equal(evaluateCourse(c, s).attemptCount, 4);
});

/* -------------------------------------------------- corrections and removal */

test('a repeat can be corrected in place without adding another sitting', () => {
  const c = C('c1', 3);
  let s = setGrade(emptyState(), 'c1', 'F');
  s = setAttempt(s, c, 1, 'D');
  assert.equal(summarise([c], s).points, 6);
  s = setAttempt(s, c, 1, 'B');                 // correct the resit result
  assert.equal(evaluateCourse(c, s).attemptCount, 2, 'still two sittings');
  assert.equal(summarise([c], s).points, 12);
  assert.equal(summarise([c], s).units, 6);
});

test('clearing a repeat closes the gap and leaves the rest contiguous', () => {
  const c = C('c1', 3);
  let s = setGrade(emptyState(), 'c1', 'F');
  s = setAttempt(s, c, 1, 'F');
  s = setAttempt(s, c, 2, 'C');
  assert.deepEqual(attemptsOf(c, s), ['F', 'F', 'C']);
  s = setAttempt(s, c, 1, '');                  // remove the middle sitting
  assert.deepEqual(attemptsOf(c, s), ['F', 'C']);
  assert.equal(summarise([c], s).units, 6);
  assert.equal(summarise([c], s).points, 9);
});

test('clearing the first sitting clears the whole course, repeats included', () => {
  const c = C('c1', 3);
  let s = setGrade(emptyState(), 'c1', 'F');
  s = setAttempt(s, c, 1, 'B');
  s = setGrade(s, 'c1', '');
  assert.deepEqual(attemptsOf(c, s), []);
  assert.deepEqual(s.repeats, {}, 'no orphan repeats are left behind');
  assert.equal(summarise([c], s).units, 0);
  assert.equal(summarise([c], s).gpaText, '—');
});

test('clearRepeats keeps the first sitting', () => {
  const c = C('c1', 3);
  let s = setGrade(emptyState(), 'c1', 'F');
  s = setAttempt(s, c, 1, 'B');
  s = clearRepeats(s, 'c1');
  assert.deepEqual(attemptsOf(c, s), ['F']);
  assert.equal(summarise([c], s).units, 3);
});

test('a repeat with no first sitting is ignored rather than counted', () => {
  const c = C('c1', 3);
  const s = { ...emptyState(), repeats: { c1: ['A', 'B'] } };   // malformed
  assert.deepEqual(attemptsOf(c, s), []);
  assert.equal(summarise([c], s).units, 0);
});

test('invalid and blank repeat entries are skipped, not counted as sittings', () => {
  const c = C('c1', 3);
  const s = { ...emptyState(), grades: { c1: 'F' }, repeats: { c1: ['', 'Z', 'B', null] } };
  assert.deepEqual(attemptsOf(c, s), ['F', 'B']);
  assert.equal(summarise([c], s).units, 6);
  assert.equal(summarise([c], s).points, 12);
});

test('state transitions over repeats never mutate the previous state', () => {
  const c = C('c1', 3);
  const s0 = setGrade(emptyState(), 'c1', 'F');
  const snapshot = JSON.stringify(s0);
  const s1 = setAttempt(s0, c, 1, 'B');
  assert.equal(JSON.stringify(s0), snapshot);
  assert.equal(evaluateCourse(c, s0).attemptCount, 1);
  assert.equal(evaluateCourse(c, s1).attemptCount, 2);
});

/* ----------------------------------------------- a worked eight-year example */

test('worked example: a student who repeats across the full eight years', () => {
  const mth = byId.get('y1s1-MTH101');   // 2 units, Year 1
  const mee = byId.get('y3s1-MEE313');   // 3 units, Year 3
  const egr = byId.get('y3s2-EGR302');   // 4 units, Year 3

  let s = emptyState(doc.curriculum_version);
  s = setGrade(s, mth.id, 'F');          // 2 x 0 = 0   |  2 units
  s = setAttempt(s, mth, 1, 'F');        // 2 x 0 = 0   |  2 units
  s = setAttempt(s, mth, 2, 'C');        // 2 x 3 = 6   |  2 units
  s = setGrade(s, mee.id, 'F');          // 3 x 0 = 0   |  3 units
  s = setAttempt(s, mee, 1, 'B');        // 3 x 4 = 12  |  3 units
  s = setGrade(s, egr.id, 'A');          // 4 x 5 = 20  |  4 units

  const r = summarise(courses, s);
  assert.equal(r.gradedCourses, 3, 'three distinct courses');
  assert.equal(r.attempts, 6, 'six sittings between them');
  assert.equal(r.repeats, 3);
  assert.equal(r.repeatedCourses, 2);
  assert.equal(r.points, 38);
  assert.equal(r.units, 16);
  assert.equal(r.gpaText, '2.38');

  // Had every course been passed first time at the same final grade:
  let clean = emptyState(doc.curriculum_version);
  clean = setGrade(clean, mth.id, 'C');
  clean = setGrade(clean, mee.id, 'B');
  clean = setGrade(clean, egr.id, 'A');
  const rc = summarise(courses, clean);
  assert.equal(rc.units, 9);
  assert.equal(rc.points, 38);
  assert.equal(rc.gpaText, '4.22');
  assert.ok(r.gpa < rc.gpa, 'the repeats cost this student 1.84 points of GPA');
});
