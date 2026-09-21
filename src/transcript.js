/**
 * transcript.js — the sessional statement of result.
 *
 * Pure logic: formatting, validation, the prerequisite rule, and the figures
 * that appear on the sheet. No DOM, no storage, no printing. The layout lives
 * in the print stylesheet; this module decides only what the words and numbers
 * are.
 *
 * Measured from the reference statement
 * (IFEOMA_OKECHUKWU_BLESSING_TRANSCRIPT.pdf, A4, scanned at 150 dpi):
 * the letterhead's ink ends 50.5 mm down the page and the "To:" line begins at
 * 62.7 mm. That 62.7 mm is reserved as blank so the sheet can be printed on
 * pre-printed University masthead paper. See LETTERHEAD_RESERVE_MM.
 */

import { summariseRows, evaluateAll, evaluateCourse, formatGpa, attemptsOf } from './gpa-engine.js';

/** Blank space at the top of the page, in millimetres. Measured, not estimated. */
export const LETTERHEAD_RESERVE_MM = 62.7;

/* ------------------------------------------------------------------ names */

const tidy = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');

/** Title case for a personal name: "ifeoma" -> "Ifeoma", "o'brien" -> "O'Brien". */
function nameCase(s) {
  return tidy(s).toLowerCase().replace(/(^|[\s'’-])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

/**
 * "SURNAME, Firstname Middlename" — the form used on the reference statement's
 * addressee line. The surname is set in capitals so it reads unambiguously,
 * which matters in a country where either name may come first.
 */
export function formatFullName({ first, middle, surname } = {}) {
  const sn = tidy(surname).toUpperCase();
  const parts = [nameCase(first), nameCase(middle)].filter(Boolean);
  if (!sn) return parts.join(' ');
  return parts.length ? `${sn}, ${parts.join(' ')}` : sn;
}

/**
 * "SURNAME, Firstname M." — the shorter form the reference uses on the details
 * line, where the middle name is reduced to an initial.
 */
export function formatShortName({ first, middle, surname } = {}) {
  const sn = tidy(surname).toUpperCase();
  const fn = nameCase(first);
  const mi = tidy(middle) ? `${tidy(middle)[0].toUpperCase()}.` : '';
  const rest = [fn, mi].filter(Boolean).join(' ');
  if (!sn) return rest;
  return rest ? `${sn}, ${rest}` : sn;
}

export function nameProblems({ first, surname } = {}) {
  const out = [];
  if (!tidy(first)) out.push('A first name is required.');
  if (!tidy(surname)) out.push('A surname is required.');
  for (const [label, value] of [['first name', first], ['surname', surname]]) {
    if (tidy(value) && /\d/.test(tidy(value))) out.push(`A ${label} cannot contain numbers.`);
  }
  return out;
}

/* ------------------------------------------------------- registration number */

/** 4-digit year, a slash, then 6 or 7 digits. For example 2021/242857. */
export const REG_NO_PATTERN = /^\d{4}\/\d{6,7}$/;

export function normaliseRegNo(value) {
  return String(value ?? '').trim().replace(/\s+/g, '');
}

export function regNoProblem(value) {
  const v = normaliseRegNo(value);
  if (!v) return 'A registration number is required.';
  if (!REG_NO_PATTERN.test(v)) {
    return 'A registration number is written as a four-digit year, a slash, then six or seven digits — for example 2021/242857.';
  }
  const year = Number(v.slice(0, 4));
  const thisYear = new Date().getFullYear();
  if (year < 1960 || year > thisYear + 1) {
    return `${year} does not look like an entry year.`;
  }
  return null;
}

/* ------------------------------------------------------------------ session */

/**
 * A session is written in full years. The reference statement reads "2023/24";
 * that abbreviation is not used here — "2023/2024" is written out.
 */
export function formatSession(startYear) {
  const y = Number(startYear);
  if (!Number.isInteger(y) || y < 1960 || y > 2100) return null;
  return `${y}/${y + 1}`;
}

export function sessionProblem(startYear) {
  if (formatSession(startYear) === null) {
    return 'A session is chosen by its opening year, for example 2023 for the 2023/2024 session.';
  }
  return null;
}

/* ------------------------------------------------------------ year of study */

/**
 * "3/5" — the year reached over the length of the programme. The denominator is
 * the programme's length and never the year reached, so a fourth-year student
 * of a five-year programme is 4/5. The reference statement reads "4/4", which
 * is wrong for a five-year programme and is not reproduced.
 */
export function yearOfStudyOptions(programmeYears, maxYears = 8) {
  const n = Number(programmeYears);
  if (!Number.isInteger(n) || n < 1) return [];
  return Array.from({ length: maxYears }, (_, i) => ({
    value: i + 1,
    label: `${i + 1}/${n}`,
  }));
}

export function formatYearOfStudy(year, programmeYears) {
  const y = Number(year);
  const n = Number(programmeYears);
  if (!Number.isInteger(y) || !Number.isInteger(n) || y < 1 || n < 1) return null;
  return `${y}/${n}`;
}

/* ------------------------------------------------------------------ gender */

/** The field is Gender. It is not labelled Sex. */
export const GENDERS = Object.freeze(['Male', 'Female']);

export function genderProblem(value) {
  return GENDERS.includes(value) ? null : 'Choose Male or Female.';
}

/* ------------------------------------------------------- head of department */

/** "Engr." may be followed by a second title; the others stand alone. */
export const HOD_SALUTATIONS_1 = Object.freeze(['Engr.', 'Prof.', 'Dr.', 'Mr.']);
export const HOD_SALUTATIONS_2 = Object.freeze(['Prof.', 'Dr.', 'Mr.']);
export const HOD_SALUTATION_2_APPLIES_TO = 'Engr.';

/** An initial is shown as a single capital letter and a full stop. */
function formatInitial(value) {
  const v = tidy(value).replace(/[^A-Za-z]/g, '');
  return v ? `${v[0].toUpperCase()}.` : '';
}

/**
 * "Engr. Dr. M. N. Eke". The Head of Department is entered by the student
 * rather than fixed in the data, because the office changes hands.
 */
export function formatHod({ salutation1, salutation2, initial1, initial2, initial3, surname } = {}) {
  const parts = [];
  if (HOD_SALUTATIONS_1.includes(salutation1)) parts.push(salutation1);
  if (salutation1 === HOD_SALUTATION_2_APPLIES_TO && HOD_SALUTATIONS_2.includes(salutation2)) {
    parts.push(salutation2);
  }
  for (const i of [initial1, initial2, initial3]) {
    const f = formatInitial(i);
    if (f) parts.push(f);
  }
  const sn = tidy(surname);
  if (sn) parts.push(nameCase(sn));
  return parts.join(' ');
}

export function hodProblems(hod = {}) {
  const out = [];
  if (!HOD_SALUTATIONS_1.includes(hod.salutation1)) out.push('Choose a title for the Head of Department.');
  if (!formatInitial(hod.initial1)) out.push("The Head of Department's first initial is required.");
  if (!tidy(hod.surname)) out.push("The Head of Department's surname is required.");
  if (tidy(hod.surname) && /\d/.test(tidy(hod.surname))) out.push("The Head of Department's surname cannot contain numbers.");
  return out;
}

/* --------------------------------------------------------- the prerequisite */

/**
 * A statement for a given year may only be produced once every earlier year is
 * complete. A sessional statement is a cumulative document: its CGPA is
 * meaningless if results from earlier years are missing.
 *
 * `requiredCoursesForYear` is supplied by the caller, because what counts as
 * required differs between a fixed curriculum and a list the student typed.
 *
 * Returns { ok, missingByYear: [{ year, courses: [course] }], missingCount }.
 */
export function prerequisiteCheck(year, state, requiredCoursesForYear) {
  const target = Number(year);
  const missingByYear = [];
  let missingCount = 0;

  for (let y = 1; y < target; y++) {
    const required = requiredCoursesForYear(y) ?? [];
    const missing = required.filter((c) => attemptsOf(c, state).length === 0);
    if (missing.length > 0) {
      missingByYear.push({ year: y, courses: missing });
      missingCount += missing.length;
    }
  }
  return { ok: missingCount === 0, missingByYear, missingCount };
}

/* ------------------------------------------------------------- the figures */

/**
 * Build the statement.
 *
 * `selected` is the courses the student ticked, split by semester. The session
 * GPA comes from those alone. The CGPA is cumulative: it covers every result
 * entered for the years up to and including this one, which is what makes the
 * prerequisite check above necessary.
 */
export function buildTranscript({
  student, hod, session, yearOfStudy, programmeYears,
  firstSemester = [], secondSemester = [],
  cumulativeCourses = [], state, decimals = 2,
}) {
  const rowsFor = (courses) => courses.map((course) => {
    const ev = evaluateCourse(course, state);
    const sittings = ev.attempts.map((a) => a.grade);
    return {
      id: course.id,
      code: course.code,
      title: (course.title ?? '').toUpperCase(),
      units: ev.baseUnits,
      // A course sat more than once shows every sitting, oldest first.
      grade: sittings.join(' / '),
      sittings,
    };
  });

  const sessionCourses = [...firstSemester, ...secondSemester];
  const sessionSummary = summariseRows(evaluateAll(sessionCourses, state), { decimals });
  const cumulativeSummary = summariseRows(evaluateAll(cumulativeCourses, state), { decimals });

  return {
    addressee: formatFullName(student),
    name: formatShortName(student),
    regNo: normaliseRegNo(student?.regNo),
    yearOfStudy: formatYearOfStudy(yearOfStudy, programmeYears),
    gender: student?.gender ?? '',
    session: formatSession(session),
    hod: formatHod(hod),
    semesters: [
      { label: 'FIRST SEMESTER', rows: rowsFor(firstSemester) },
      { label: 'SECOND SEMESTER', rows: rowsFor(secondSemester) },
    ],
    gpa: formatGpa(sessionSummary.gpa, decimals),
    cgpa: formatGpa(cumulativeSummary.gpa, decimals),
    gpaUnits: sessionSummary.units,
    gpaPoints: sessionSummary.points,
    cgpaUnits: cumulativeSummary.units,
    cgpaPoints: cumulativeSummary.points,
  };
}

/** Everything that must be right before a statement can be produced. */
export function transcriptProblems({ student, hod, session, yearOfStudy, firstSemester = [], secondSemester = [] }) {
  const out = [
    ...nameProblems(student),
    ...hodProblems(hod),
  ];
  const reg = regNoProblem(student?.regNo);
  if (reg) out.push(reg);
  const gen = genderProblem(student?.gender);
  if (gen) out.push(gen);
  const ses = sessionProblem(session);
  if (ses) out.push(ses);
  if (!Number.isInteger(Number(yearOfStudy)) || Number(yearOfStudy) < 1) {
    out.push('Choose the year of study this statement covers.');
  }
  if (firstSemester.length === 0 && secondSemester.length === 0) {
    out.push('Tick at least one course for this session.');
  }
  return out;
}
