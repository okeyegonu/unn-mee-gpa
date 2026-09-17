# UNN Mechanical Engineering — Incremental GPA Calculator

A browser-based GPA calculator for undergraduates in the Department of
Mechanical Engineering, University of Nigeria, Nsukka.

Its defining behaviour: **the GPA reflects all and only the results the student
has entered so far.** A student who knows one result enters one grade and gets a
GPA. When the next result is released they add it, and the GPA grows. Nothing
waits for a complete semester, and no year or semester boundary gates anything.

Runs in Firefox and Chrome, on desktop and on phones.

---

## Launching it

```bash
cd /home/okechukwu/pdp-causal-agent/claude_code_outputs/UNN_MECH_GPA_CALC/gpa-calculator
./serve.sh
```

Then open **<http://localhost:8000/>** in Firefox or Chrome.

`./serve.sh` also prints a `http://192.168.x.x:8000/` address for phones on the
same Wi-Fi. Any static server works just as well:

```bash
python3 -m http.server 8000          # this computer only
python3 -m http.server 8000 --bind 0.0.0.0   # reachable from phones on the LAN
npx serve .                          # if you prefer Node
```

A server is needed because browsers refuse to let a page opened from `file://`
read `data/curriculum.json`. If you want a copy that opens straight from disk
with no server, build the single-file version:

```bash
npm run build     # -> dist/unn-mee-gpa-calculator.html
```

That one 72 kB file contains the curriculum, the engine and the styling, works
offline, and is what you send to students over WhatsApp. See
**[docs/DISTRIBUTION.md](docs/DISTRIBUTION.md)**.

### Everything you can run

```bash
npm test             # 119 calculation, repeat, persistence, preference and curriculum tests
npm run validate     # re-validate the curriculum; rewrites the validation report
npm run build        # rebuild the single-file offline copy
npm run smoke        # end-to-end test in a real Firefox  (needs geckodriver)
npm run smoke:repeats# end-to-end checks for repeat sittings
npm run smoke:mobile # the same at three phone viewports
npm run smoke:offline# test the single-file build opened from file://
```

The `smoke` targets need `geckodriver --port 4444` running in another terminal
and, for all but `smoke:offline`, the app being served on port 8000.

---

## How the calculation works

```
A = 5    B = 4    C = 3    D = 2    E = 1    F = 0

course point = course units × grade point

              Σ (units × grade point)   over courses with a grade entered
      GPA  =  ───────────────────────
                     Σ (units)          over courses with a grade entered
```

Three rules matter, and the tests pin all three:

- **A blank is not a zero.** A course with no grade contributes 0 units to the
  denominator and 0 points to the numerator. It is invisible to the calculation.
- **An F is not a blank.** It is an attempted course: 0 points, but its units
  stay in the denominator. `2 units A` plus `3 units F` is 10 ÷ 5 = **2.00**,
  not 5.00.
- **A repeated course counts once per sitting.** Failing a 3-unit course and
  passing it next time contributes 6 units and 12 points, not 3 and 12. A course
  is repeated only on failure — once passed it cannot be taken again. See
  *Repeat sittings* below.
- **Year and semester are labels, not rules.** They group the display and drive
  the per-semester and per-year panels. They never decide whether a course
  counts. A student may enter a First Year first-semester result, a Second Year
  second-semester result and a Fourth Year first-semester result and get a GPA
  over exactly those three.

### Repeat sittings

Mechanical Engineering takes a minimum of five years and a maximum of eight. A
student who fails a course sits it again, and **every sitting counts separately**:

```
numerator   += units x gradePoint     for each sitting
denominator += units                  for each sitting
```

So a failed sitting puts its units into the denominator while adding nothing to
the numerator, and each further failure degrades the GPA again. A repeated
course behaves exactly as though another course of the same size had been added
to the programme — there is a test asserting that equivalence directly.

A 3-unit course failed once and then passed with a B contributes 6 units and
12 points, so that B is worth **2.00**, not 4.00.

**A course is repeated only after it is failed.** Once it is passed it cannot be
taken again, so a sequence of sittings always ends at the first pass. The
interface offers a box for the next sitting only where the last one was a
failure, and the engine disregards anything recorded after a pass — so even a
hand-edited file cannot manufacture an extra sitting of a course already passed.
Correcting an earlier sitting to a pass drops the sittings after it, in the
stored state as well as on screen.

Which grades count as failures is `progression.failing_grades` in
`data/curriculum.json`. It is `["F"]`, because F = 0 points is the unambiguous
case. **If the department also requires a course graded E to be repeated, add
`"E"` to that list** — nothing else needs to change, and there is a test
covering both settings.

**The allowance** then caps how many failures a student can sit through. A course
first taken in year *x* may be repeated in each remaining year up to the
programme maximum, giving `(8 - x)` repeats and `(9 - x)` sittings in total:

| Year | Sittings allowed | Repeats |
|---|---:|---:|
| First | 8 | 7 |
| Second | 7 | 6 |
| Third | 6 | 5 |
| Fourth | 5 | 4 |
| Fifth | 4 | 3 |

This comes from `progression.maximum_years_to_graduate` in
`data/curriculum.json`; changing that one number moves the allowance for every
year at once. The allowance is resolved onto each course as `maxAttempts` while
the curriculum is flattened, so the GPA engine enforces it without ever looking
at a year.

**In the interface.** An **I repeated a course** checkbox in the toolbar turns
on a grade box per sitting. Each sitting is numbered, and a dashed box is always
offered for the next one until the allowance is reached. A course with repeats
shows its contributed units as `9` with `3 × 3` beneath, lists the grade point
of each sitting, and totals the course points.

The checkbox is off by default. It switches itself on for anyone who already has
repeats recorded, because hiding sittings that are counting towards the GPA would
make the figures impossible to explain.

**One record per course, and only one.** With a single grade per course, "no
duplicates" came free — the same key was overwritten. A list of sittings has to
earn it. Exactly one stored form represents any given academic record:

- a blank or invalid entry is not a sitting, so it is never stored;
- the list stops at the year's allowance;
- the list stops at the first pass.

Every write goes through that canonical form, so re-recording a result — an `F`
included — can never append a second copy of it, and the same history always
serialises to the same bytes however it was arrived at. Anything loaded from
storage or imported from a file is canonicalised on the way in and the tidied
version written straight back, so a record left untidy by hand-editing or by an
earlier version is repaired once rather than carried around. The canonicaliser
is a fixed point: running it on a tidy record changes nothing.

Each sitting is separately addressable, so three failures of the same course are
three facts rather than a tally, and any one of them can be corrected without
disturbing the others.

**Storage.** The first sitting stays in `grades` exactly where it has always
been; repeats live in a separate `repeats` map. A result saved before this
feature existed therefore loads unchanged, and an older copy of the interface
reading the same record still finds the first sitting where it expects it.
Clearing the first sitting clears the whole course, since a repeat of a course
that was never sat is meaningless.

### Reporting precision

GPA figures are shown to two decimal places, which is what the university
reports. A **Show full precision** checkbox in the toolbar switches every GPA on
the page — headline, semester strips, year panel — to five places instead. It is
off by default and remembered per viewer.

Both numbers come from `data/curriculum.json`:

```json
"reporting": {
  "gpa_decimal_places": 2,
  "gpa_full_precision_places": 5
}
```

Three deliberate constraints:

- **This is display only.** The GPA is always computed at full double precision
  from integer quality points and integer units, so more decimal places reveal
  digits that were already there rather than improving accuracy. Since a GPA is
  a ratio of two integers, those extra digits are the true quotient, not
  floating-point debris — there is a test asserting that out to ten places.
- **The degree classification always uses the two-decimal figure**, whatever the
  switch is set to, so a student sitting on 2.39500 can never be shown a
  different class because of a screen setting.
- **The preference is not academic data.** It lives under its own storage key,
  `unn-mee-gpa-calculator:prefs`, so it never enters the results record, never
  rides along in an export, and never travels to another student through an
  imported file. Resetting results keeps the setting; clearing the setting keeps
  the results.

An exported file carries both `gpa` and `gpa_full_precision`, so the export never
depends on how a screen happened to be set.

---

## Project structure

```
gpa-calculator/
├── index.html                      the page
├── serve.sh                        local server; prints the LAN address too
├── manifest.webmanifest, icon.svg  "Add to Home screen" on phones
│
├── data/
│   ├── curriculum.json             THE CURRICULUM. Edit this, nothing else.
│   └── curriculum.flat.json        generated: flat course list + grade templates
│
├── src/
│   ├── grading.js                  the grade scale and the course-point rule
│   ├── curriculum.js               flattening, indexing, structural validation
│   ├── gpa-engine.js               the GPA calculation — pure, no DOM, no storage
│   ├── storage.js                  persistence behind an async repository interface
│   ├── ui.js                       presentation only
│   └── styles.css                  desktop layout + phone card layout
│
├── tests/
│   ├── gpa-engine.test.mjs         the calculation tests
│   ├── storage.test.mjs            persistence and idempotency
│   └── curriculum.test.mjs         runs against the real data file
│
├── tools/
│   ├── validate-curriculum.mjs     validation report generator
│   ├── build-single-file.mjs       the offline single-file build
│   ├── browser-smoke.mjs           end-to-end test in real Firefox
│   ├── repeat-smoke.mjs            end-to-end checks for repeat sittings
│   ├── mobile-smoke.mjs            phone-viewport layout checks
│   └── file-url-smoke.mjs          offline-copy checks
│
├── docs/
│   ├── curriculum-validation.md    generated: the full course table + findings
│   └── DISTRIBUTION.md             how to ship this to students
│
└── dist/
    └── unn-mee-gpa-calculator.html generated: the whole thing in one file
```

The layers are separated so that the curriculum can be corrected without
touching the engine, and the storage can later become a server without touching
either. `data/curriculum.json` is the only file that contains course
definitions; `src/ui.js` contains no course names at all.

---

## Where the course data came from

| Years | Source |
|---|---|
| First Year | `FIRST-YEAR-2026-09-17-18.30.34.jpeg` — the departmental *CGPA Result Pre-Computation Form*, using the handwritten revision that supersedes the printed codes |
| Second to Fifth Year | `BACHELORS-PROGRAMME-14-JAN-2023-FINAL.pdf`, section 2.1, printed pages 26 to the top of page 30 |

103 courses, every one with a known unit load. All ten semester totals
reconcile — 16, 16, 19, 18, 20, 20, 22, 15, 18, 19.

**Read [docs/curriculum-validation.md](docs/curriculum-validation.md).** It
contains the full year → semester → course table and every ambiguity found in
the sources, reported rather than guessed at. Two points worth knowing:

- **`PHY 104` and `STA 112` (First Year, Second Semester) have no unit load
  written on the form.** They were left as `null` rather than invented, and on
  2026-09-17 the department supplied `PHY 104` = 2 units and `STA 112` = 3. Both
  are marked `"units_source": "supplied_by_department"` and logged under
  `amendments` in `data/curriculum.json`, so it stays visible that these two
  figures were provided rather than extracted. With them in place the revised
  second semester totals 16 units, matching the revised first semester.
- **Most revised First Year titles are not written on the form.** Where a new
  code plainly replaces a struck-out one (`MTH 101` over `MTH 111`) the old
  title was carried across and marked as inherited. Otherwise the title is left
  blank rather than made up.

### Electives are a label, not a rule

The Fifth Year elective courses are listed under their two option areas —
Thermal and Fluids, and Design/Materials/Manufacturing — with the source
document's "choose 2 (6 units)" and "choose 1 (3 units)" wording shown above
them. That is **printing on a page and nothing more**. The student decides what
they took; the calculator adds up what they enter.

Concretely, the engine does not know electives exist. An elective grade and a
compulsory grade are indistinguishable to it. It will not object if a student
enters electives from both option areas, or enters three where the rule says
two, or enters none at all. `option_area` is not a filter, `choose` is not a
quota, and no elective is ever pre-counted or assumed.

The tests pin this down: `evaluateCourse` and `summariseRows` — the two
functions that decide whether a course counts and then add it up — are asserted
to contain no reference to year, semester, group, category or elective status.

### Correcting the curriculum

Edit `data/curriculum.json`, then:

```bash
npm run validate && npm test
```

`npm run validate` checks for duplicate course codes, missing or zero unit
loads, malformed codes, year/semester inconsistencies and totals that do not
reconcile, and rewrites the validation report. For a substantive change, also
raise `curriculum_version` — see below.

---

## Saved results

Results are kept in the browser's `localStorage` under a single key,
`unn-mee-gpa-calculator`, on this shape:

```json
{
  "schema_version": 1,
  "records": {
    "unn-mee-beng-5yr@2023.1": {
      "curriculum_version": "2023.1",
      "saved_at": "2026-09-17T18:51:28.000Z",
      "grades":        { "y1s1-MTH101": "A", "y3s1-MEE313": "F" },
      "unitOverrides": {}
    }
  }
}
```

(`unitOverrides` holds a unit load typed in by the student. It is empty in
normal use: it only fills if a future curriculum edit leaves a course's units
unstated, in which case the calculator asks for the value rather than guessing.)

Each course has a stable id built from **year + semester + course code**
(`y3s1-MEE313`), and every write is an upsert into an object keyed by that id.
There is no array anywhere in the persisted shape, so saving repeatedly cannot
append a duplicate course record or a duplicate grade — a property the tests
assert by saving the same state 25 times and checking the result.

Results are filed under `curriculum_id@curriculum_version`. Publishing a new
curriculum version therefore starts a clean record instead of silently
reinterpreting old grades under a changed course structure; the earlier results
are kept untouched, and the student is offered a button to copy them across.

`src/storage.js` exposes an async repository (`load`, `save`, `clear`,
`exportPayload`, `parseImport`). Swapping in a server-backed implementation of
that interface requires no change to the GPA engine or the UI's call sites.

An export also carries `course_records`: one entry per course sat, listing every
sitting in order with the units and quality points it contributed. `grades` and
`repeats` remain the machine-readable source of truth; this is the same record
written out so that an export can be read and checked by eye.

**Export / Import / Reset** are in the top-right. Export writes a portable JSON
file carrying the curriculum version, the grades and the export timestamp — the
way to move results to another browser, phone or laptop. Reset asks for
confirmation twice.

---

## Privacy

No name, registration number, email or password is asked for or stored. There is
no account, no analytics and no network call of any kind: `npm run smoke:offline`
asserts that the page loads zero external resources. Results never leave the
browser they were typed into unless the student exports them deliberately.

---

## On phones

Below 760px the six-column table becomes one card per course — code and title
above, unit load, grade point and course point labelled beneath, and the grade
selector on the right at a 46px tap target with 16px text so that mobile Safari
and Chrome do not zoom on focus. The running GPA stays pinned to the top of the
screen while scrolling. `npm run smoke:mobile` checks all of this at 375×667,
390×844 and 768×1024, including that no element overflows the viewport.

`manifest.webmanifest` lets a student use **Add to Home screen**, after which the
calculator opens full-screen like an app rather than in a browser tab.

Note that this does **not** by itself make a hosted copy work offline: there is
no service worker, so opening the link still needs a connection each time. The
offline copy is `dist/unn-mee-gpa-calculator.html`, which has everything
embedded and never touches the network at all.
