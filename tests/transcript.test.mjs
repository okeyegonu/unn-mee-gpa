/**
 * The sessional statement of result: formatting, validation, the prerequisite
 * rule, and the figures that appear on the sheet.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  LETTERHEAD_RESERVE_MM,
  formatFullName, formatShortName, nameProblems,
  normaliseRegNo, regNoProblem, REG_NO_PATTERN, REG_NO_MIN_DIGITS, REG_NO_MAX_DIGITS,
  formatSession, sessionProblem, parseSession,
  yearOfStudyOptions, formatYearOfStudy,
  GENDERS, genderProblem,
  ADVISER_SALUTATIONS_1, ADVISER_SALUTATIONS_2, formatAdviser, adviserProblems,
  prerequisiteCheck, buildTranscript, transcriptProblems,
} from '../src/transcript.js';
import { flattenCurriculum } from '../src/curriculum.js';
import { emptyState, setGrade, setAttempt } from '../src/gpa-engine.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const doc = JSON.parse(await readFile(resolve(root, 'data/curriculum.json'), 'utf8'));
const courses = flattenCurriculum(doc);
const byId = new Map(courses.map((c) => [c.id, c]));

/* -------------------------------------------------------------- the reserve */

test('the letterhead reserve is the measured 62.7 mm', () => {
  // Measured from the reference statement rendered at 150 dpi: the letterhead's
  // ink ends at 50.5 mm and the "To:" line begins at 62.7 mm.
  assert.equal(LETTERHEAD_RESERVE_MM, 62.7);
  assert.ok(LETTERHEAD_RESERVE_MM > 50.5, 'it must clear the printed letterhead');
});

/* -------------------------------------------------------------------- names */

test('the addressee reads SURNAME, Firstname Middlename', () => {
  assert.equal(
    formatFullName({ first: 'Ifeoma', middle: 'Blessing', surname: 'Okechukwu' }),
    'OKECHUKWU, Ifeoma Blessing',
  );
  assert.equal(formatFullName({ first: 'ifeoma', middle: 'blessing', surname: 'okechukwu' }),
    'OKECHUKWU, Ifeoma Blessing', 'however it was typed');
  assert.equal(formatFullName({ first: '  Ifeoma  ', middle: '', surname: 'Okechukwu' }),
    'OKECHUKWU, Ifeoma', 'a missing middle name leaves no stray spacing');
});

test('the details line reduces the middle name to an initial', () => {
  assert.equal(
    formatShortName({ first: 'Ifeoma', middle: 'Blessing', surname: 'Okechukwu' }),
    'OKECHUKWU, Ifeoma B.',
  );
  assert.equal(formatShortName({ first: 'Ifeoma', middle: '', surname: 'Okechukwu' }),
    'OKECHUKWU, Ifeoma');
});

test('compound and apostrophised names keep their capitals', () => {
  assert.equal(formatFullName({ first: "chidi-emeka", middle: "o'brien", surname: 'nwosu' }),
    "NWOSU, Chidi-Emeka O'Brien");
});

test('a name must be given, and cannot contain numbers', () => {
  assert.deepEqual(nameProblems({ first: 'Ifeoma', surname: 'Okechukwu' }), []);
  assert.match(nameProblems({ first: '', surname: 'Okechukwu' }).join(' '), /first name is required/i);
  assert.match(nameProblems({ first: 'Ifeoma', surname: '' }).join(' '), /surname is required/i);
  assert.match(nameProblems({ first: 'Ifeoma2', surname: 'Okechukwu' }).join(' '), /cannot contain numbers/i);
});

/* ------------------------------------------------------ registration number */

test('a registration number is a four-digit year, a slash and 2 to 9 digits', () => {
  assert.equal(REG_NO_MIN_DIGITS, 2);
  assert.equal(REG_NO_MAX_DIGITS, 9);

  // Today's numbers carry six or seven numerals; the range allows for growth.
  for (const good of ['2021/242857', '2019/1234567', '2024/000001', '2024/12', '2024/123456789']) {
    assert.equal(regNoProblem(good), null, good);
    assert.ok(REG_NO_PATTERN.test(good));
  }
  // Every serial length from two to nine is accepted.
  for (let n = REG_NO_MIN_DIGITS; n <= REG_NO_MAX_DIGITS; n++) {
    assert.equal(regNoProblem(`2024/${'1'.repeat(n)}`), null, `${n} digits`);
  }
  for (const bad of ['2024/1', '2024/1234567890', '21/242857', '20211/242857',
                     '2021-242857', '2021/abcdef', '2021/24285A', '242857', '']) {
    assert.ok(regNoProblem(bad), `${bad} should be refused`);
  }
});

test('spaces around a registration number are removed', () => {
  assert.equal(normaliseRegNo('  2021 / 242857 '), '2021/242857');
  assert.equal(regNoProblem('  2021/242857  '), null);
});

test('an impossible entry year is refused', () => {
  assert.match(regNoProblem('1850/242857'), /does not look like an entry year/i);
  assert.match(regNoProblem('2999/242857'), /does not look like an entry year/i);
});

/* ------------------------------------------------------------------ session */

test('a session is written in full years, never abbreviated', () => {
  assert.equal(formatSession(2023), '2023/2024');
  assert.equal(formatSession('2019'), '2019/2020');
  assert.notEqual(formatSession(2023), '2023/24');
  assert.equal(sessionProblem(2023), null);
});

test('a session that spans the century still reads in full', () => {
  assert.equal(formatSession(1999), '1999/2000');
  assert.equal(formatSession(2099), '2099/2100');
});

test('a nonsensical session is refused', () => {
  for (const bad of ['', null, 'abc', '1200', '2500', 'twenty']) {
    assert.ok(sessionProblem(bad), String(bad));
  }
});

test('the session is typed, and either shape is accepted', () => {
  // The opening year alone, or the session written out in full.
  assert.deepEqual(parseSession('2023'), { year: 2023, problem: null });
  assert.deepEqual(parseSession('2023/2024'), { year: 2023, problem: null });
  assert.deepEqual(parseSession('  2023 / 2024  '), { year: 2023, problem: null },
    'spacing is of no consequence');
  assert.equal(formatSession(parseSession('2023/2024').year), '2023/2024');
});

test('an abbreviated session is refused, and the full form suggested', () => {
  const r = parseSession('2023/24');
  assert.equal(r.year, null);
  assert.match(r.problem, /written in full years/i);
  assert.match(r.problem, /2023\/2024/, 'and it says what to write instead');
});

test('two years that are not consecutive are refused', () => {
  const r = parseSession('2023/2025');
  assert.equal(r.year, null);
  assert.match(r.problem, /consecutive/i);
  assert.match(r.problem, /2024/);
});

test('a session outside living memory is refused', () => {
  assert.match(parseSession('1850').problem, /opening year/i);
  assert.match(parseSession('2500/2501').problem, /opening year/i);
});

/* ------------------------------------------------------------ year of study */

test('the year of study denominator is the programme length, never the year', () => {
  const opts = yearOfStudyOptions(5);
  assert.equal(opts.length, 8, 'eight options, because eight years is the maximum');
  assert.deepEqual(opts.map((o) => o.label),
    ['1/5', '2/5', '3/5', '4/5', '5/5', '6/5', '7/5', '8/5']);
  assert.ok(!opts.some((o) => o.label === '4/4'), 'the reference statement\'s 4/4 is not reproduced');
  assert.equal(formatYearOfStudy(4, 5), '4/5');
});

test('the range follows the programme, so a long one is not cut off', () => {
  // Medicine: seven years to graduate, ten allowed.
  assert.deepEqual(yearOfStudyOptions(7, 10).map((o) => o.label),
    ['1/7', '2/7', '3/7', '4/7', '5/7', '6/7', '7/7', '8/7', '9/7', '10/7']);
  assert.equal(formatYearOfStudy(9, 7), '9/7');
  // This Department: five years, eight allowed, exactly as the statement reads.
  assert.equal(yearOfStudyOptions(5, 8).length, 8);
});

test('a four-year programme reads 1/4 to 8/4', () => {
  assert.deepEqual(yearOfStudyOptions(4).map((o) => o.label),
    ['1/4', '2/4', '3/4', '4/4', '5/4', '6/4', '7/4', '8/4']);
  // 4/4 is correct here — it is only a blunder when the programme is longer.
  assert.equal(formatYearOfStudy(4, 4), '4/4');
});

/* ------------------------------------------------------------------ gender */

test('the field offers Male and Female, and is called Gender', () => {
  assert.deepEqual(GENDERS, ['Male', 'Female']);
  assert.equal(genderProblem('Female'), null);
  assert.match(genderProblem('female'), /Male or Female/);
  assert.match(genderProblem(''), /Male or Female/);
});

/* ------------------------------------------------------- academic adviser */

test('the Academic Adviser reads Engr. Dr. M. N. Eke', () => {
  assert.equal(formatAdviser({
    salutation1: 'Engr.', salutation2: 'Dr.',
    initial1: 'M', initial2: 'N', surname: 'Eke',
  }), 'Engr. Dr. M. N. Eke');
});

test('the second title applies only to Engr.', () => {
  assert.equal(formatAdviser({ salutation1: 'Prof.', salutation2: 'Dr.', initial1: 'A', surname: 'Okoro' }),
    'Prof. A. Okoro', 'a second title is ignored after Prof.');
  assert.equal(formatAdviser({ salutation1: 'Engr.', salutation2: 'Prof.', initial1: 'A', surname: 'Okoro' }),
    'Engr. Prof. A. Okoro');
  assert.equal(formatAdviser({ salutation1: 'Engr.', initial1: 'A', surname: 'Okoro' }),
    'Engr. A. Okoro', 'and it is optional');
  assert.deepEqual(ADVISER_SALUTATIONS_1, ['Engr.', 'Prof.', 'Dr.', 'Mr.']);
  assert.deepEqual(ADVISER_SALUTATIONS_2, ['Prof.', 'Dr.', 'Mr.']);
});

test('initials are normalised to a letter and a full stop', () => {
  assert.equal(formatAdviser({ salutation1: 'Dr.', initial1: 'm', initial2: 'n.', surname: 'eke' }),
    'Dr. M. N. Eke');
  assert.equal(formatAdviser({ salutation1: 'Dr.', initial1: 'M', initial2: 'N', initial3: 'O', surname: 'Eke' }),
    'Dr. M. N. O. Eke', 'a third initial is allowed');
});

test('a Academic Adviser needs a title, an initial and a surname', () => {
  assert.deepEqual(adviserProblems({ salutation1: 'Engr.', initial1: 'M', surname: 'Eke' }), []);
  assert.match(adviserProblems({ initial1: 'M', surname: 'Eke' }).join(' '), /title/i);
  assert.match(adviserProblems({ salutation1: 'Dr.', surname: 'Eke' }).join(' '), /first initial/i);
  assert.match(adviserProblems({ salutation1: 'Dr.', initial1: 'M' }).join(' '), /surname is required/i);
});

/* ------------------------------------------------------- the prerequisite */

/** For these tests, every compulsory course of a year is required. */
const requiredFor = (year) => courses.filter(
  (c) => c.year === year && c.groupType === 'compulsory' && c.cohortId === null,
);

test('a first-year statement needs nothing earlier', () => {
  const r = prerequisiteCheck(1, emptyState(), requiredFor);
  assert.equal(r.ok, true);
  assert.equal(r.missingCount, 0);
});

test('a second-year statement is blocked until first year is complete', () => {
  const r = prerequisiteCheck(2, emptyState(), requiredFor);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missingByYear.map((m) => m.year), [1]);
  assert.equal(r.missingCount, 19, 'both first-year semesters, 10 + 9 courses');
});

test('entering every earlier result unblocks it', () => {
  let s = emptyState();
  for (const c of [...requiredFor(1)]) s = setGrade(s, c.id, 'B');
  const r = prerequisiteCheck(2, s, requiredFor);
  assert.equal(r.ok, true, 'first year complete');

  const r3 = prerequisiteCheck(3, s, requiredFor);
  assert.equal(r3.ok, false, 'but the second year is still missing');
  assert.deepEqual(r3.missingByYear.map((m) => m.year), [2]);
});

test('the block names every year and course that is missing', () => {
  let s = emptyState();
  // First year complete but for one course; second year untouched.
  const year1 = requiredFor(1);
  for (const c of year1.slice(1)) s = setGrade(s, c.id, 'A');

  const r = prerequisiteCheck(3, s, requiredFor);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missingByYear.map((m) => m.year), [1, 2]);
  assert.equal(r.missingByYear[0].courses.length, 1);
  assert.equal(r.missingByYear[0].courses[0].code, year1[0].code);
  assert.ok(r.missingByYear[1].courses.length > 0);
});

test('an F counts as a result entered, a blank does not', () => {
  let s = emptyState();
  for (const c of requiredFor(1)) s = setGrade(s, c.id, 'F');
  assert.equal(prerequisiteCheck(2, s, requiredFor).ok, true,
    'a failed course is still a result');
});

/* ------------------------------------------------------------- the figures */

test('the session GPA covers the session; the CGPA covers everything before it', () => {
  const y1 = requiredFor(1);
  const y2first = courses.filter((c) => c.year === 2 && c.semester === 1 && c.groupType === 'compulsory');
  const y2second = courses.filter((c) => c.year === 2 && c.semester === 2 && c.groupType === 'compulsory');

  let s = emptyState();
  for (const c of y1) s = setGrade(s, c.id, 'C');          // 3 points a unit
  for (const c of [...y2first, ...y2second]) s = setGrade(s, c.id, 'A');   // 5 a unit

  const t = buildTranscript({
    student: { first: 'Ifeoma', middle: 'Blessing', surname: 'Okechukwu', regNo: '2021/242857', gender: 'Female' },
    adviser: { salutation1: 'Engr.', salutation2: 'Dr.', initial1: 'M', initial2: 'N', surname: 'Eke' },
    session: 2023, yearOfStudy: 2, programmeYears: 5,
    firstSemester: y2first, secondSemester: y2second,
    cumulativeCourses: [...y1, ...y2first, ...y2second],
    state: s,
  });

  assert.equal(t.gpa, '5.00', 'the session was all As');
  assert.ok(Number(t.cgpa) < 5 && Number(t.cgpa) > 3, `the CGPA is dragged down by first year: ${t.cgpa}`);
  assert.notEqual(t.gpa, t.cgpa, 'a cumulative figure is not the session figure');

  // 32 units of C (96 points) and 37 of A (185) -> 281 / 69
  assert.equal(t.cgpaUnits, 69);
  assert.equal(t.cgpaPoints, 281);
  assert.equal(t.cgpa, '4.07');
});

test('the statement carries every formatted field', () => {
  const y1s1 = courses.filter((c) => c.year === 1 && c.semester === 1 && c.cohortId === null);
  let s = emptyState();
  for (const c of y1s1) s = setGrade(s, c.id, 'A');

  const t = buildTranscript({
    student: { first: 'Ifeoma', middle: 'Blessing', surname: 'Okechukwu', regNo: ' 2021/242857 ', gender: 'Female' },
    adviser: { salutation1: 'Engr.', salutation2: 'Dr.', initial1: 'M', initial2: 'N', surname: 'Eke' },
    session: 2023, yearOfStudy: 1, programmeYears: 5,
    firstSemester: y1s1, secondSemester: [],
    cumulativeCourses: y1s1, state: s,
  });

  assert.equal(t.addressee, 'OKECHUKWU, Ifeoma Blessing');
  assert.equal(t.name, 'OKECHUKWU, Ifeoma B.');
  assert.equal(t.regNo, '2021/242857');
  assert.equal(t.yearOfStudy, '1/5');
  assert.equal(t.gender, 'Female');
  assert.equal(t.session, '2023/2024');
  assert.equal(t.adviser, 'Engr. Dr. M. N. Eke');
  assert.equal(t.semesters[0].rows.length, y1s1.length);
  assert.equal(t.semesters[1].rows.length, 0);
  assert.equal(t.semesters[0].rows[0].title, t.semesters[0].rows[0].title.toUpperCase(),
    'titles are set in capitals, as on the reference');
});

test('a repeated course shows every sitting on the statement', () => {
  const mee313 = byId.get('y3s1-MEE313');          // 3 units
  let s = setGrade(emptyState(), mee313.id, 'F');
  s = setAttempt(s, mee313, 1, 'B');

  const t = buildTranscript({
    student: { first: 'A', surname: 'B', regNo: '2021/242857', gender: 'Male' },
    adviser: { salutation1: 'Dr.', initial1: 'M', surname: 'Eke' },
    session: 2023, yearOfStudy: 3, programmeYears: 5,
    firstSemester: [mee313], secondSemester: [],
    cumulativeCourses: [mee313], state: s,
  });
  assert.equal(t.semesters[0].rows[0].grade, 'F / B');
  assert.deepEqual(t.semesters[0].rows[0].sittings, ['F', 'B']);
  assert.equal(t.gpa, '2.00', 'both sittings count');
});

test('everything wrong is reported at once, not one thing at a time', () => {
  const problems = transcriptProblems({
    student: { first: '', surname: '', regNo: 'nonsense', gender: '' },
    adviser: {}, session: 'x', yearOfStudy: 0,
    firstSemester: [], secondSemester: [],
  });
  for (const expected of [/first name/i, /surname/i, /registration number/i, /Male or Female/i,
    /session/i, /year of study/i, /at least one course/i, /title for the Academic Adviser/i]) {
    assert.ok(problems.some((p) => expected.test(p)), `expected a problem matching ${expected}`);
  }
});

test('a complete form reports no problems', () => {
  const y1s1 = courses.filter((c) => c.year === 1 && c.semester === 1 && c.cohortId === null);
  assert.deepEqual(transcriptProblems({
    student: { first: 'Ifeoma', middle: 'Blessing', surname: 'Okechukwu', regNo: '2021/242857', gender: 'Female' },
    adviser: { salutation1: 'Engr.', salutation2: 'Dr.', initial1: 'M', initial2: 'N', surname: 'Eke' },
    session: 2023, yearOfStudy: 1,
    firstSemester: y1s1, secondSemester: [],
  }), []);
});
