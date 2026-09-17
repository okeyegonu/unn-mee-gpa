/**
 * curriculum.js — turns the curriculum *data* into a flat, indexed course list.
 *
 * The GPA engine never sees the nested year/semester/group shape; it only ever
 * sees a flat array of course records. That is what keeps year and semester
 * purely presentational.
 */

/**
 * How many sittings a course allows in total.
 *
 * A course first taken in year x may be repeated in each remaining year up to
 * the programme maximum, so a course of year x allows (max - x) repeats and
 * therefore (max - x + 1) sittings altogether.
 *
 * This is resolved here, while the curriculum is being flattened, so that the
 * GPA engine can read `course.maxAttempts` without ever looking at the year.
 */
export function maxAttemptsForYear(year, progression) {
  const max = progression?.maximum_years_to_graduate;
  if (!Number.isFinite(max) || !Number.isFinite(year)) return 1;
  return Math.max(1, max - year + 1);
}

/** Stable unique id for a course: year + semester + course code. */
export function courseId(year, semester, code) {
  return `y${year}s${semester}-${String(code).replace(/\s+/g, '').toUpperCase()}`;
}

/**
 * Flatten a curriculum document into course records.
 * Year / semester / group are carried along as *metadata only*.
 */
export function flattenCurriculum(doc) {
  const out = [];
  let order = 0;
  const progression = doc.progression ?? null;
  // Shared by every course, and resolved here so that the GPA engine can decide
  // whether a sitting was a failure without knowing anything about the data file.
  const failingGrades = Object.freeze(
    Array.isArray(progression?.failing_grades) && progression.failing_grades.length > 0
      ? progression.failing_grades.map((g) => String(g).toUpperCase())
      : ['F'],
  );
  for (const year of doc.years ?? []) {
    for (const sem of year.semesters ?? []) {
      for (const group of sem.groups ?? []) {
        for (const c of group.courses ?? []) {
          out.push({
            id: courseId(year.year, sem.semester, c.code),
            code: c.code,
            title: c.title ?? null,
            titleUnknown: c.title_unknown === true || c.title == null,
            units: Number.isFinite(c.units) ? c.units : null,
            unitsUnknown: c.units_unknown === true || !Number.isFinite(c.units),
            category: c.category ?? null,
            year: year.year,
            yearLabel: year.label,
            semester: sem.semester,
            semesterLabel: sem.label,
            groupId: group.group_id,
            groupLabel: group.label,
            groupType: group.type,
            groupChoose: group.choose ?? null,
            groupNote: group.note ?? null,
            legacyCode: c.legacy_code ?? null,
            legacyUnits: c.legacy_units ?? null,
            notes: c.notes ?? null,
            sourceId: sem.source_id ?? null,
            maxAttempts: maxAttemptsForYear(year.year, progression),
            failingGrades,
            order: order++,
          });
        }
      }
    }
  }
  return out;
}

/** Map of id -> course, for O(1) lookup. */
export function indexCourses(courses) {
  const m = new Map();
  for (const c of courses) m.set(c.id, c);
  return m;
}

/** Distinct semester keys in curriculum order, for grouped display. */
export function semesterKeys(doc) {
  const keys = [];
  for (const year of doc.years ?? []) {
    for (const sem of year.semesters ?? []) {
      keys.push({ year: year.year, yearLabel: year.label, semester: sem.semester, semesterLabel: sem.label });
    }
  }
  return keys;
}

/**
 * Structural validation of a curriculum document.
 * Returns { errors, warnings, info } — arrays of human-readable strings.
 */
export function validateCurriculum(doc) {
  const errors = [];
  const warnings = [];
  const info = [];

  for (const field of ['curriculum_version', 'institution', 'programme', 'grade_scale', 'years']) {
    if (doc[field] === undefined) errors.push(`Missing top-level field: ${field}`);
  }

  const courses = flattenCurriculum(doc);
  if (courses.length === 0) errors.push('Curriculum contains no courses.');

  // Duplicate ids (same year + semester + code twice).
  const seenIds = new Map();
  for (const c of courses) {
    if (seenIds.has(c.id)) {
      errors.push(`Duplicate course id ${c.id} (${c.code}) in ${c.yearLabel} / ${c.semesterLabel}.`);
    } else {
      seenIds.set(c.id, c);
    }
  }

  // Course code repeated anywhere else in the programme.
  const byCode = new Map();
  for (const c of courses) {
    if (!byCode.has(c.code)) byCode.set(c.code, []);
    byCode.get(c.code).push(c);
  }
  for (const [code, list] of byCode) {
    if (list.length > 1) {
      const where = list.map((c) => `Y${c.year}S${c.semester}`).join(', ');
      warnings.push(`Course code ${code} appears ${list.length} times (${where}).`);
    }
  }

  // Course code shape: three letters, space, three digits.
  const codeShape = /^[A-Z]{3} \d{3}$/;
  for (const c of courses) {
    if (!codeShape.test(c.code)) warnings.push(`Malformed course code: "${c.code}" (${c.yearLabel} / ${c.semesterLabel}).`);
  }

  // Units.
  for (const c of courses) {
    if (c.unitsUnknown) {
      warnings.push(`Missing unit load: ${c.code} (${c.yearLabel} / ${c.semesterLabel}). ${c.notes ?? ''}`.trim());
    } else if (c.units === 0) {
      warnings.push(`Zero-unit course: ${c.code} (${c.yearLabel} / ${c.semesterLabel}).`);
    } else if (!Number.isInteger(c.units) || c.units < 0 || c.units > 12) {
      warnings.push(`Unusual unit load ${c.units} for ${c.code} (${c.yearLabel} / ${c.semesterLabel}).`);
    }
  }

  // Missing titles.
  for (const c of courses) {
    if (c.titleUnknown) warnings.push(`Missing course title: ${c.code} (${c.yearLabel} / ${c.semesterLabel}).`);
  }

  // Year / semester consistency.
  for (const year of doc.years ?? []) {
    const sems = (year.semesters ?? []).map((s) => s.semester);
    if (sems.length !== 2 || sems[0] !== 1 || sems[1] !== 2) {
      warnings.push(`${year.label} does not have exactly First and Second semesters (found: ${sems.join(', ')}).`);
    }
  }
  const years = (doc.years ?? []).map((y) => y.year);
  for (let i = 0; i < years.length; i++) {
    if (years[i] !== i + 1) { warnings.push(`Year numbering is not 1..n (found: ${years.join(', ')}).`); break; }
  }

  // Declared semester totals vs. the sum of the courses actually listed.
  for (const year of doc.years ?? []) {
    for (const sem of year.semesters ?? []) {
      const here = courses.filter((c) => c.year === year.year && c.semester === sem.semester);
      const compulsory = here.filter((c) => c.groupType !== 'elective');
      const unknown = here.filter((c) => c.unitsUnknown);
      const compulsorySum = compulsory.reduce((a, c) => a + (c.units ?? 0), 0);

      let electiveUnits = 0;
      const electiveGroups = (sem.groups ?? []).filter((g) => g.type === 'elective');
      const seenGroupLabels = new Set();
      for (const g of electiveGroups) {
        // Alternative option areas: count one option's requirement, not all of them.
        if (seenGroupLabels.size === 0) electiveUnits = g.choose_units ?? 0;
        seenGroupLabels.add(g.label);
      }

      const expected = sem.stated_total_units;
      if (expected == null) {
        info.push(`${year.label} / ${sem.label}: no total unit load is stated in the source; cannot cross-check.`);
      } else if (unknown.length > 0) {
        info.push(`${year.label} / ${sem.label}: ${unknown.length} course(s) have no unit load, so the stated total of ${expected} cannot be cross-checked.`);
      } else {
        const computed = compulsorySum + electiveUnits;
        if (computed !== expected) {
          errors.push(`${year.label} / ${sem.label}: units sum to ${computed} but the source states ${expected}.`);
        } else {
          info.push(`${year.label} / ${sem.label}: units sum to ${computed}, matching the stated total.`);
        }
      }
    }
  }

  return { errors, warnings, info, courses };
}
