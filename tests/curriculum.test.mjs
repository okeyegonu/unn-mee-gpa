/**
 * Curriculum tests — section 12. These run against the real data file, so a
 * later correction to data/curriculum.json is checked by `npm test` too.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { validateCurriculum, flattenCurriculum, courseId, indexCourses } from '../src/curriculum.js';
import { emptyState, setGrade, summarise, evaluateCourse, summariseRows } from '../src/gpa-engine.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const doc = JSON.parse(await readFile(resolve(root, 'data/curriculum.json'), 'utf8'));
const courses = flattenCurriculum(doc);

test('the curriculum document validates without errors', () => {
  const { errors } = validateCurriculum(doc);
  assert.deepEqual(errors, [], errors.join('\n'));
});

test('the curriculum is versioned and attributed to its sources', () => {
  assert.equal(doc.curriculum_id, 'unn-mee-beng-5yr');
  assert.ok(doc.curriculum_version, 'a curriculum_version is present');
  assert.equal(doc.institution, 'University of Nigeria, Nsukka');
  assert.equal(doc.programme, 'Mechanical Engineering');
  assert.ok(doc.sources.some((s) => s.document.endsWith('.pdf')));
  assert.ok(doc.sources.some((s) => s.document.endsWith('.jpeg')));
});

test('the grade scale in the data file is the fixed UNN scale', () => {
  assert.deepEqual(doc.grade_scale, { A: 5, B: 4, C: 3, D: 2, E: 1, F: 0 });
});

test('five years, each with a first and a second semester', () => {
  assert.equal(doc.years.length, 5);
  for (const y of doc.years) {
    assert.deepEqual(y.semesters.map((s) => s.semester), [1, 2], y.label);
  }
});

test('course ids are unique and are built from year + semester + code', () => {
  const ids = courses.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');
  assert.equal(courseId(3, 1, 'MEE 313'), 'y3s1-MEE313');
  assert.ok(ids.includes('y3s1-MEE313'));
  assert.equal(indexCourses(courses).get('y3s1-MEE313').title, 'Mechanical Engineering Design I');
});

test('every course code is well formed and every course has a code', () => {
  for (const c of courses) {
    assert.match(c.code, /^[A-Z]{3} \d{3}$/, `code "${c.code}"`);
  }
});

test('no course carries a zero unit load', () => {
  for (const c of courses) {
    if (!c.unitsUnknown) assert.ok(c.units > 0, `${c.code} has ${c.units} units`);
  }
});

test('each semester whose total is stated in the source reconciles exactly', () => {
  const expected = {
    'y1s1': 16, 'y1s2': 16, 'y2s1': 19, 'y2s2': 18, 'y3s1': 20, 'y3s2': 20,
    'y4s1': 22, 'y4s2': 15, 'y5s1': 18, 'y5s2': 19,
  };
  for (const year of doc.years) {
    for (const sem of year.semesters) {
      const key = `y${year.year}s${sem.semester}`;
      if (!(key in expected)) continue;
      assert.equal(sem.stated_total_units, expected[key], `${key} stated total`);
      const here = courses.filter((c) => c.year === year.year && c.semester === sem.semester);
      const compulsory = here.filter((c) => c.groupType !== 'elective').reduce((a, c) => a + c.units, 0);
      const electiveUnits = sem.groups.find((g) => g.type === 'elective')?.choose_units ?? 0;
      assert.equal(compulsory + electiveUnits, expected[key], `${key} computed total`);
    }
  }
});

test('First Year, First Semester is the handwritten revision, not the printed list', () => {
  const y1s1 = courses.filter((c) => c.year === 1 && c.semester === 1);
  assert.deepEqual(y1s1.map((c) => c.code),
    ['MTH 101', 'MTH 103', 'CHM 101', 'CHM 107', 'PHY 101', 'PHY 107', 'GST 111', 'MEE 101', 'PHY 103', 'GET 101']);
  assert.equal(y1s1.reduce((a, c) => a + c.units, 0), 16);
  // The superseded printed codes are kept for traceability.
  assert.equal(y1s1.find((c) => c.code === 'MTH 101').legacyCode, 'MTH 111');
  assert.equal(y1s1.find((c) => c.code === 'GST 111').legacyCode, 'GSP 101');
});

test('every course now has a known unit load', () => {
  const unknown = courses.filter((c) => c.unitsUnknown).map((c) => c.code);
  assert.deepEqual(unknown, [], `still missing: ${unknown.join(', ')}`);
});

test('the two unit loads absent from the source carry their provenance', () => {
  // PHY 104 and STA 112 are blank on the pre-computation form; the department
  // supplied 2 and 3. The values are recorded as such rather than as extracted.
  const supplied = Object.fromEntries(
    doc.years[0].semesters[1].groups[0].courses
      .filter((c) => c.units_source === 'supplied_by_department')
      .map((c) => [c.code, c.units]),
  );
  assert.deepEqual(supplied, { 'PHY 104': 2, 'STA 112': 3 });
  for (const c of doc.years[0].semesters[1].groups[0].courses) {
    if (c.units_source === 'supplied_by_department') {
      assert.match(c.notes, /supplied by the department/);
    }
  }
  assert.equal(doc.amendments.length, 1, 'the change is recorded in the data file');
});

test('the Fifth Year option areas are preserved as electives, not flattened', () => {
  const electives = courses.filter((c) => c.groupType === 'elective');
  assert.ok(electives.length > 0);
  for (const c of electives) assert.equal(c.year, 5);

  const y5s1 = doc.years[4].semesters[0].groups.filter((g) => g.type === 'elective');
  assert.equal(y5s1.length, 2, 'Option A and Option B');
  for (const g of y5s1) { assert.equal(g.choose, 2); assert.equal(g.choose_units, 6); }

  const y5s2 = doc.years[4].semesters[1].groups.filter((g) => g.type === 'elective');
  assert.equal(y5s2.length, 2);
  for (const g of y5s2) { assert.equal(g.choose, 1); assert.equal(g.choose_units, 3); }
});

test('year and semester metadata do not gate the calculation on real course data', () => {
  // One course from three different years and semesters, nothing else entered.
  let s = emptyState(doc.curriculum_version);
  s = setGrade(s, 'y1s1-MTH101', 'A');   // 2 units -> 10
  s = setGrade(s, 'y2s2-MEE202', 'B');   // 3 units -> 12
  s = setGrade(s, 'y4s1-MEE443', 'C');   // 3 units -> 9
  const r = summarise(courses, s);
  assert.equal(r.gradedCourses, 3);
  assert.equal(r.units, 8);
  assert.equal(r.points, 31);
  assert.equal(r.gpaText, '3.88');
});

test('the entire programme graded A yields exactly 5.00', () => {
  let s = emptyState(doc.curriculum_version);
  for (const c of courses) if (!c.unitsUnknown) s = setGrade(s, c.id, 'A');
  const r = summarise(courses, s);
  assert.equal(r.gpaText, '5.00');
  assert.equal(r.points, r.units * 5);
});

/* ------------------------------------------------------------------------
   Electives are a display label, never a calculation rule.

   The curriculum records that Fifth Year electives come from two option areas
   with "choose 2" / "choose 1" rules, because that is what the source document
   says and a student reading the page should see it. The engine ignores all of
   it: a course counts because a grade was entered, full stop. These tests exist
   so that nobody can later make electives special without a test failing.
   ------------------------------------------------------------------------ */

test('an elective grade counts exactly like a compulsory one', () => {
  const compulsory = setGrade(emptyState(), 'y5s1-MEE511', 'A');   // 3 units, compulsory
  const elective   = setGrade(emptyState(), 'y5s1-MEE555', 'A');   // 3 units, Option A elective
  const a = summarise(courses, compulsory);
  const b = summarise(courses, elective);
  assert.deepEqual(b, a, 'the two summaries must be indistinguishable');
  assert.equal(b.units, 3);
  assert.equal(b.points, 15);
  assert.equal(b.gpaText, '5.00');
});

test('electives taken from both option areas are simply added up', () => {
  // The source says a student picks one option area. The calculator does not
  // police that: it counts whatever grades the student entered.
  let s = emptyState();
  s = setGrade(s, 'y5s1-MEE555', 'A');   // Option A, 3 units -> 15
  s = setGrade(s, 'y5s1-MEE543', 'B');   // Option B, 3 units -> 12
  const r = summarise(courses, s);
  assert.equal(r.gradedCourses, 2);
  assert.equal(r.units, 6);
  assert.equal(r.points, 27);
  assert.equal(r.gpaText, '4.50');
});

test('entering more electives than the "choose" rule allows is not rejected', () => {
  let s = emptyState();
  s = setGrade(s, 'y5s1-MEE555', 'A');   // 3 units -> 15
  s = setGrade(s, 'y5s1-MEE543', 'B');   // 3 units -> 12
  s = setGrade(s, 'y5s1-MEE565', 'C');   // 3 units ->  9   (a third, where the rule says two)
  const r = summarise(courses, s);
  assert.equal(r.gradedCourses, 3);
  assert.equal(r.units, 9);
  assert.equal(r.points, 36);
  assert.equal(r.gpaText, '4.00');
});

test('electives left blank are dormant, exactly like any other blank course', () => {
  // Every Fifth Year compulsory course graded A; no elective touched at all.
  let s = emptyState();
  const compulsoryY5 = courses.filter((c) => c.year === 5 && c.groupType !== 'elective');
  for (const c of compulsoryY5) s = setGrade(s, c.id, 'A');
  const r = summarise(courses, s);
  const expectedUnits = compulsoryY5.reduce((a, c) => a + c.units, 0);
  assert.equal(r.units, expectedUnits, 'not one elective unit leaks into the denominator');
  assert.equal(r.gradedCourses, compulsoryY5.length);
  assert.equal(r.gpaText, '5.00');
});

test('the GPA engine never reads elective metadata anywhere', async () => {
  const { readFile } = await import('node:fs/promises');
  const engine = await readFile(resolve(root, 'src/gpa-engine.js'), 'utf8');
  const code = engine.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');   // ignore comments
  for (const token of ['elective', 'groupType', 'groupChoose', 'groupId', 'category']) {
    assert.ok(!new RegExp(`\\b${token}\\b`).test(code),
      `gpa-engine.js must not reference "${token}"`);
  }
});

test('the active-course decision never reads year, semester or group', () => {
  // evaluateCourse decides whether a course counts; summariseRows adds up the
  // ones that do. Neither may look at curriculum position. (year and semester
  // DO appear elsewhere in the engine — in semesterSummaries and yearSummaries,
  // which only partition an already-computed set for the display panels.)
  for (const fn of [evaluateCourse, summariseRows]) {
    const body = fn.toString().replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    for (const token of ['year', 'semester', 'group', 'elective', 'order', 'category']) {
      assert.ok(!new RegExp(`\\b${token}`, 'i').test(body),
        `${fn.name} must not reference "${token}"`);
    }
  }
});
