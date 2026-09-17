# Sending the calculator to students over WhatsApp

There are two ways to get this into students' hands. They are not exclusive —
sending the link *and* the file covers everyone.

| | What you send | Student needs | Works offline | Reliability |
|---|---|---|---|---|
| **A. Hosted link** (recommended) | a normal `https://…` link | data each time they open it | no (no service worker) | highest — behaves like any website |
| **B. Single file** | `unn-mee-gpa-calculator.html` (72 kB) | nothing | yes, completely | good on Android; fiddly on iPhone |

---

## Option A — put it on the web and send the link

This is the option to lead with. A link in WhatsApp opens in the phone's normal
browser, where everything works the way it does on a laptop: saved grades,
"Add to Home screen", no security prompts, no file manager.

The calculator is a static site — no server code, no database — so free static
hosting is enough.

### A1. GitHub Pages (free, permanent, no card)

```bash
cd /home/okechukwu/pdp-causal-agent/claude_code_outputs/UNN_MECH_GPA_CALC/gpa-calculator

git init
git add .
git commit -m "UNN Mechanical Engineering GPA calculator"

# create an empty public repo on github.com first, then:
git remote add origin https://github.com/<your-username>/unn-mee-gpa.git
git branch -M main
git push -u origin main
```

Then on github.com: **Settings → Pages → Source: Deploy from a branch →
Branch: `main`, folder: `/ (root)` → Save**. After a minute the site is at:

```
https://<your-username>.github.io/unn-mee-gpa/
```

That is the link you send. To publish a correction later: edit
`data/curriculum.json`, run `npm run validate && npm test`, then
`git commit -am "correct MEE 313 units" && git push`. Students get the update
the next time they open the link — nothing to re-send, and their saved grades
are untouched as long as `curriculum_version` has not changed.

### A2. Cloudflare Pages or Netlify (drag-and-drop, ~2 minutes)

Sign in, choose "deploy without Git" / "Drop a folder", and drag the whole
`gpa-calculator` folder in. You get a link immediately. Same idea, less setup,
but you re-drag the folder to publish a change.

### A3. Just for a lab session on campus Wi-Fi

No hosting needed — serve it from your own laptop and let students on the same
Wi-Fi open it:

```bash
cd /home/okechukwu/pdp-causal-agent/claude_code_outputs/UNN_MECH_GPA_CALC/gpa-calculator
./serve.sh
```

It prints a `http://192.168.x.x:8000/` address (and a QR code, if `qrencode` is
installed — `sudo apt install qrencode`). Students type that in, or scan it.
This only works while your laptop is on and on the same network, so it is for a
classroom, not for general distribution.

---

## Option B — send the single HTML file itself

Build it:

```bash
cd /home/okechukwu/pdp-causal-agent/claude_code_outputs/UNN_MECH_GPA_CALC/gpa-calculator
npm run build
# -> dist/unn-mee-gpa-calculator.html   (about 72 kB)
```

Everything is inside that one file: the curriculum, the calculation engine, the
styling. It never contacts the network.

**Send it as a Document, not as a photo or a link.** In WhatsApp:
📎 (attach) → **Document** → browse to `dist/unn-mee-gpa-calculator.html` → send.
WhatsApp does not compress documents, so it arrives intact.

**What the student does:**

- **Android (most students).** Tap the file in the chat to download it, then
  open it — Android will offer Chrome or Firefox. If it only offers to "save",
  open the **Files** app → **Downloads** → tap
  `unn-mee-gpa-calculator.html` → **Open with → Chrome/Firefox**. Grades then
  save on that phone as normal.
- **iPhone.** Tap the file → share icon → **Save to Files** → open the **Files**
  app → tap the file. It opens in a preview; use the share icon again and
  choose a browser if the preview does not let them tap the grade boxes. This is
  clumsier than Option A, which is why the link is the better default for
  iPhone users.

### Honest limits of Option B

- Verified working (rendering, live recalculation, and saved grades surviving a
  reopen) in Firefox opened from a `file://` path. Chrome's handling of local
  files is more restrictive than Firefox's, and Android file managers vary, so
  a student on Chrome may find grades do not persist between sessions. If that
  happens, they should use **Export results** to keep a backup, or switch to the
  hosted link.
- Every student's copy is frozen at the moment you sent it. Correcting the
  curriculum means building and sending a new file, and telling students to
  export first (see below).
- A file arriving over WhatsApp is not obviously trustworthy to a careful
  student. The link is easier for them to trust.

---

## Message you can paste into WhatsApp

**If you are sending a link (Option A):**

> *MECHANICAL ENGINEERING — GPA CALCULATOR*
>
> Here is a GPA calculator for our B.Eng. programme: <YOUR LINK HERE>
>
> All five years and every course are already loaded with their unit loads. You
> do not have to wait for a full semester — enter each result as it is released
> and the GPA updates immediately. Courses you leave blank are simply ignored.
>
> Note the difference between a blank and an F. Blank means "no result yet" and
> counts for nothing. An F is a real result: 0 points, but the units still count
> against you.
>
> Your grades are saved in your own phone's browser. Nothing is sent to me or to
> anyone else — there is no name, no reg number and no login. If you clear your
> browser data you will lose them, so use *Export results* now and then to keep a
> backup file.
>
> Tip: open the link, then use your browser menu → *Add to Home screen*. It will
> then open full-screen like an app instead of in a browser tab. (You still need
> a connection to open it — if you want a copy that works with no data at all,
> ask me for the offline file.)

**If you are sending the file (Option B), add:**

> Save the attached file, then open it with Chrome or Firefox (not the file
> preview). It works completely offline once saved.

---

## Before you send

```bash
npm test              # 106 calculation, repeat, persistence, preference and curriculum tests
npm run validate      # regenerates docs/curriculum-validation.md
npm run build         # regenerates dist/unn-mee-gpa-calculator.html
```

Read `docs/curriculum-validation.md` first — it lists the full course table and
everything the source documents left ambiguous. As of 2026-09-17 every course
has a known unit load, including **PHY 104** (2) and **STA 112** (3), whose unit
loads the source form leaves blank and which the department supplied directly;
students are not asked to fill anything in.

## Telling students about an update

If you change the curriculum in a way that alters course codes or unit loads,
raise `curriculum_version` in `data/curriculum.json`. Saved results are stored
per curriculum version, so the old ones are kept rather than being silently
re-interpreted under the new structure, and the student is offered the choice of
copying them across. Tell students to **Export results** before switching, as a
belt-and-braces backup.
