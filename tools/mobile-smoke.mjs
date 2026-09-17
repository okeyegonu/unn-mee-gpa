#!/usr/bin/env node
/**
 * Small-screen smoke test: drives the app in headless Firefox at three phone
 * viewports and checks the things that actually break on a phone — horizontal
 * overflow, unreachable controls, tap targets that are too small, and text the
 * mobile browser would zoom into on focus.
 *
 * Prerequisites: geckodriver --port 4444, and the app served on :8000.
 * Run:  node tools/mobile-smoke.mjs
 */
const APP = process.argv[2] ?? 'http://localhost:8000/';
const DRIVER = process.argv[3] ?? 'http://localhost:4444';

const VIEWPORTS = [
  { name: 'iPhone SE / small Android', width: 375, height: 667 },
  { name: 'iPhone 14 / Pixel 7', width: 390, height: 844 },
  { name: 'Android tablet portrait', width: 768, height: 1024 },
];

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`    ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

async function call(method, path, body) {
  const res = await fetch(`${DRIVER}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json.value;
}

console.log(`\nChecking ${APP} at phone viewports\n`);

for (const vp of VIEWPORTS) {
  const session = await call('POST', '/session', {
    capabilities: {
      alwaysMatch: {
        browserName: 'firefox',
        'moz:firefoxOptions': { args: ['-headless', '-width', String(vp.width), '-height', String(vp.height)] },
      },
    },
  });
  const sid = session.sessionId;
  const exec = (script, args = []) => call('POST', `/session/${sid}/execute/sync`, { script, args });

  try {
    console.log(`  ${vp.name} (${vp.width}x${vp.height})`);
    await call('POST', `/session/${sid}/window/rect`, { width: vp.width, height: vp.height, x: 0, y: 0 });
    await call('POST', `/session/${sid}/url`, { url: APP });

    // wait for render
    for (let i = 0; i < 100; i++) {
      if (await exec(`return document.querySelectorAll('tr[data-id]').length > 0;`)) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const inner = await exec(`return window.innerWidth;`);

    // 1. No horizontal scrolling of the page itself.
    const overflow = await exec(`
      var w = window.innerWidth;
      var worst = null;
      var all = document.body.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (el.closest('.table-scroll')) continue;       // deliberately scrollable
        var r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        if (r.right > w + 1 || r.left < -1) {
          if (!worst || r.right > worst.right) {
            worst = { tag: el.tagName + '.' + (el.className || ''), right: Math.round(r.right), left: Math.round(r.left) };
          }
        }
      }
      return { docWidth: document.documentElement.scrollWidth, winWidth: w, worst: worst };
    `);
    check('the page does not scroll sideways',
      overflow.docWidth <= overflow.winWidth + 1,
      `document ${overflow.docWidth}px vs viewport ${overflow.winWidth}px`);
    check('no element spills outside the viewport',
      overflow.worst === null, overflow.worst ? JSON.stringify(overflow.worst) : '');

    // 2. The card layout is in force below the breakpoint.
    const layout = await exec(`
      var tr = document.querySelector('tr[data-id]');
      var thead = document.querySelector('table.courses thead');
      return {
        theadHidden: getComputedStyle(thead).display === 'none',
        rowDisplay: getComputedStyle(tr).display,
        rowHeight: Math.round(tr.getBoundingClientRect().height)
      };
    `);
    if (vp.width <= 760) {
      check('course rows render as stacked cards', layout.theadHidden && layout.rowDisplay === 'grid', JSON.stringify(layout));
    } else {
      check('the tablet keeps the full table layout', !layout.theadHidden, JSON.stringify(layout));
    }

    // 3. Tap targets and font sizes.
    const controls = await exec(`
      var sel = document.querySelector('tr[data-id] select.grade');
      var cs = getComputedStyle(sel);
      var r = sel.getBoundingClientRect();
      var btn = document.getElementById('btn-export').getBoundingClientRect();
      var search = getComputedStyle(document.getElementById('filter-text'));
      return {
        selectH: Math.round(r.height), selectW: Math.round(r.width),
        selectFont: parseFloat(cs.fontSize),
        buttonH: Math.round(btn.height),
        searchFont: parseFloat(search.fontSize)
      };
    `);
    check('the grade control is a comfortable tap target',
      controls.selectH >= 40 && controls.selectW >= 60, JSON.stringify(controls));
    check('controls use 16px text, so mobile browsers do not zoom on focus',
      vp.width > 760 || (controls.selectFont >= 16 && controls.searchFont >= 16), JSON.stringify(controls));
    check('the action buttons are tappable', controls.buttonH >= 36, `${controls.buttonH}px`);

    // 4. The sticky summary stays on screen while scrolling the long list.
    await exec(`window.scrollTo(0, 3000);`);
    await new Promise((r) => setTimeout(r, 200));
    const sticky = await exec(`
      var b = document.getElementById('summary-bar').getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), visible: b.bottom > 0 && b.top < window.innerHeight };
    `);
    check('the running GPA stays visible while scrolling', sticky.visible === true, JSON.stringify(sticky));
    await exec(`window.scrollTo(0, 0);`);

    // 5. Entering a grade still works and recalculates live.
    await exec(`
      var tr = document.querySelector('tr[data-id="y1s1-MTH101"]');
      var sel = tr.querySelector('select.grade');
      sel.value = 'A';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    `);
    await new Promise((r) => setTimeout(r, 200));
    const after = await exec(`
      return {
        gpa: document.getElementById('stat-gpa').textContent.trim(),
        units: document.getElementById('stat-units').textContent.trim(),
        pt: document.querySelector('tr[data-id="y1s1-MTH101"] .cell-pt').textContent.trim()
      };
    `);
    check('entering a grade recalculates live on the phone layout',
      after.gpa === '5.00' && after.units === '2' && after.pt.includes('10'), JSON.stringify(after));

    // 6. The per-course figures are labelled now that the column headings are gone.
    if (vp.width <= 760) {
      const labels = await exec(`
        var td = document.querySelector('tr[data-id] .cell-units');
        return { label: td.getAttribute('data-label'), before: getComputedStyle(td, '::before').content };
      `);
      check('units / grade point / course point carry their own labels',
        labels.label === 'Units' && labels.before.toLowerCase().includes('units'), JSON.stringify(labels));
    }

    const shot = await call('GET', `/session/${sid}/screenshot`);
    const { writeFile } = await import('node:fs/promises');
    const dir = process.env.SMOKE_DIR ?? '/tmp';
    await writeFile(`${dir}/gpa-mobile-${vp.width}.png`, Buffer.from(shot, 'base64'));

    await exec(`localStorage.removeItem('unn-mee-gpa-calculator');`);
    console.log('');
  } finally {
    await call('DELETE', `/session/${sid}`).catch(() => {});
  }
}

console.log(`${failures === 0 ? 'All mobile checks passed.' : `${failures} mobile check(s) FAILED.`}\n`);
process.exit(failures === 0 ? 0 : 1);
