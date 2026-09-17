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
  evaluateCourse, attemptsOf, summarise, canonicaliseState, canonicalSittings,
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

/* --------------------------------------------------------------------------
   A passed course cannot be taken again.

   At UNN a course is repeated only on failure. A sequence of sittings therefore
   always ends at the first pass, and the allowance simply caps how many
   failures a student can sit through.
   -------------------------------------------------------------------------- */

/** F is the only failing grade unless the curriculum file says otherwise. */
const P = (id, units, maxAttempts = 8, failingGrades = ['F']) =>
  ({ id, code: id, title: id, units, year: 1, semester: 1, maxAttempts, failingGrades });

test('only F is treated as a failure, by configuration', () => {
  assert.deepEqual(doc.progression.failing_grades, ['F']);
  assert.deepEqual(byId.get('y1s1-MTH101').failingGrades, ['F']);
});

test('a course passed first time offers no further sitting', () => {
  for (const pass of ['A', 'B', 'C', 'D', 'E']) {
    const c = P('c1', 3);
    const s = setGrade(emptyState(), 'c1', pass);
    const ev = evaluateCourse(c, s);
    assert.equal(ev.passed, true, `${pass} is a pass`);
    assert.equal(ev.canAddAttempt, false, `${pass} must close the course`);
    assert.equal(ev.attemptCount, 1);
  }
});

test('a failed course does offer another sitting', () => {
  const c = P('c1', 3);
  const ev = evaluateCourse(c, setGrade(emptyState(), 'c1', 'F'));
  assert.equal(ev.passed, false);
  assert.equal(ev.canAddAttempt, true);
});

test('the sequence stops at the first pass, whatever else is recorded', () => {
  const c = P('c1', 3);
  // A hand-edited file claiming sittings after a pass.
  const s = { ...emptyState(), grades: { c1: 'F' }, repeats: { c1: ['C', 'A', 'B'] } };
  assert.deepEqual(attemptsOf(c, s), ['F', 'C'], 'everything after the pass is disregarded');
  const r = summarise([c], s);
  assert.equal(r.units, 6, 'two sittings, not four');
  assert.equal(r.points, 9);
  assert.equal(r.gpaText, '1.50');
});

test('a passed first sitting cannot be given repeats at all', () => {
  const c = P('c1', 3);
  const s = { ...emptyState(), grades: { c1: 'B' }, repeats: { c1: ['A', 'A'] } };
  assert.deepEqual(attemptsOf(c, s), ['B']);
  assert.equal(summarise([c], s).units, 3);
  assert.equal(summarise([c], s).gpaText, '4.00');
});

test('recording a pass closes the course and drops later sittings', () => {
  const c = P('c1', 3);
  let s = setGrade(emptyState(), 'c1', 'F');
  s = setAttempt(s, c, 1, 'F');
  s = setAttempt(s, c, 2, 'F');
  assert.equal(evaluateCourse(c, s).attemptCount, 3);

  s = setAttempt(s, c, 1, 'C');    // the second sitting was actually a pass
  assert.deepEqual(attemptsOf(c, s), ['F', 'C'], 'the third sitting can no longer exist');
  assert.deepEqual(s.repeats, { c1: ['C'] }, 'and it is not left lying in storage');
  assert.equal(evaluateCourse(c, s).canAddAttempt, false);
});

test('correcting the first sitting to a pass removes every repeat', () => {
  const c = P('c1', 3);
  let s = setGrade(emptyState(), 'c1', 'F');
  s = setAttempt(s, c, 1, 'F');
  s = setAttempt(s, c, 2, 'B');
  assert.equal(summarise([c], s).units, 9);

  s = setAttempt(s, c, 0, 'A');    // it was passed first time after all
  assert.deepEqual(attemptsOf(c, s), ['A']);
  assert.deepEqual(s.repeats, {});
  assert.equal(summarise([c], s).units, 3);
  assert.equal(summarise([c], s).gpaText, '5.00');
});

test('correcting a pass back to a failure re-opens the course', () => {
  const c = P('c1', 3);
  let s = setGrade(emptyState(), 'c1', 'C');
  assert.equal(evaluateCourse(c, s).canAddAttempt, false);
  s = setGrade(s, 'c1', 'F', c);
  assert.equal(evaluateCourse(c, s).canAddAttempt, true);
});

test('addAttempt refuses to re-sit a passed course', () => {
  const c = P('c1', 3);
  const passed = setGrade(emptyState(), 'c1', 'B');
  assert.deepEqual(addAttempt(passed, c, 'A').repeats ?? {}, {});
  const failed = setGrade(emptyState(), 'c1', 'F');
  assert.deepEqual(addAttempt(failed, c, 'A').repeats, { c1: ['A'] });
});

test('the allowance caps a run of failures, and the pass ends it', () => {
  const c = byId.get('y5s1-MEE511');            // 3 units, 4 sittings
  let s = setGrade(emptyState(), c.id, 'F');
  s = setAttempt(s, c, 1, 'F');
  s = setAttempt(s, c, 2, 'F');
  assert.equal(evaluateCourse(c, s).canAddAttempt, true, 'three failures, one sitting left');
  s = setAttempt(s, c, 3, 'D');
  const ev = evaluateCourse(c, s);
  assert.equal(ev.attemptCount, 4);
  assert.equal(ev.passed, true);
  assert.equal(ev.canAddAttempt, false);
  assert.equal(summarise([c], s).units, 12);
  assert.equal(summarise([c], s).points, 6, 'only the D at the fourth sitting scores');
  assert.equal(summarise([c], s).gpaText, '0.50');
});

test('a student who exhausts the allowance without passing is not offered more', () => {
  const c = byId.get('y5s1-MEE511');
  let s = setGrade(emptyState(), c.id, 'F');
  for (let i = 1; i < 4; i++) s = setAttempt(s, c, i, 'F');
  const ev = evaluateCourse(c, s);
  assert.equal(ev.attemptCount, 4);
  assert.equal(ev.passed, false);
  assert.equal(ev.canAddAttempt, false, 'the allowance is spent');
});

test('treating E as a failure is one configuration change', () => {
  const strict = P('c1', 3, 8, ['F', 'E']);
  const lenient = P('c1', 3, 8, ['F']);
  const s = setGrade(emptyState(), 'c1', 'E');
  assert.equal(evaluateCourse(lenient, s).canAddAttempt, false, 'E passes by default');
  assert.equal(evaluateCourse(strict, s).canAddAttempt, true, 'E fails when configured to');
});

/* --------------------------------------------------------------------------
   Idempotency of the record itself.

   With one grade per course, "no duplicates" came free: the same key was
   overwritten. Once a course carries a list of sittings, that has to be earned.
   The guarantee is that exactly ONE stored form represents any given academic
   record, so re-recording a result — an F included — can never append a second
   copy of it, and the same history always serialises identically.
   -------------------------------------------------------------------------- */

const R = (id, units, maxAttempts = 8, failingGrades = ['F']) =>
  ({ id, code: id, title: id, units, year: 1, semester: 1, maxAttempts, failingGrades });

test('re-recording the same sitting never appends another copy', () => {
  const c = R('c1', 3);
  let s = setGrade(emptyState(), 'c1', 'F');
  for (let i = 0; i < 25; i++) s = setAttempt(s, c, 1, 'F');
  assert.deepEqual(s.repeats, { c1: ['F'] }, 'one F, not twenty-five');
  assert.deepEqual(attemptsOf(c, s), ['F', 'F']);
  assert.equal(summarise([c], s).units, 6);
});

test('re-recording an F at every position is idempotent', () => {
  const c = R('c1', 2);
  let s = setGrade(emptyState(), 'c1', 'F');
  for (let round = 0; round < 3; round++) {
    for (let i = 1; i < 5; i++) s = setAttempt(s, c, i, 'F');
  }
  assert.deepEqual(attemptsOf(c, s), ['F', 'F', 'F', 'F', 'F'],
    'five sittings, however many times they are written');
  assert.deepEqual(s.repeats, { c1: ['F', 'F', 'F', 'F'] });
  assert.equal(summarise([c], s).units, 10);
});

test('a blank is never stored as a sitting', () => {
  const c = R('c1', 3);
  let s = setGrade(emptyState(), 'c1', 'F');
  for (let i = 0; i < 6; i++) s = addAttempt(s, c, '');
  assert.deepEqual(s.repeats ?? {}, {}, 'no empty slots accumulate');
  for (let i = 0; i < 6; i++) s = setAttempt(s, c, 1, '');
  assert.deepEqual(s.repeats ?? {}, {});
  assert.deepEqual(attemptsOf(c, s), ['F']);
});

test('the same history always serialises to the same bytes', () => {
  const c = R('c1', 3);

  // Reached by entering the sittings in order ...
  let a = setGrade(emptyState(), 'c1', 'F');
  a = setAttempt(a, c, 1, 'F');
  a = setAttempt(a, c, 2, 'B');

  // ... by overshooting and correcting ...
  let b = setGrade(emptyState(), 'c1', 'F');
  b = setAttempt(b, c, 1, 'C');
  b = setAttempt(b, c, 1, 'F');
  b = setAttempt(b, c, 2, 'A');
  b = setAttempt(b, c, 2, 'B');

  // ... and by adding a sitting that is then removed again.
  let d = setGrade(emptyState(), 'c1', 'F');
  d = setAttempt(d, c, 1, 'F');
  d = setAttempt(d, c, 2, 'D');
  d = setAttempt(d, c, 2, '');
  d = setAttempt(d, c, 2, 'B');

  const shape = (x) => JSON.stringify({ grades: x.grades, repeats: x.repeats });
  assert.equal(shape(a), shape(b));
  assert.equal(shape(a), shape(d));
  assert.equal(shape(a), '{"grades":{"c1":"F"},"repeats":{"c1":["F","B"]}}');
});

test('canonicaliseState repairs a record that was never canonical', () => {
  const c = R('c1', 3, 4);
  const messy = {
    ...emptyState(),
    grades: { c1: 'F' },
    repeats: { c1: ['', 'F', null, 'Z', 'B', 'F', 'A', 'F', 'F', 'F'] },
  };
  //            ^blank      ^invalid   ^pass — everything after it is impossible
  const clean = canonicaliseState([c], messy);
  assert.deepEqual(clean.repeats, { c1: ['F', 'B'] });
  assert.deepEqual(attemptsOf(c, clean), ['F', 'F', 'B']);
  assert.equal(summarise([c], clean).units, 9);

  // and it is a fixed point: running it again changes nothing
  assert.deepEqual(canonicaliseState([c], clean), clean);
});

test('canonicaliseState trims a record that exceeds the allowance', () => {
  const c = R('c1', 2, 4);                       // 4 sittings allowed
  const over = { ...emptyState(), grades: { c1: 'F' }, repeats: { c1: Array(19).fill('F') } };
  const clean = canonicaliseState([c], over);
  assert.equal(clean.repeats.c1.length, 3, 'first sitting plus three repeats');
  assert.equal(attemptsOf(c, clean).length, 4);
  assert.equal(summarise([c], clean).units, 8);
});

test('canonicaliseState leaves courses from another curriculum alone', () => {
  const c = R('c1', 3);
  const mixed = {
    ...emptyState(),
    grades: { c1: 'A', 'from-another-version': 'B' },
    repeats: { 'from-another-version': ['C'] },
  };
  const clean = canonicaliseState([c], mixed);
  assert.equal(clean.grades['from-another-version'], 'B', 'not silently discarded');
  assert.deepEqual(clean.repeats['from-another-version'], ['C']);
  assert.equal(clean.grades.c1, 'A');
});

test('canonicaliseState is a fixed point for ordinary records', () => {
  const c1 = R('c1', 3), c2 = R('c2', 2);
  let s = setGrade(emptyState(), 'c1', 'F');
  s = setAttempt(s, c1, 1, 'B');
  s = setGrade(s, 'c2', 'A');
  assert.deepEqual(canonicaliseState([c1, c2], s), s);
});

test('every sitting is addressable, so an F is a fact rather than a tally', () => {
  // Three separate failures of the same course are three sittings, each of
  // which can be corrected independently without disturbing the others.
  const c = R('c1', 3);
  let s = setGrade(emptyState(), 'c1', 'F');
  s = setAttempt(s, c, 1, 'F');
  s = setAttempt(s, c, 2, 'F');
  assert.deepEqual(attemptsOf(c, s), ['F', 'F', 'F']);
  assert.equal(summarise([c], s).units, 9);

  s = setAttempt(s, c, 1, 'D');      // the second sitting was actually a D
  assert.deepEqual(attemptsOf(c, s), ['F', 'D'], 'and the third can no longer exist');
  assert.equal(summarise([c], s).points, 6);
});
