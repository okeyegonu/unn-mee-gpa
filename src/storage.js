/**
 * storage.js — persistence, isolated behind a small async repository interface.
 *
 * The interface is intentionally async even though localStorage is synchronous,
 * so that a server-backed repository can be substituted later without touching
 * the GPA engine or the UI's call sites.
 *
 * Shape written to the backend (a single key, rewritten in place):
 *
 *   {
 *     schema_version: 1,
 *     active: "unn-mee-beng-5yr@2023.1",
 *     records: {
 *       "unn-mee-beng-5yr@2023.1": {
 *         curriculum_id, curriculum_version, saved_at,
 *         grades:        { "<courseId>": "A", ... },
 *         unitOverrides: { "<courseId>": 2,  ... }
 *       }
 *     }
 *   }
 *
 * Results are keyed by curriculum id + version, so publishing a new curriculum
 * version cannot overwrite or corrupt results saved under the previous one.
 *
 * Every write is an UPSERT into `records[key]` and into the `grades` object
 * inside it. There is no array anywhere in the persisted shape, so repeating a
 * save can never append a duplicate course record or duplicate grade entry.
 */

export const STORAGE_KEY = 'unn-mee-gpa-calculator';
export const SCHEMA_VERSION = 1;

/** In-memory backend with the Web Storage surface. Used by the tests. */
export class MemoryBackend {
  constructor(initial = {}) { this.map = new Map(Object.entries(initial)); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  get length() { return this.map.size; }
}

/** Backend that silently degrades to memory when localStorage is unavailable. */
export function defaultBackend() {
  try {
    const probe = '__gpa_probe__';
    globalThis.localStorage.setItem(probe, '1');
    globalThis.localStorage.removeItem(probe);
    return globalThis.localStorage;
  } catch {
    return new MemoryBackend();
  }
}

/**
 * Copy the repeat-sittings map defensively.
 *
 * Each entry is an array of the grades earned at the second and later sittings
 * of a course. Anything that is not an array of strings is dropped rather than
 * trusted, so a hand-edited or truncated file cannot inject odd values into the
 * calculation. A record saved before repeats existed simply has none.
 */
function cloneRepeats(source) {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const [id, list] of Object.entries(source)) {
    if (!Array.isArray(list)) continue;
    const clean = list.filter((g) => typeof g === 'string');
    if (clean.length > 0) out[id] = clean;
  }
  return out;
}

function recordKey(curriculumId, curriculumVersion) {
  return `${curriculumId}@${curriculumVersion}`;
}

function emptyEnvelope() {
  return { schema_version: SCHEMA_VERSION, active: null, records: {} };
}

export class ResultsRepository {
  /**
   * @param {object} opts
   * @param {object} [opts.backend]  Web Storage-like object.
   * @param {string} opts.curriculumId
   * @param {string} opts.curriculumVersion
   * @param {string} [opts.key]      Backend key to use.
   */
  constructor({ backend, curriculumId, curriculumVersion, key = STORAGE_KEY } = {}) {
    this.backend = backend ?? defaultBackend();
    this.curriculumId = curriculumId;
    this.curriculumVersion = curriculumVersion;
    this.key = key;
  }

  get recordKey() { return recordKey(this.curriculumId, this.curriculumVersion); }

  /** Read and repair the whole envelope. Never throws on corrupt data. */
  readEnvelope() {
    const raw = this.backend.getItem(this.key);
    if (!raw) return emptyEnvelope();
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return emptyEnvelope(); }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.records !== 'object' || parsed.records === null) {
      return emptyEnvelope();
    }
    return { schema_version: parsed.schema_version ?? SCHEMA_VERSION, active: parsed.active ?? null, records: parsed.records };
  }

  writeEnvelope(env) {
    this.backend.setItem(this.key, JSON.stringify(env));
  }

  /**
   * Load the state for this curriculum version.
   * Returns { state, found, otherVersions } — `otherVersions` lists results
   * saved under a different curriculum version, which are left untouched.
   */
  async load() {
    const env = this.readEnvelope();
    const rec = env.records[this.recordKey];
    const otherVersions = Object.keys(env.records)
      .filter((k) => k !== this.recordKey)
      .map((k) => ({
        key: k,
        curriculum_version: env.records[k]?.curriculum_version ?? k.split('@')[1] ?? null,
        saved_at: env.records[k]?.saved_at ?? null,
        entries: Object.keys(env.records[k]?.grades ?? {}).length,
      }));

    const state = {
      curriculumVersion: this.curriculumVersion,
      grades: { ...(rec?.grades ?? {}) },
      repeats: cloneRepeats(rec?.repeats),
      unitOverrides: { ...(rec?.unitOverrides ?? {}) },
    };
    return { state, found: Boolean(rec), savedAt: rec?.saved_at ?? null, otherVersions };
  }

  /**
   * UPSERT the state for this curriculum version.
   * Idempotent: saving the same state twice leaves an identical envelope apart
   * from `saved_at`, and never creates a second record for the same course.
   */
  async save(state) {
    const env = this.readEnvelope();
    env.schema_version = SCHEMA_VERSION;
    env.active = this.recordKey;
    env.records[this.recordKey] = {
      curriculum_id: this.curriculumId,
      curriculum_version: this.curriculumVersion,
      saved_at: new Date().toISOString(),
      grades: { ...(state.grades ?? {}) },
      repeats: cloneRepeats(state.repeats),
      unitOverrides: { ...(state.unitOverrides ?? {}) },
    };
    this.writeEnvelope(env);
    return env.records[this.recordKey];
  }

  /** Delete only this curriculum version's results; other versions survive. */
  async clear() {
    const env = this.readEnvelope();
    delete env.records[this.recordKey];
    if (env.active === this.recordKey) env.active = null;
    this.writeEnvelope(env);
  }

  /** Copy results saved under another curriculum version into this one. */
  async adoptFrom(otherKey) {
    const env = this.readEnvelope();
    const src = env.records[otherKey];
    if (!src) return null;
    const state = {
      curriculumVersion: this.curriculumVersion,
      grades: { ...(src.grades ?? {}) },
      repeats: cloneRepeats(src.repeats),
      unitOverrides: { ...(src.unitOverrides ?? {}) },
    };
    await this.save(state);
    return state;
  }

  /** Portable export payload (section 15). */
  async exportPayload(state, extra = {}) {
    return {
      format: 'unn-mee-gpa-calculator-export',
      format_version: 1,
      curriculum_id: this.curriculumId,
      curriculum_version: this.curriculumVersion,
      exported_at: new Date().toISOString(),
      grades: { ...(state.grades ?? {}) },
      repeats: cloneRepeats(state.repeats),
      unitOverrides: { ...(state.unitOverrides ?? {}) },
      ...extra,
    };
  }

  /**
   * Validate and convert an imported payload into a state object.
   * Throws on a payload that is not recognisably an export of this calculator.
   */
  parseImport(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('The file does not contain a JSON object.');
    if (payload.format !== 'unn-mee-gpa-calculator-export') {
      throw new Error('This file is not an export from the UNN MEE GPA calculator.');
    }
    if (!payload.grades || typeof payload.grades !== 'object') {
      throw new Error('The export contains no "grades" object.');
    }
    const versionMismatch =
      payload.curriculum_version != null && payload.curriculum_version !== this.curriculumVersion;
    return {
      state: {
        curriculumVersion: this.curriculumVersion,
        grades: { ...payload.grades },
        repeats: cloneRepeats(payload.repeats),
        unitOverrides: { ...(payload.unitOverrides ?? {}) },
      },
      versionMismatch,
      importedVersion: payload.curriculum_version ?? null,
      exportedAt: payload.exported_at ?? null,
    };
  }
}

/**
 * Display preferences — separate from results, on purpose.
 *
 * A preference like "show full precision" is about this viewer's screen, not
 * about their academic record. Keeping it under its own key means it is never
 * swept into an export, never carried between students by an imported file, and
 * never versioned against the curriculum. Losing it costs nothing.
 */
export const PREFS_KEY = 'unn-mee-gpa-calculator:prefs';

export class PreferencesStore {
  constructor({ backend, key = PREFS_KEY } = {}) {
    this.backend = backend ?? defaultBackend();
    this.key = key;
  }

  /** Never throws: a blocked or corrupt store simply yields the defaults. */
  read() {
    try {
      const raw = this.backend.getItem(this.key);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  get(name, fallback = undefined) {
    const v = this.read()[name];
    return v === undefined ? fallback : v;
  }

  /** UPSERT one preference, leaving the others alone. */
  set(name, value) {
    try {
      const next = { ...this.read(), [name]: value };
      this.backend.setItem(this.key, JSON.stringify(next));
      return next;
    } catch {
      return this.read();   // private browsing, quota, blocked storage: ignore
    }
  }

  clear() {
    try { this.backend.removeItem(this.key); } catch { /* nothing to do */ }
  }
}
