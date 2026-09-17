/**
 * Persistence and idempotency tests — section 14 of the specification.
 *
 * A "browser reload" is simulated by throwing away the repository object and
 * constructing a fresh one over the *same* backend, exactly as a page reload
 * throws away the JavaScript heap but not localStorage.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ResultsRepository, MemoryBackend, STORAGE_KEY } from '../src/storage.js';
import { emptyState, setGrade, setUnitOverride, summarise } from '../src/gpa-engine.js';

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
