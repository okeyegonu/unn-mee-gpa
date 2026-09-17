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
npm test             # 48 calculation, persistence and curriculum tests
npm run validate     # re-validate the curriculum; rewrites the validation report
npm run build        # rebuild the single-file offline copy
npm run smoke        # end-to-end test in a real Firefox  (needs geckodriver)
npm run smoke:mobile # the same at three phone viewports
npm run smoke:offline# test the single-file build opened from file://
```

The three `smoke` targets need `geckodriver --port 4444` running in another
terminal and, for the first two, the app being served on port 8000.

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
- **Year and semester are labels, not rules.** They group the display and drive
  the per-semester and per-year panels. They never decide whether a course
  counts. A student may enter a First Year first-semester result, a Second Year
  second-semester result and a Fourth Year first-semester result and get a GPA
  over exactly those three.

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
