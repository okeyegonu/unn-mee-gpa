/**
 * Persistence and idempotency tests — section 14 of the specification.
 *
 * A "browser reload" is simulated by throwing away the repository object and
 * constructing a fresh one over the *same* backend, exactly as a page reload
 * throws away the JavaScript heap but not localStorage.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ResultsRepository, MemoryBackend, PreferencesStore, STORAGE_KEY, PREFS_KEY } from '../src/storage.js';
import { emptyState, setGrade, setAttempt, setUnitOverride, summarise } from '../src/gpa-engine.js';

const CID = 'unn-mee-beng-5yr';
const V = '2023.1';

const C = (id, units) => ({ id, code: id, title: id, units, year: 1, semester: 1 });
const COURSES = [C('y1s1-MTH101', 2), C('y1s1-CHM101', 2), C('y2s1-MEE211', 2), C('y3s1-MEE313', 3)];

/** A fresh repository over an existing backend == a browser reload. */
const reload = (backend, version = V) =>
  new ResultsRepository({ backend, curriculumId: CID, curriculumVersion: version });

test('section 14 — the full enter / reload / modify / reload / add / reload sequence', async () => {
  const backend = new MemoryBackend();

  // 1. Enter three grades.
  let repo = reload(backend);
  let state = (await repo.load()).state;
  state = setGrade(state, 'y1s1-MTH101', 'A');
  state = setGrade(state, 'y1s1-CHM101', 'B');
  state = setGrade(state, 'y2s1-MEE211', 'C');
  await repo.save(state);

  // 2 & 3. Reload; the same three grades reappear.
  repo = reload(backend);
  let loaded = await repo.load();
  assert.equal(loaded.found, true);
  assert.deepEqual(loaded.state.grades, {
    'y1s1-MTH101': 'A', 'y1s1-CHM101': 'B', 'y2s1-MEE211': 'C',
  });
  assert.equal(Object.keys(loaded.state.grades).length, 3, 'exactly three records');

  // 4. Modify one grade.
  state = setGrade(loaded.state, 'y1s1-CHM101', 'A');
  await repo.save(state);

  // 5 & 6. Reload; the modification has replaced the previous value.
  repo = reload(backend);
  loaded = await repo.load();
  assert.equal(loaded.state.grades['y1s1-CHM101'], 'A', 'B must have been replaced by A');
  assert.equal(Object.keys(loaded.state.grades).length, 3, 'still three, not four');

  // 7. Add another grade.
  state = setGrade(loaded.state, 'y3s1-MEE313', 'F');
  await repo.save(state);

  // 8 & 9. Reload; exactly four active course records exist.
  repo = reload(backend);
  loaded = await repo.load();
  assert.equal(Object.keys(loaded.state.grades).length, 4, 'exactly four active course records');
  assert.deepEqual(loaded.state.grades, {
    'y1s1-MTH101': 'A', 'y1s1-CHM101': 'A', 'y2s1-MEE211': 'C', 'y3s1-MEE313': 'F',
  });

  // And the GPA recomputed from the reloaded state is the expected one.
  // 2xA=10, 2xA=10, 2xC=6, 3xF=0  ->  26 points / 9 units
  const r = summarise(COURSES, loaded.state);
  assert.equal(r.gradedCourses, 4);
  assert.equal(r.units, 9);
  assert.equal(r.points, 26);
  assert.equal(r.gpaText, '2.89');
});

test('repeated saves of the same state are idempotent — no duplicates accumulate', async () => {
  const backend = new MemoryBackend();
  const repo = reload(backend);
  let state = (await repo.load()).state;
  state = setGrade(state, 'y1s1-MTH101', 'A');
  state = setGrade(state, 'y1s1-CHM101', 'B');

  for (let i = 0; i < 25; i++) await repo.save(state);

  const env = JSON.parse(backend.getItem(STORAGE_KEY));
  assert.equal(Object.keys(env.records).length, 1, 'one record per curriculum version');
  const rec = env.records[`${CID}@${V}`];
  assert.equal(Object.keys(rec.grades).length, 2, 'two grade entries, not fifty');
  assert.deepEqual(rec.grades, { 'y1s1-MTH101': 'A', 'y1s1-CHM101': 'B' });

  // Only `saved_at` may differ between two consecutive saves.
  const before = JSON.parse(backend.getItem(STORAGE_KEY));
  await repo.save(state);
  const after = JSON.parse(backend.getItem(STORAGE_KEY));
  delete before.records[`${CID}@${V}`].saved_at;
  delete after.records[`${CID}@${V}`].saved_at;
  assert.deepEqual(after, before);
});

test('setting the same course twice overwrites rather than appends', async () => {
  const backend = new MemoryBackend();
  const repo = reload(backend);
  let state = (await repo.load()).state;
  for (const g of ['C', 'D', 'B', 'A']) {
    state = setGrade(state, 'y1s1-MTH101', g);
    await repo.save(state);
  }
  const loaded = await reload(backend).load();
  assert.equal(Object.keys(loaded.state.grades).length, 1);
  assert.equal(loaded.state.grades['y1s1-MTH101'], 'A');
});

test('clearing a grade survives a reload as an absence, not as a stale value', async () => {
  const backend = new MemoryBackend();
  let repo = reload(backend);
  let state = (await repo.load()).state;
  state = setGrade(state, 'y1s1-MTH101', 'A');
  state = setGrade(state, 'y1s1-CHM101', 'B');
  await repo.save(state);

  state = setGrade(state, 'y1s1-CHM101', '');
  await repo.save(state);

  repo = reload(backend);
  const loaded = await repo.load();
  assert.deepEqual(loaded.state.grades, { 'y1s1-MTH101': 'A' });
  assert.equal(summarise(COURSES, loaded.state).gpaText, '5.00');
});

test('student-supplied unit loads persist alongside grades', async () => {
  const backend = new MemoryBackend();
  const repo = reload(backend);
  let state = (await repo.load()).state;
  state = setGrade(state, 'y1s2-PHY104', 'A');
  state = setUnitOverride(state, 'y1s2-PHY104', 2);
  await repo.save(state);

  const loaded = await reload(backend).load();
  assert.deepEqual(loaded.state.unitOverrides, { 'y1s2-PHY104': 2 });
});

test('a new curriculum version does not overwrite results saved under the old one', async () => {
  const backend = new MemoryBackend();

  const oldRepo = reload(backend, '2023.1');
  let oldState = (await oldRepo.load()).state;
  oldState = setGrade(oldState, 'y1s1-MTH101', 'A');
  await oldRepo.save(oldState);

  // The department publishes a corrected curriculum.
  const newRepo = reload(backend, '2024.1');
  const fresh = await newRepo.load();
  assert.equal(fresh.found, false, 'the new version starts empty');
  assert.equal(fresh.otherVersions.length, 1);
  assert.equal(fresh.otherVersions[0].curriculum_version, '2023.1');
  assert.equal(fresh.otherVersions[0].entries, 1);

  // The old results are still exactly where they were.
  assert.deepEqual((await reload(backend, '2023.1').load()).state.grades, { 'y1s1-MTH101': 'A' });

  // The student may explicitly carry them forward.
  const carried = await newRepo.adoptFrom(fresh.otherVersions[0].key);
  assert.deepEqual(carried.grades, { 'y1s1-MTH101': 'A' });
  assert.deepEqual((await reload(backend, '2023.1').load()).state.grades, { 'y1s1-MTH101': 'A' },
    'carrying forward must not disturb the old record');
});

test('resetting one curriculum version leaves other versions intact', async () => {
  const backend = new MemoryBackend();
  const a = reload(backend, '2023.1');
  const b = reload(backend, '2024.1');
  await a.save(setGrade(emptyState(), 'x', 'A'));
  await b.save(setGrade(emptyState(), 'y', 'B'));

  await b.clear();
  assert.deepEqual((await reload(backend, '2023.1').load()).state.grades, { x: 'A' });
  assert.equal((await reload(backend, '2024.1').load()).found, false);
});

test('corrupt or foreign storage contents degrade to an empty state', async () => {
  for (const junk of ['', 'not json', '[]', '{"records":null}', 'null', '{"unexpected":1}']) {
    const backend = new MemoryBackend({ [STORAGE_KEY]: junk });
    const loaded = await reload(backend).load();
    assert.deepEqual(loaded.state.grades, {}, `junk: ${junk}`);
    assert.equal(loaded.found, false);
  }
});

test('export produces a portable payload that import round-trips exactly', async () => {
  const backend = new MemoryBackend();
  const repo = reload(backend);
  let state = (await repo.load()).state;
  state = setGrade(state, 'y1s1-MTH101', 'A');
  state = setGrade(state, 'y3s1-MEE313', 'F');
  state = setUnitOverride(state, 'y1s2-PHY104', 2);
  await repo.save(state);

  const payload = await repo.exportPayload(state);
  assert.equal(payload.curriculum_version, V);
  assert.ok(payload.exported_at, 'export carries a timestamp');
  assert.deepEqual(payload.grades, { 'y1s1-MTH101': 'A', 'y3s1-MEE313': 'F' });

  // Round-trip through JSON, as a real file would.
  const round = repo.parseImport(JSON.parse(JSON.stringify(payload)));
  assert.equal(round.versionMismatch, false);
  assert.deepEqual(round.state.grades, state.grades);
  assert.deepEqual(round.state.unitOverrides, state.unitOverrides);
});

test('import rejects a file that is not an export of this calculator', async () => {
  const repo = reload(new MemoryBackend());
  assert.throws(() => repo.parseImport({ hello: 'world' }), /not an export/);
  assert.throws(() => repo.parseImport(null), /JSON object/);
  assert.throws(() => repo.parseImport({ format: 'unn-mee-gpa-calculator-export' }), /grades/);
});

test('import from a different curriculum version is flagged, not silently accepted', async () => {
  const repo = reload(new MemoryBackend(), '2024.1');
  const round = repo.parseImport({
    format: 'unn-mee-gpa-calculator-export',
    curriculum_version: '2023.1',
    grades: { 'y1s1-MTH101': 'A' },
  });
  assert.equal(round.versionMismatch, true);
  assert.equal(round.importedVersion, '2023.1');
});

/* ---- display preferences: kept apart from academic results ---- */

test('a display preference persists across a reload', async () => {
  const backend = new MemoryBackend();
  new PreferencesStore({ backend }).set('fullPrecision', true);
  assert.equal(new PreferencesStore({ backend }).get('fullPrecision'), true);
  new PreferencesStore({ backend }).set('fullPrecision', false);
  assert.equal(new PreferencesStore({ backend }).get('fullPrecision'), false);
});

test('an unset preference falls back to the supplied default', () => {
  const prefs = new PreferencesStore({ backend: new MemoryBackend() });
  assert.equal(prefs.get('fullPrecision', false), false);
  assert.equal(prefs.get('neverSet', 'fallback'), 'fallback');
  assert.equal(prefs.get('neverSet'), undefined);
});

test('setting one preference leaves the others alone', () => {
  const backend = new MemoryBackend();
  const prefs = new PreferencesStore({ backend });
  prefs.set('fullPrecision', true);
  prefs.set('somethingElse', 'x');
  prefs.set('fullPrecision', false);
  assert.deepEqual(prefs.read(), { fullPrecision: false, somethingElse: 'x' });
});

test('preferences never leak into the results record or an export', async () => {
  const backend = new MemoryBackend();
  new PreferencesStore({ backend }).set('fullPrecision', true);

  const repo = new ResultsRepository({ backend, curriculumId: CID, curriculumVersion: V });
  const state = setGrade((await repo.load()).state, 'y1s1-MTH101', 'A');
  await repo.save(state);

  const record = JSON.parse(backend.getItem(STORAGE_KEY)).records[`${CID}@${V}`];
  assert.deepEqual(Object.keys(record).sort(),
    ['curriculum_id', 'curriculum_version', 'grades', 'repeats', 'saved_at', 'unitOverrides']);
  assert.ok(!('fullPrecision' in record));

  const payload = await repo.exportPayload(state);
  assert.ok(!('fullPrecision' in payload), 'an export carries results, not screen settings');
});

test('clearing results does not clear display preferences, and vice versa', async () => {
  const backend = new MemoryBackend();
  const prefs = new PreferencesStore({ backend });
  prefs.set('fullPrecision', true);
  const repo = new ResultsRepository({ backend, curriculumId: CID, curriculumVersion: V });
  await repo.save(setGrade(emptyState(), 'y1s1-MTH101', 'A'));

  await repo.clear();
  assert.equal(prefs.get('fullPrecision'), true, 'a results reset keeps the screen setting');

  await repo.save(setGrade(emptyState(), 'y1s1-MTH101', 'B'));
  prefs.clear();
  assert.deepEqual((await repo.load()).state.grades, { 'y1s1-MTH101': 'B' },
    'clearing preferences keeps the results');
});

test('preferences degrade quietly when storage is unusable', () => {
  const hostile = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceededError'); },
    removeItem() { throw new Error('SecurityError'); },
  };
  const prefs = new PreferencesStore({ backend: hostile });
  assert.deepEqual(prefs.read(), {}, 'a blocked read yields defaults, not a crash');
  assert.equal(prefs.get('fullPrecision', false), false);
  assert.doesNotThrow(() => prefs.set('fullPrecision', true));
  assert.doesNotThrow(() => prefs.clear());
});

test('corrupt preference data is ignored rather than fatal', () => {
  for (const junk of ['not json', '[]', 'null', '"a string"', '']) {
    const prefs = new PreferencesStore({ backend: new MemoryBackend({ [PREFS_KEY]: junk }) });
    assert.deepEqual(prefs.read(), {}, `junk: ${junk}`);
  }
});

/* ---- repeat sittings must persist exactly like first sittings ---- */

test('repeat sittings survive a reload', async () => {
  const backend = new MemoryBackend();
  const course = { id: 'y3s1-MEE313', units: 3, maxAttempts: 6 };

  let repo = reload(backend);
  let state = (await repo.load()).state;
  state = setGrade(state, course.id, 'F');
  state = setAttempt(state, course, 1, 'F');
  state = setAttempt(state, course, 2, 'B');
  await repo.save(state);

  repo = reload(backend);
  const loaded = await repo.load();
  assert.deepEqual(loaded.state.grades, { 'y3s1-MEE313': 'F' }, 'first sitting stays in grades');
  assert.deepEqual(loaded.state.repeats, { 'y3s1-MEE313': ['F', 'B'] }, 'repeats stored separately');

  // 3x0 + 3x0 + 3x4 = 12 over 9 units
  const r = summarise([course], loaded.state);
  assert.equal(r.attempts, 3);
  assert.equal(r.units, 9);
  assert.equal(r.points, 12);
  assert.equal(r.gpaText, '1.33');
});

test('repeat sittings are idempotent across repeated saves', async () => {
  const backend = new MemoryBackend();
  const course = { id: 'c1', units: 3, maxAttempts: 6 };
  const repo = reload(backend);
  let state = setGrade((await repo.load()).state, 'c1', 'F');
  state = setAttempt(state, course, 1, 'B');

  for (let i = 0; i < 20; i++) await repo.save(state);

  const rec = JSON.parse(backend.getItem(STORAGE_KEY)).records[`${CID}@${V}`];
  assert.deepEqual(rec.repeats, { c1: ['B'] }, 'one entry, not twenty');
  assert.equal(Object.keys(rec.grades).length, 1);
});

test('a record saved before repeats existed still loads', async () => {
  // Exactly the shape the first shipped version wrote.
  const legacy = {
    schema_version: 1,
    active: `${CID}@${V}`,
    records: {
      [`${CID}@${V}`]: {
        curriculum_id: CID, curriculum_version: V, saved_at: '2026-09-17T20:00:00.000Z',
        grades: { 'y1s1-MTH101': 'A', 'y3s1-MEE313': 'F' },
        unitOverrides: {},
      },
    },
  };
  const backend = new MemoryBackend({ [STORAGE_KEY]: JSON.stringify(legacy) });
  const loaded = await reload(backend).load();
  assert.equal(loaded.found, true);
  assert.deepEqual(loaded.state.grades, { 'y1s1-MTH101': 'A', 'y3s1-MEE313': 'F' });
  assert.deepEqual(loaded.state.repeats, {}, 'no repeats, and no crash');

  // and a repeat can then be added on top of it
  const course = { id: 'y3s1-MEE313', units: 3, maxAttempts: 6 };
  const repo = reload(backend);
  await repo.save(setAttempt(loaded.state, course, 1, 'C'));
  assert.deepEqual((await reload(backend).load()).state.repeats, { 'y3s1-MEE313': ['C'] });
});

test('malformed repeat data is dropped rather than trusted', async () => {
  const hostile = {
    schema_version: 1,
    records: {
      [`${CID}@${V}`]: {
        curriculum_id: CID, curriculum_version: V,
        grades: { c1: 'A' },
        repeats: { c1: ['B', 42, null, {}, 'C'], c2: 'not an array', c3: [] },
        unitOverrides: {},
      },
    },
  };
  const backend = new MemoryBackend({ [STORAGE_KEY]: JSON.stringify(hostile) });
  const loaded = await reload(backend).load();
  assert.deepEqual(loaded.state.repeats, { c1: ['B', 'C'] },
    'non-strings dropped, non-array entries dropped, empty lists dropped');
});

test('an export carries repeat sittings and imports them back', async () => {
  const backend = new MemoryBackend();
  const course = { id: 'c1', units: 3, maxAttempts: 6 };
  const repo = reload(backend);
  let state = setGrade((await repo.load()).state, 'c1', 'F');
  state = setAttempt(state, course, 1, 'B');
  await repo.save(state);

  const payload = await repo.exportPayload(state);
  assert.deepEqual(payload.repeats, { c1: ['B'] });

  const round = repo.parseImport(JSON.parse(JSON.stringify(payload)));
  assert.deepEqual(round.state.repeats, { c1: ['B'] });
  assert.equal(summarise([course], round.state).units, 6);
});

test('an export from before repeats existed imports cleanly', () => {
  const repo = reload(new MemoryBackend());
  const round = repo.parseImport({
    format: 'unn-mee-gpa-calculator-export',
    curriculum_version: V,
    grades: { c1: 'A' },
  });
  assert.deepEqual(round.state.repeats, {});
});

test('clearing results clears repeats too', async () => {
  const backend = new MemoryBackend();
  const course = { id: 'c1', units: 3, maxAttempts: 6 };
  const repo = reload(backend);
  let state = setGrade((await repo.load()).state, 'c1', 'F');
  state = setAttempt(state, course, 1, 'B');
  await repo.save(state);
  await repo.clear();
  const loaded = await reload(backend).load();
  assert.deepEqual(loaded.state.grades, {});
  assert.deepEqual(loaded.state.repeats, {});
});

/* ---- the stored record of sittings is itself idempotent ---- */

test('saving a repeated course many times never grows its record', async () => {
  const backend = new MemoryBackend();
  const course = { id: 'c1', units: 3, maxAttempts: 8, failingGrades: ['F'] };
  const repo = reload(backend);

  let state = setGrade((await repo.load()).state, 'c1', 'F');
  state = setAttempt(state, course, 1, 'F');
  state = setAttempt(state, course, 2, 'B');

  for (let i = 0; i < 30; i++) await repo.save(state);

  const rec = JSON.parse(backend.getItem(STORAGE_KEY)).records[`${CID}@${V}`];
  assert.deepEqual(rec.grades, { c1: 'F' });
  assert.deepEqual(rec.repeats, { c1: ['F', 'B'] }, 'two repeats, not sixty');
});

test('a save / reload / save cycle is a fixed point', async () => {
  const backend = new MemoryBackend();
  const course = { id: 'c1', units: 3, maxAttempts: 8, failingGrades: ['F'] };
  let repo = reload(backend);
  let state = setGrade((await repo.load()).state, 'c1', 'F');
  state = setAttempt(state, course, 1, 'F');
  await repo.save(state);

  const shapes = new Set();
  for (let i = 0; i < 5; i++) {
    repo = reload(backend);
    const loaded = await repo.load();
    await repo.save(loaded.state);
    const rec = JSON.parse(backend.getItem(STORAGE_KEY)).records[`${CID}@${V}`];
    shapes.add(JSON.stringify({ grades: rec.grades, repeats: rec.repeats }));
  }
  assert.equal(shapes.size, 1, 'the record never drifts across load/save rounds');
  assert.equal([...shapes][0], '{"grades":{"c1":"F"},"repeats":{"c1":["F"]}}');
});

test('importing the same file twice does not double the sittings', async () => {
  const backend = new MemoryBackend();
  const course = { id: 'c1', units: 3, maxAttempts: 8, failingGrades: ['F'] };
  const repo = reload(backend);
  let state = setGrade((await repo.load()).state, 'c1', 'F');
  state = setAttempt(state, course, 1, 'F');
  state = setAttempt(state, course, 2, 'C');
  const payload = JSON.parse(JSON.stringify(await repo.exportPayload(state)));

  const once = repo.parseImport(payload).state;
  const twice = repo.parseImport(JSON.parse(JSON.stringify(payload))).state;
  assert.deepEqual(once.repeats, { c1: ['F', 'C'] });
  assert.deepEqual(twice.repeats, once.repeats, 'importing again is the same record, not more of it');

  await repo.save(once);
  await repo.save(twice);
  const rec = JSON.parse(backend.getItem(STORAGE_KEY)).records[`${CID}@${V}`];
  assert.deepEqual(rec.repeats, { c1: ['F', 'C'] });
});

test('blank and non-string entries never reach the stored record', async () => {
  const backend = new MemoryBackend();
  const repo = reload(backend);
  await repo.save({
    grades: { c1: 'F' },
    repeats: { c1: ['', '   ', 'F', null, 7, 'B'] },
    unitOverrides: {},
  });
  const rec = JSON.parse(backend.getItem(STORAGE_KEY)).records[`${CID}@${V}`];
  assert.deepEqual(rec.repeats, { c1: ['F', 'B'] });
});
