const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { before, after, test } = require('node:test');
const { chromium } = require('playwright');

const source = readFileSync(join(__dirname, '../oc-planner-recommendations.user.js'), 'utf8');
const panel = '#askeladds-oc-planner-panel';
const route = 'https://www.torn.com/factions.php?step=your&type=1#/tab=crimes';
const crime = `<article data-crime-id="101"><h3>Test OC</h3>
  <div class="slot"><span class="title">Driver</span><button class="native-join">Join</button></div></article>`;
const fixture = `<style>body{margin:0;background:#222;color:#eee;font:14px Arial}
  #mainContainer{max-width:980px;margin:auto;padding:12px;box-sizing:border-box}
  article{margin:12px 0;padding:12px;background:#444}</style>
  <main id="mainContainer"><div class="content-wrapper"><nav>Faction navigation</nav>
  <div id="faction-crimes-root">${crime}</div></div></main>`;
let browser;
before(async () => { browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) }); });
after(async () => { await browser?.close(); });

async function open(t, { url = route, html = fixture, saved = false, cpr = false, width = 1000, deferProfile = false, plannerSnapshot = null, cacheSchemaVersion = 3 } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 800 } });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'no browser exceptions'));
  // Every browser request is intercepted. No live Torn/backend traffic or real keys.
  await context.route('**/*', request => request.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(url);
  await page.evaluate(({ saved, cpr, deferProfile, plannerSnapshot, cacheSchemaVersion }) => {
    const key = 'test-only';
    const profile = { player_id: 123, name: 'Test member', faction: { faction_id: 41309 } };
    const payload = {
      memberId: 123, memberName: 'Test member', factionId: '41309', recommendationMode: cpr ? 'cpr' : 'plan',
      recommendations: cpr ? [] : [{ crimeId: 101, crimeName: 'Test OC', role: 'Driver', position: 'Driver', planningStep: 1 }],
      planningSteps: [], unassigned: [], flexibleSlots: [], warnings: [],
      cprEligibleSlots: cpr ? [{ crimeId: 101, crimeName: 'Test OC', role: 'Driver', position: 'Driver' }] : [],
      cprMemberStatus: 'eligible', cprOpenSlotCount: 1, cprIneligibleCount: 0, cprMissingCount: 0,
    };
    const cache = new Map();
    if (saved) {
      cache.set('askeladds_oc_planner_api_key', key);
      cache.set('askeladds_oc_planner_profile', JSON.stringify({ keyCacheId: '9:test:only', profile, savedAt: new Date().toISOString() }));
      cache.set('askeladds_oc_planner_member_payload', JSON.stringify({ schemaVersion: cacheSchemaVersion, keyCacheId: '9:test:only', memberId: 123, factionId: '41309', checkedAt: Date.now() / 1000, snapshotRevision: 'fixture', payload }));
      cache.set('askeladds_oc_planner_position', JSON.stringify({ left: 1800, top: 1500 }));
    }
    window.GM_getValue = (key, fallback) => cache.has(key) ? cache.get(key) : fallback;
    window.GM_setValue = (key, value) => cache.set(key, value);
    window.GM_deleteValue = key => cache.delete(key);
    window.testMenu = {};
    window.GM_registerMenuCommand = (name, fn) => { window.testMenu[name] = fn; };
    window.testCalls = [];
    window.testPlannerRevisions = [];
    window.testReadMemberPayload = () => JSON.parse(cache.get('askeladds_oc_planner_member_payload') || 'null');
    window.GM_xmlhttpRequest = options => {
      const url = new URL(options.url);
      window.testCalls.push(url.pathname);
      if (url.pathname.endsWith('/bot-alerts')) window.testPlannerRevisions.push(url.searchParams.get('revision'));
      const payload = options.url.includes('api.torn.com') ? profile
        : plannerSnapshot && url.pathname.endsWith('/bot-alerts')
          ? url.searchParams.get('revision') === plannerSnapshot.revision
            ? { notModified: true, revision: plannerSnapshot.revision, recommendationPolicy: plannerSnapshot.recommendationPolicy }
            : plannerSnapshot
          : { notModified: saved, recommendationPolicy: { mode: cpr ? 'cpr' : 'plan' } };
      const respond = () => options.onload({ status: 200, responseHeaders: 'content-type: application/json', responseText: JSON.stringify(payload) });
      if (deferProfile && options.url.includes('api.torn.com')) window.testResolveProfile = respond;
      else queueMicrotask(respond);
    };
    window.nativeJoins = 0;
    document.querySelector('.native-join')?.addEventListener('click', () => { window.nativeJoins++; });
  }, { saved, cpr, deferProfile, plannerSnapshot, cacheSchemaVersion });
  await page.addScriptTag({ content: source });
  return page;
}

test('release metadata agrees with the installable script', () => {
  const meta = readFileSync(join(__dirname, '../oc-planner-recommendations.meta.js'), 'utf8');
  const version = source.match(/@version\s+(\S+)/)[1];
  assert.equal(meta.match(/@version\s+(\S+)/)[1], version);
  assert.ok(source.includes(`const SCRIPT_VERSION = "${version}";`));
});

test('mounts in page flow above crimes, not in body or above faction navigation', async t => {
  const page = await open(t);
  const layout = await page.locator(panel).evaluate(el => ({
    position: getComputedStyle(el).position, parent: el.parentElement.className,
    previous: el.previousElementSibling.tagName, next: el.nextElementSibling.id,
    width: el.getBoundingClientRect().width, parentWidth: el.parentElement.getBoundingClientRect().width,
    scroll: getComputedStyle(el.querySelector('.ocp-body')).overflowY,
  }));
  assert.equal(layout.position, 'relative');
  assert.equal(layout.parent, 'content-wrapper');
  assert.equal(layout.previous, 'NAV');
  assert.equal(layout.next, 'faction-crimes-root');
  assert.equal(layout.width, layout.parentWidth);
  assert.equal(layout.scroll, 'visible');
  assert.equal(await page.locator(`${panel} .ocp-api-key`).count(), 1);
  assert.deepEqual(await page.evaluate(() => testCalls), []);
  await page.screenshot({ path: join(__dirname, '../test-results/inline-desktop.png'), fullPage: true });
});

for (const suffix of ['#/tab=members', '#/war/rank', '#/tab=crimes-history', '#/tab=members&redirect=tab%3Dcrimes', '#/%E0%A4%A', '']) {
  test(`no UI or requests outside OC (${suffix || 'no tab'})`, async t => {
    const page = await open(t, { saved: true, url: 'https://www.torn.com/factions.php?step=your' + suffix });
    await page.evaluate(() => testMenu['OC Planner: refresh']());
    assert.equal(await page.locator(panel).count(), 0);
    assert.deepEqual(await page.evaluate(() => testCalls), []);
  });
}

test('supports query and encoded hash routes but not another faction or challenge page', async t => {
  for (const [url, expected] of [
    ['https://torn.com/factions.php?step=your&tab=crimes', 1],
    ['https://torn.com/factions.php?step=your#/tab%3Dcrimes%26crimeId%3D101', 1],
    ['https://torn.com/factions.php?step=profile#/tab=crimes', 0],
    ['https://torn.com/factions.php?step=your&tab=crimes#/tab=members', 0],
    ['https://torn.com/factions.php?step=your&tab=crimes#/war/rank', 0],
  ]) {
    const page = await open(t, { url });
    assert.equal(await page.locator(panel).count(), expected, url);
  }
  const page = await open(t, { html: `<title>Just a moment...</title>${fixture}`, saved: true });
  assert.equal(await page.locator(panel).count(), 0);
  assert.deepEqual(await page.evaluate(() => testCalls), []);
});

test('hash, pushState, replaceState and back navigation unmount and restore one populated section', async t => {
  const page = await open(t, { saved: true });
  await page.waitForFunction(() => testCalls.length === 2);
  for (const method of ['hash', 'pushState', 'replaceState']) {
    await page.evaluate(method => {
      if (method === 'hash') location.hash = '/tab=members';
      else history[method]({}, '', '#/tab=members');
    }, method);
    await page.waitForFunction(id => !document.querySelector(id), panel);
    await page.evaluate(() => { location.hash = '/tab=crimes'; });
    await page.locator(`${panel} .ocp-title`).waitFor();
    assert.equal(await page.locator(panel).count(), 1);
    assert.match(await page.locator(`${panel} .ocp-title`).innerText(), /Driver/);
  }
  await page.evaluate(() => history.pushState({}, '', '#/tab=members'));
  await page.goBack();
  await page.locator(`${panel} .ocp-title`).waitFor();
  assert.equal(await page.evaluate(() => testCalls.length), 2, 'navigation reused fresh cached data');
});

test('waits for a content host instead of floating, then recovers after Torn removes it', async t => {
  const page = await open(t, { html: '<body>Loading faction...</body>' });
  assert.equal(await page.locator(panel).count(), 0);
  await page.evaluate(html => { document.body.innerHTML = html; }, fixture);
  await page.locator(`${panel} .ocp-api-key`).waitFor();
  await page.locator(`${panel} .ocp-api-key`).fill('unsaved-test-value');
  await page.evaluate(() => { document.querySelector('#faction-crimes-root').innerHTML += '<article data-crime-id="102">New crime</article>'; });
  await page.waitForTimeout(400);
  assert.equal(await page.locator(`${panel} .ocp-api-key`).inputValue(), 'unsaved-test-value');
  await page.evaluate(html => { document.querySelector('#mainContainer').outerHTML = html; }, fixture);
  await page.locator(`${panel} .ocp-api-key`).waitFor();
  assert.equal(await page.locator(panel).count(), 1);
  await page.locator(panel).evaluate(el => el.remove());
  await page.locator(`${panel} .ocp-title`).waitFor();
  assert.equal(await page.locator(panel).count(), 1);
});

test('entering OC from another faction tab activates once; leaving stops automatic requests', async t => {
  const page = await open(t, { saved: true, url: 'https://www.torn.com/factions.php?step=your#/tab=members' });
  assert.deepEqual(await page.evaluate(() => testCalls), []);
  await page.clock.install();
  await page.clock.fastForward(6 * 60 * 1000);
  await page.evaluate(() => history.pushState({}, '', '#/tab=crimes'));
  await page.clock.runFor(300);
  await page.locator(`${panel} .ocp-title`).waitFor();
  assert.equal(await page.evaluate(() => testCalls.length), 2);
  await page.evaluate(() => history.pushState({}, '', '#/tab=members'));
  await page.clock.runFor(300);
  await page.clock.fastForward(10 * 60 * 1000);
  assert.equal(await page.locator(panel).count(), 0);
  assert.equal(await page.evaluate(() => testCalls.length), 2);
});

test('stays outside native grids and works with an empty/loading OC list', async t => {
  const html = fixture.replace(`<div id="faction-crimes-root">${crime}</div>`, '<div id="grid" style="display:grid"><div id="faction-crimes-root"></div></div>');
  const page = await open(t, { html });
  assert.equal(await page.locator(panel).evaluate(el => el.nextElementSibling.id), 'grid');
  assert.equal(await page.locator('#grid > section').count(), 0);
});

test('retains upstream crime-list detection when the OC root has no recognized ID', async t => {
  const html = fixture.replace('id="faction-crimes-root"', 'id="native-crime-board"').replace(crime, crime + crime.replace('101', '102'));
  const page = await open(t, { html });
  assert.equal(await page.locator(panel).evaluate(el => el.nextElementSibling.id), 'native-crime-board');
  assert.equal(await page.locator(panel).evaluate(el => el.previousElementSibling.tagName), 'NAV');
});

test('preserves saved collapsed state, keyboard focus, and mobile page width; ignores old drag coordinates', async t => {
  const page = await open(t, { saved: true, width: 375 });
  await page.waitForFunction(() => testCalls.length === 2);
  const collapse = page.locator(`${panel} .ocp-collapse`);
  assert.equal(await collapse.getAttribute('aria-expanded'), 'false');
  await collapse.focus();
  await page.keyboard.press('Enter');
  assert.equal(await collapse.getAttribute('aria-expanded'), 'true');
  assert.equal(await collapse.evaluate(el => el === document.activeElement), true);
  const box = await page.locator(panel).boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 375);
  assert.equal(await page.locator(panel).evaluate(el => el.style.left), '');
  await page.screenshot({ path: join(__dirname, '../test-results/inline-mobile.png'), fullPage: true });
  await page.keyboard.press('Space');
  assert.equal(await collapse.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.evaluate(() => nativeJoins), 0);
  assert.equal(await page.evaluate(() => testCalls.length), 2);
});

test('native recommendation badges and CPR eligibility survive inline mounting and clear on exit', async t => {
  for (const cpr of [false, true]) {
    const page = await open(t, { saved: true, cpr });
    const selector = cpr ? '.askeladds-oc-planner-role-cpr-eligible' : '.askeladds-oc-planner-join-cue';
    await page.locator(selector).first().waitFor();
    assert.equal(await page.locator(`${panel} ${selector}`).count(), 0);
    await page.evaluate(() => { location.hash = '/tab=members'; });
    await page.waitForFunction(selector => !document.querySelector(selector), selector);
    assert.equal(await page.evaluate(() => nativeJoins), 0);
  }
});

test('leaving during key validation does not continue fetching the planner or scheduling requests', async t => {
  const page = await open(t, { deferProfile: true });
  await page.locator(`${panel} .ocp-api-key`).fill('test-only');
  await page.locator(`${panel} .ocp-save-refresh`).click();
  await page.waitForFunction(() => !!window.testResolveProfile);
  await page.evaluate(() => { history.pushState({}, '', '#/tab=members'); testResolveProfile(); });
  await page.waitForTimeout(350);
  assert.equal(await page.locator(panel).count(), 0);
  assert.deepEqual(await page.evaluate(() => testCalls), ['/user/']);
  await page.evaluate(() => { location.hash = '/tab=crimes'; });
  await page.waitForFunction(() => testCalls.some(path => path.endsWith('/bot-alerts')));
  assert.equal(await page.evaluate(() => testCalls.filter(path => path === '/user/').length), 1, 'returning reuses the validated profile and resumes the cancelled planner read');
});

// Native order differs from the planner order, as on Torn's Window of Opportunity card.
const numberedPositions = ['Engineer', 'Looter #1', 'Looter #2', 'Muscle #1', 'Muscle #2'];
const numberedCrime = `<article data-crime-id="2229602"><h3>Window of Opportunity</h3>${numberedPositions.map(position => `
  <div class="slot-wrapper" data-position="${position}"><div class="slotHeader"><span class="title">${position.toUpperCase()}</span></div>
  <button class="native-join" disabled>Join</button></div>`).join('')}</article>`;
const numberedSnapshot = {
  revision: 'numbered-fixture',
  recommendationPolicy: { mode: 'cpr', cprRequirements: {} },
  planner: {
    id: 'numbered-run', generatedAt: '2026-09-25T20:23:27.121Z',
    members: [{ memberId: 123, memberName: 'Test member', crimes: {
      'Window of Opportunity': { Engineer: 84, 'Looter #1': 85, 'Looter #2': 85, 'Muscle #1': 86, 'Muscle #2': 86 },
    } }],
    crimes: [{ id: 2229602, name: 'Window of Opportunity', difficulty: 7, status: 'Recruiting', openSlots: 5,
      slots: ['Engineer', 'Looter #1', 'Muscle #1', 'Looter #2', 'Muscle #2'].map(position => ({
        position, role: position.replace(/ #\d+$/, ''),
        minimumRecommendedCpr: ['Muscle #1', 'Looter #2'].includes(position) ? 75 : 65,
        maximumRecommendedCpr: ['Muscle #1', 'Looter #2'].includes(position) ? 100 : 80,
      })),
    }],
  },
};

async function assertNumberedHighlights(page) {
  await page.waitForFunction(() => window.testReadMemberPayload()?.payload?.plannerRunId === 'numbered-run');
  await page.locator('.askeladds-oc-planner-role-cpr-eligible').first().waitFor();
  assert.deepEqual(await page.locator('.askeladds-oc-planner-role-cpr-eligible').evaluateAll(elements =>
    elements.map(el => el.closest('[data-position]').dataset.position).sort()), ['Looter #2', 'Muscle #1']);
  const cached = await page.evaluate(() => testReadMemberPayload());
  assert.equal(cached.schemaVersion, 3);
  assert.equal(cached.payload.cprEligibleSlots.length, 2);
  assert.equal(cached.payload.cprIneligibleCount, 3);
  assert.equal(cached.payload.cprMissingCount, 0);
  assert.equal(cached.payload.cprOpenSlotCount, 5);
  assert.equal(await page.evaluate(() => nativeJoins), 0);
}

test('fresh snapshot highlights only qualifying numbered roles, even with disabled native Join buttons', async t => {
  const page = await open(t, { html: fixture.replace(crime, numberedCrime), cpr: true, plannerSnapshot: numberedSnapshot });
  await page.locator(`${panel} .ocp-api-key`).fill('test-only');
  await page.locator(`${panel} .ocp-save-refresh`).click();
  await assertNumberedHighlights(page);
  assert.deepEqual(await page.evaluate(() => testCalls), ['/user/', '/api/v1/factions/41309/oc-planner/bot-alerts', '/api/v1/factions/41309/oc-planner/script-access']);
  await page.screenshot({ path: join(__dirname, '../test-results/numbered-cpr.png'), fullPage: true });
});

for (const cacheSchemaVersion of [1, 2]) {
  test(`rebuilds pre-fix v${cacheSchemaVersion} recommendations without another Torn profile call`, async t => {
    const page = await open(t, { saved: true, cpr: true, cacheSchemaVersion, html: fixture.replace(crime, numberedCrime), plannerSnapshot: numberedSnapshot });
    await assertNumberedHighlights(page);
    assert.deepEqual(await page.evaluate(() => testPlannerRevisions), [null], 'must fetch the saved snapshot, not accept an unchanged response for old derived data');
    assert.deepEqual(await page.evaluate(() => testCalls), ['/api/v1/factions/41309/oc-planner/bot-alerts', '/api/v1/factions/41309/oc-planner/script-access']);
    await page.locator(`${panel} .ocp-collapse`).click();
    await assertNumberedHighlights(page);
    assert.equal(await page.evaluate(() => testCalls.length), 2, 'expanding still makes no requests');
  });
}
