#!/usr/bin/env node
/**
 * Builds dist/unn-mee-gpa-calculator.html — the whole calculator as ONE file.
 *
 * Why: a single .html file can be sent to a student over WhatsApp as a
 * document, saved to the phone, and opened in Firefox or Chrome with no
 * server, no installation and no network connection.
 *
 * What it does: inlines the stylesheet, inlines data/curriculum.json as
 * `window.__UNN_CURRICULUM__`, and concatenates the ES modules in dependency
 * order into a single module script (stripping their import/export keywords,
 * which is all that is needed because the modules form a simple chain).
 *
 * Run:  npm run build
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(resolve(root, p), 'utf8');

// Dependency order: each module only uses the ones before it.
const MODULES = ['src/grading.js', 'src/curriculum.js', 'src/gpa-engine.js', 'src/storage.js', 'src/ui.js'];

/** Strip ES module syntax. Safe here: no re-export blocks, no dynamic imports. */
function stripModuleSyntax(code, name) {
  const withoutImports = code.replace(/^\s*import\s[\s\S]*?from\s*'[^']*';\s*$/gm, '');
  if (/^\s*import\s/m.test(withoutImports)) throw new Error(`${name}: an import survived stripping`);
  const withoutExports = withoutImports.replace(/^export\s+/gm, '');
  if (/^export\s/m.test(withoutExports)) throw new Error(`${name}: an export survived stripping`);
  return withoutExports;
}

const html = await read('index.html');
const css = await read('src/styles.css');
const curriculum = JSON.parse(await read('data/curriculum.json'));

const bundle = [];
for (const m of MODULES) {
  bundle.push(`/* ======== ${m} ======== */`);
  bundle.push(stripModuleSyntax(await read(m), m));
}

// JSON embedded in a script must not be able to close the script element.
const curriculumLiteral = JSON.stringify(curriculum).replace(/</g, '\\u003c');

let out = html;

// 1. Inline the stylesheet.
out = out.replace('<link rel="stylesheet" href="./src/styles.css">', `<style>\n${css}\n</style>`);

// 2. Drop the references to files that will not travel with a single document.
out = out.replace(/\n?\s*<link rel="manifest"[^>]*>/, '');

// 3. Replace the module script with the inlined bundle.
out = out.replace(
  '<script type="module" src="./src/ui.js"></script>',
  `<script type="module">\nwindow.__UNN_CURRICULUM__ = ${curriculumLiteral};\n\n${bundle.join('\n')}\n</script>`,
);

// 4. A short banner explaining what this file is.
out = out.replace(
  '<title>',
  `<!--\n  UNN Mechanical Engineering GPA Calculator — single-file build.\n` +
  `  Curriculum ${curriculum.curriculum_id} version ${curriculum.curriculum_version}.\n` +
  `  Built ${new Date().toISOString()} by tools/build-single-file.mjs.\n` +
  `  Open this file in Firefox or Chrome. Nothing is sent anywhere; your grades\n` +
  `  stay in your own browser.\n-->\n<title>`,
);

// The bundle must not *load* anything external. (ui.js still contains the
// fetch fallback as dead code, which is harmless: __UNN_CURRICULUM__ wins.)
for (const leftover of ['href="./src/styles.css"', 'src="./src/ui.js"', 'rel="manifest"']) {
  if (out.includes(leftover)) throw new Error(`build still references ${leftover}`);
}
if (!out.includes('window.__UNN_CURRICULUM__ =')) throw new Error('curriculum was not embedded');

await mkdir(resolve(root, 'dist'), { recursive: true });
const target = resolve(root, 'dist/unn-mee-gpa-calculator.html');
await writeFile(target, out);

const kb = (Buffer.byteLength(out) / 1024).toFixed(1);
console.log(`Wrote dist/unn-mee-gpa-calculator.html  (${kb} kB, ${curriculum.years.length} years, ` +
  `curriculum version ${curriculum.curriculum_version})`);
console.log('This one file is the whole calculator. Send it, open it, done.');
