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

async function open(t, { url = route, html = fixture, saved = false, cpr = false, width = 1000, deferProfile = false, deferPlanner = false, plannerSnapshot = null, cacheSchemaVersion = 12, clockTime } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 800 } });
  t.after(() => context.close());
  const page = await context.newPage();
  if (clockTime) await page.clock.install({ time: clockTime });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], 'no browser exceptions'));
  // Every browser request is intercepted. No live Torn/backend traffic or real keys.
  await context.route('**/*', request => request.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(url);
  await page.evaluate(({ saved, cpr, deferProfile, deferPlanner, plannerSnapshot, cacheSchemaVersion }) => {
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
    window.testRequests = [];
    window.testPlannerRevisions = [];
    window.testProfileResponse = profile;
    window.testPlannerSnapshot = plannerSnapshot;
    window.testReadMemberPayload = () => JSON.parse(cache.get('askeladds_oc_planner_member_payload') || 'null');
    window.GM_xmlhttpRequest = options => {
      const url = new URL(options.url);
      window.testCalls.push(url.pathname);
      window.testRequests.push({ path: url.pathname, method: options.method || 'GET', data: options.data || '' });
      if (url.pathname.endsWith('/bot-alerts')) window.testPlannerRevisions.push(url.searchParams.get('revision'));
      const currentSnapshot = window.testPlannerSnapshot;
      const payload = options.url.includes('api.torn.com') ? window.testProfileResponse
        : currentSnapshot && url.pathname.endsWith('/bot-alerts')
          ? url.searchParams.get('revision') === currentSnapshot.revision
            ? { notModified: true, revision: currentSnapshot.revision, recommendationPolicy: currentSnapshot.recommendationPolicy }
            : currentSnapshot
          : { notModified: saved, recommendationPolicy: { mode: cpr ? 'cpr' : 'plan' } };
      const respond = () => options.onload({ status: 200, responseHeaders: 'content-type: application/json', responseText: JSON.stringify(payload) });
      if (deferProfile && options.url.includes('api.torn.com')) window.testResolveProfile = respond;
      else if (deferPlanner && url.pathname.endsWith('/bot-alerts')) window.testResolvePlanner = respond;
      else queueMicrotask(respond);
    };
    window.nativeJoins = 0;
    document.querySelector('.native-join')?.addEventListener('click', () => { window.nativeJoins++; });
  }, { saved, cpr, deferProfile, deferPlanner, plannerSnapshot, cacheSchemaVersion });
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

test('forgetting a key cancels obsolete profile results without blocking the next account',async t=>{
  const page=await open(t,{deferProfile:true});
  await page.locator(`${panel} .ocp-api-key`).fill('first-key');
  await page.locator(`${panel} .ocp-save-refresh`).click();
  await page.waitForFunction(()=>!!window.testResolveProfile);
  await page.evaluate(()=>{
    window.finishOldProfile=testResolveProfile;
    testMenu['OC Planner: forget API key']();
    window.testProfileResponse={player_id:456,name:'Next member',faction:{faction_id:41309}};
  });
  await page.locator(`${panel} .ocp-api-key`).fill('second-key');
  await page.locator(`${panel} .ocp-save-refresh`).click();
  await page.waitForFunction(()=>window.testResolveProfile!==window.finishOldProfile);
  await page.evaluate(()=>testResolveProfile());
  await page.waitForFunction(()=>testReadMemberPayload()?.memberId===456);
  await page.evaluate(()=>finishOldProfile());
  await page.waitForTimeout(100);
  assert.equal((await page.evaluate(()=>testReadMemberPayload())).memberId,456);
  assert.match(await page.locator(`${panel} .ocp-title`).innerText(),/Next member/);
  assert.equal(await page.evaluate(()=>testCalls.filter(path=>path.endsWith('/bot-alerts')).length),1,'discarded profile must not trigger a backend read');
});

test('forgetting a key cancels an obsolete backend response',async t=>{
  const page=await open(t,{saved:true,deferPlanner:true});
  await page.waitForFunction(()=>!!window.testResolvePlanner);
  await page.evaluate(()=>{
    window.finishOldPlanner=testResolvePlanner;
    testMenu['OC Planner: forget API key']();
    finishOldPlanner();
  });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>testReadMemberPayload()),null);
  assert.equal(await page.locator(`${panel} .ocp-api-key`).count(),1);
  assert.doesNotMatch(await page.locator(`${panel} .ocp-title`).innerText(),/Test member/);
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
  assert.equal(cached.schemaVersion, 12);
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

test('CPR guidance matches Guardian Angels source aliases to the real Torn crime', async t => {
  const snapshot = {
    revision:'guardian-fixture',recommendationPolicy:{mode:'cpr',cprRequirements:{}},
    planner:{id:'guardian-run',generatedAt:'2026-10-28T12:00:00.000Z',
      members:[{memberId:123,memberName:'Test member',crimes:{'Guardian Angels':{Driver:67}}}],
      crimes:[{id:101,name:'Guardian Ángels',difficulty:5,status:'Recruiting',openSlots:1,
        slots:[{position:'Driver',role:'Driver',minimumRecommendedCpr:55,maximumRecommendedCpr:77}]}]},
  };
  const page = await open(t,{cpr:true,html:fixture.replace('Test OC','Guardian Ángels'),plannerSnapshot:snapshot});
  await page.locator(`${panel} .ocp-api-key`).fill('test-only');
  await page.locator(`${panel} .ocp-save-refresh`).click();
  await page.locator('.askeladds-oc-planner-role-cpr-eligible').first().waitFor();
  const cached = await page.evaluate(()=>testReadMemberPayload());
  assert.equal(cached.payload.cprEligibleSlots.length,1);
  assert.equal(cached.payload.cprEligibleSlots[0].crimeName,'Guardian Ángels');
  assert.equal(cached.payload.cprMissingCount,0);
  assert.equal(await page.evaluate(()=>nativeJoins),0);
});

test('native numbered highlights use the same aliases as CPR and never select a numbered sibling', async t => {
  const html=fixture.replace(crime, `<article data-crime-id="101"><h3>Test OC</h3>
    <div class="slot-wrapper" data-position="Hustler #1"><span class="title">HUSTLER #1</span><button class="native-join">Join</button></div>
    <div class="slot-wrapper" data-position="Hustler #2"><span class="title">HUSTLER #2</span><button class="native-join">Join</button></div></article>`);
  for (const position of ['Hustler2','Hustler 2','Hustler # 2']) {
    const snapshot={revision:'native-alias-'+position,recommendationPolicy:{mode:'cpr'},planner:{id:'native-alias-run',
      members:[{memberId:123,crimes:{'Test OC':{Hustler1:90,Hustler2:65}}}],
      crimes:[{id:101,name:'Test OC',difficulty:3,status:'Recruiting',openSlots:2,
        slots:[{position,role:'Hustler',minimumRecommendedCpr:0,maximumRecommendedCpr:70}]}]}};
    const page=await open(t,{html,cpr:true,plannerSnapshot:snapshot});
    await page.locator(`${panel} .ocp-api-key`).fill('test-only');
    await page.locator(`${panel} .ocp-save-refresh`).click();
    await page.locator('.askeladds-oc-planner-role-cpr-eligible').first().waitFor();
    assert.deepEqual(await page.locator('.askeladds-oc-planner-role-cpr-eligible').evaluateAll(els=>els.map(el=>el.dataset.position)),['Hustler #2']);
    await page.locator('[data-position="Hustler #2"] .title').evaluate(el=>el.textContent='HUSTLER #3');
    await page.waitForFunction(()=>!document.querySelector('.askeladds-oc-planner-role-cpr-eligible'));
    assert.equal(await page.evaluate(()=>nativeJoins),0);
  }
});

test('real zero CPR is eligible in a zero band while invalid CPR and missing limits remain distinct', async t => {
  for (const [cpr,limits,eligible,missing,missingLimits] of [
    [0,{minimumRecommendedCpr:0,maximumRecommendedCpr:0},1,0,0],
    [null,{minimumRecommendedCpr:0,maximumRecommendedCpr:100},0,1,0],
    [65,{},0,0,1],
  ]) {
    const snapshot={revision:'zero-limits-fixture',recommendationPolicy:{mode:'cpr'},planner:{id:'zero-limits-run',
      members:[{memberId:123,crimes:{'Test OC':{Driver:cpr}}}],
      crimes:[{id:101,name:'Test OC',difficulty:3,status:'Recruiting',openSlots:1,
        slots:[{position:'Driver',role:'Driver',...limits}]}]}};
    const page=await open(t,{cpr:true,plannerSnapshot:snapshot});
    await page.locator(`${panel} .ocp-api-key`).fill('test-only');
    await page.locator(`${panel} .ocp-save-refresh`).click();
    await page.waitForFunction(()=>testReadMemberPayload()?.payload?.plannerRunId==='zero-limits-run');
    const payload=await page.evaluate(()=>testReadMemberPayload().payload);
    assert.equal(payload.cprEligibleSlots.length,eligible);
    assert.equal(payload.cprMissingCount,missing);
    assert.equal(payload.cprMissingLimitsCount,missingLimits);
    if (eligible) {
      await page.locator('.askeladds-oc-planner-role-cpr-eligible').first().waitFor();
      const callCount=await page.evaluate(()=>testCalls.length);
      await page.locator('article .slot').evaluate(el=>el.insertAdjacentHTML('beforeend','<div><a href="profiles.php?XID=999">Another member</a></div>'));
      await page.waitForFunction(()=>!document.querySelector('.askeladds-oc-planner-role-cpr-eligible'));
      assert.equal(await page.evaluate(()=>testCalls.length),callCount,'native role occupancy changes need no requests');
    }
    else assert.equal(await page.locator('.askeladds-oc-planner-role-cpr-eligible').count(),0);
    assert.match(await page.locator(`${panel} .ocp-cpr-counts`).innerText(),/open eligible/);
  }
});

test('copied diagnostics distinguish missing CPR from missing limits and contain no API key',async t=>{
  const snapshot={revision:'diagnostic-fixture',recommendationPolicy:{mode:'cpr'},planner:{id:'diagnostic-run',
    members:[{memberId:123,crimes:{'Test OC':{Driver:65}}}],
    crimes:[{id:101,name:'Test OC',difficulty:3,status:'Recruiting',openSlots:1,slots:[{position:'Driver',role:'Driver'}]}]}};
  const page=await open(t,{cpr:true,plannerSnapshot:snapshot});
  await page.locator(`${panel} .ocp-api-key`).fill('test-only');
  await page.locator(`${panel} .ocp-save-refresh`).click();
  await page.waitForFunction(()=>testReadMemberPayload()?.payload?.plannerRunId==='diagnostic-run');
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copiedDiagnostics=text;}}}));
  await page.locator(`${panel} .ocp-disclosure summary`).click();
  await page.locator(`${panel} .ocp-copy-diagnostics`).click();
  await page.waitForFunction(()=>!!window.copiedDiagnostics);
  const text=await page.evaluate(()=>copiedDiagnostics);
  const diagnostics=JSON.parse(text);
  assert.equal(diagnostics.cprEligibility.missingLimits,1);
  assert.equal(diagnostics.cprEligibility.missingCpr,0);
  assert.equal(diagnostics.cprEligibility.openRoles,1);
  assert.doesNotMatch(text,/test-only|keyCacheId|api_key/);
});

for (const cacheSchemaVersion of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
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

const queueTime = '2026-11-10T12:00:00Z';
const queueNow = Date.parse(queueTime) / 1000;
const queueHtml = fixture.replace(crime, `
  <article data-crime-id="101"><h3>Test OC</h3>
    <div class="slot-wrapper"><div class="slotHeader"><span class="title">Muscle #1</span></div>
      <button id="earlier" disabled>Join</button></div>
    <div class="slot-wrapper"><div class="slotHeader"><span class="title">Muscle #2</span></div>
      <button class="native-join"><span>Join</span></button><button id="leave">Leave</button></div>
  </article>
  <article data-crime-id="102"><h3>Test OC</h3>
    <div class="slot"><span class="title">Muscle #2</span><button id="other-crime">Join</button></div>
  </article>`);

function queueSnapshot(mode) {
  const filled = (position, currentUserId, currentProgress) => ({ position, currentUserId, currentProgress });
  const planned = (position, memberId, startHours) => ({
    position, recommended: { memberId, cpr: 80 }, plannedStartAt: queueNow + startHours * 3600,
  });
  const slots = mode === 'plan'
    ? [filled('Driver', 77, 50), planned('Muscle #1', 88, 12), planned('Hacker', 99, 36), planned('Muscle #2', 123, 60)]
    : [filled('Driver', 77, 0.9999), filled('Hacker', 88, 0), filled('Looter', 99, 0),
      { position: 'Muscle #2', minimumRecommendedCpr: 0, maximumRecommendedCpr: 100 }];
  return {
    revision: 'queue-' + mode, recommendationPolicy: { mode },
    planner: {
      id: 'queue-run', generatedAt: queueTime, snapshotKind: mode,
      crimes: [{ id: 101, status: 'Recruiting', name: 'Test OC', slots }],
      members: [{ memberId: 123, crimes: { 'Test OC': { 'Muscle #2': 80 } } }],
    },
  };
}

// Torn's CSS-module markup keeps the role title and Join in separate header/body
// children of the card, with additional title classes inside the body.
function nativeRole(position, cpr, { disabled = false, occupant, planningDegrees } = {}) {
  return `<div class="wrapper___a3${occupant ? '' : ' waitingJoin___b4'}" data-fixture-role="${position}">
    <div class="slotHeader___c5"><span class="title___d6">${position.toUpperCase()}
      <span class="successChance___e7">${cpr ?? '—'}</span></span>
      ${planningDegrees === undefined ? '' : `<span class="planning___m3" style="background: conic-gradient(var(--oc-clock-planning-bg) ${planningDegrees}deg, transparent 0)"></span>`}
    </div>
    <div class="slotBody___f8"><span class="title___g9">Role details</span>
      ${occupant ? `<a href="/profiles.php?XID=${occupant}">Occupied</a>` : `
        <div class="joinContainer___h0"><span>24hrs</span><div class="joinButtonContainer___j1">
          <button class="joinButton___k2"${disabled ? ' disabled' : ''}><span>Join</span></button>
        </div></div>`}
    </div></div>`;
}

function nativeCrime(id, roles) {
  return `<article data-oc-id="${id}"><h3 class="panelTitle___p3">Test OC</h3>${roles.join('')}</article>`;
}

function liveQueueSnapshot(mode, crimes) {
  return {
    revision: 'live-queue-' + mode, recommendationPolicy: { mode },
    planner: {
      id: 'live-queue-run', generatedAt: queueTime, snapshotKind: mode,
      crimes: crimes.map(({ id, slots }) => ({ id, slots, name: 'Test OC', status: 'Recruiting' })),
      members: [{ memberId: 123, crimes: { 'Test OC': { 'Muscle #2': 80 } } }],
    },
  };
}

const targetQueueSlot = { position: 'Muscle #2', minimumRecommendedCpr: 0, maximumRecommendedCpr: 100 };
const occupiedQueueSlot = (position, currentUserId, currentProgress) => ({ position, currentUserId, currentProgress });

for (const width of [1000, 375]) {
  test(`green, yellow and red roles explain their status without blocking yellow (${width}px)`, async t => {
    const joined = (count, firstProgress) => Array.from({ length: count }, (_, index) =>
      occupiedQueueSlot(['Driver', 'Lookout', 'Hacker'][index], 77 + index, index ? 0 : firstProgress));
    const joinedHtml = (count, firstDegrees) => Array.from({ length: count }, (_, index) =>
      nativeRole(['Driver', 'Lookout', 'Hacker'][index], 70, { occupant: 77 + index, planningDegrees: index ? 0 : firstDegrees }));
    const refused = { position: 'Robber', minimumRecommendedCpr: 85, maximumRecommendedCpr: 100 };
    const disabled = { position: 'Safecracker', minimumRecommendedCpr: 0, maximumRecommendedCpr: 100 };
    const snapshot = liveQueueSnapshot('cpr', [
      { id: 101, slots: [...joined(2, .5), targetQueueSlot, refused, disabled] },
      { id: 102, slots: [...joined(1, 0), targetQueueSlot] },
      { id: 103, slots: [...joined(3, 0), targetQueueSlot] },
    ]);
    Object.assign(snapshot.planner.members[0].crimes['Test OC'], { Robber: 80, Safecracker: 80 });
    const html = `<style>
      article{display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px}
      article>h3{flex-basis:100%;margin:2px 0 6px}
      [data-fixture-role]{width:122px;flex:0 0 122px;overflow:hidden}
      .slotHeader___c5,.slotBody___f8{padding:5px;box-sizing:border-box}
      .slotHeader___c5{font-size:11px;font-weight:bold}
      .slotBody___f8{font-size:12px;min-height:45px}
      .slotBody___f8>.title___g9{display:none}
      .joinContainer___h0{display:flex;align-items:center;gap:4px}
      .joinContainer___h0>span{background:#151515;border:1px solid #777;border-radius:4px;padding:4px}
      .joinButton___k2{background:linear-gradient(#141414,#343434);color:#eee;border:1px solid #777;border-radius:4px;padding:4px 10px}
    </style>` + fixture.replace(crime,
      nativeCrime(101, [...joinedHtml(2, 180), nativeRole('Muscle #2', 80), nativeRole('Robber', 80), nativeRole('Safecracker', 80, { disabled: true })]) +
      nativeCrime(102, [...joinedHtml(1, 0), nativeRole('Muscle #2', 80)]) +
      nativeCrime(103, [...joinedHtml(3, 0), nativeRole('Muscle #2', 80)]));
    const page = await open(t, { saved: true, cpr: true, width, html, plannerSnapshot: snapshot, clockTime: queueTime });
    const role = (id, position = 'Muscle #2') => page.locator(`[data-oc-id="${id}"] [data-fixture-role="${position}"]`);
    await role(101).locator('.ocp-queue-warning-reason').waitFor();
    assert.equal(await role(101).locator('.ocp-queue-warning-reason').innerText(), 'CPR 80% · >24h planning ahead');
    assert.match(await role(101).getAttribute('class'), /role-queue-warning/);
    assert.equal(await role(101).locator('button').isEnabled(), true);
    assert.equal(await role(101).locator('button').getAttribute('aria-disabled'), null);
    assert.equal(await role(102).locator('.ocp-eligible-reason').innerText(), 'Eligible · CPR 80%', 'exactly 24h remains green');
    assert.match(await role(103).getAttribute('class'), /role-queue-full/);
    assert.equal(await role(103).locator('button').isDisabled(), true);
    assert.match(await role(101, 'Robber').getAttribute('class'), /role-cpr-blocked/);
    assert.equal(await role(101, 'Robber').locator('button').isDisabled(), true, 'yellow never overrides CPR');
    assert.equal(await role(101, 'Safecracker').locator('button').isDisabled(), true, 'Torn retains its own block');
    const colors = await role(101).evaluate(el => getComputedStyle(el).backgroundColor.match(/\d+/g).map(Number));
    assert.ok(colors[0] > colors[1] && colors[1] > colors[2], 'yellow has a distinct warm background');
    const requests = await page.evaluate(() => testCalls.length);
    await role(101).locator('button').evaluate(button => { button.addEventListener('click', () => { window.nativeJoins++; }); button.click(); });
    assert.equal(await page.evaluate(() => nativeJoins), 1);
    await page.waitForTimeout(200);
    assert.equal(await role(101).locator('.ocp-queue-warning-reason').count(), 1, 'no repeated labels');
    assert.equal(await page.evaluate(() => testCalls.length), requests);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(__dirname, `../test-results/role-colors-${width}.png`), fullPage: true });

    const driver = role(101, 'Driver').locator('.planning___m3');
    await driver.evaluate(el => el.style.background = 'conic-gradient(var(--oc-clock-planning-bg) 360deg, transparent 0)');
    await role(101).locator('.ocp-eligible-reason').waitFor();
    assert.equal(await role(101).locator('.ocp-queue-warning-reason').count(), 0, 'live progress clears yellow at 24h');
    await driver.evaluate(el => el.style.background = 'conic-gradient(var(--oc-clock-planning-bg) 180deg, transparent 0)');
    await role(101).locator('.ocp-queue-warning-reason').waitFor();
    await role(101, 'Lookout').evaluate((el, replacement) => { el.outerHTML = replacement; }, nativeRole('Lookout', 70));
    await role(101).locator('.ocp-eligible-reason').waitFor();
    assert.equal(await page.evaluate(() => testCalls.length), requests, 'live progress and leaves make no requests');
  });
}

test('yellow warning has its own configurable threshold and stays active with queue blocking off', async t => {
  const slots = [occupiedQueueSlot('Driver', 77, .5), occupiedQueueSlot('Lookout', 88, 0), targetQueueSlot];
  const snapshot = liveQueueSnapshot('cpr', [{ id: 101, slots }]);
  snapshot.recommendationPolicy.planningQueueLimitHours = 0;
  const html = fixture.replace(crime, nativeCrime(101, [
    nativeRole('Driver', 70, { occupant: 77, planningDegrees: 180 }),
    nativeRole('Lookout', 70, { occupant: 88, planningDegrees: 0 }), nativeRole('Muscle #2', 80),
  ]));
  const page = await open(t, { saved: true, cpr: true, html, plannerSnapshot: snapshot, clockTime: queueTime });
  const role = page.locator('[data-fixture-role="Muscle #2"]');
  await role.locator('.ocp-queue-warning-reason').waitFor();
  for (const hours of [36, 12, 0]) {
    await page.evaluate(hours => {
      testPlannerSnapshot.revision = `warning-${hours}`;
      testPlannerSnapshot.recommendationPolicy.planningQueueWarningHours = hours;
      testMenu['OC Planner: refresh']();
    }, hours);
    await page.waitForFunction(hours => testReadMemberPayload()?.payload?.planningQueueWarningHours === hours, hours);
    assert.equal(await role.locator('.ocp-queue-warning-reason').count(), hours === 12 ? 1 : 0);
    assert.equal(await role.locator('button').isEnabled(), true);
    if (hours === 12) assert.match(await role.innerText(), />12h planning ahead/);
  }
});

test('saved yellow planning crosses the threshold locally and unreadable live progress preserves it', async t => {
  const snapshot = queueSnapshot('cpr');
  snapshot.planner.crimes[0].slots = [
    occupiedQueueSlot('Driver', 77, .99997), occupiedQueueSlot('Lookout', 88, 0), targetQueueSlot,
  ];
  const page = await open(t, { saved: true, cpr: true, html: queueHtml, plannerSnapshot: snapshot, clockTime: queueTime });
  const role = page.locator('[data-crime-id="101"] .slot-wrapper').last();
  await role.locator('.ocp-queue-warning-reason').waitFor();
  const requests = await page.evaluate(() => testCalls.length);
  await page.clock.fastForward(4_000);
  await role.locator('.ocp-eligible-reason').waitFor();
  assert.equal(await role.locator('button.native-join').isEnabled(), true);
  assert.equal(await page.evaluate(() => testCalls.length), requests, 'crossing the boundary needs no refresh');
});

test('yellow counts joined planning rather than future recommendations in a complete plan', async t => {
  const snapshot = queueSnapshot('plan');
  snapshot.recommendationPolicy.planningQueueLimitHours = 0;
  const page = await open(t, { saved: true, html: queueHtml, plannerSnapshot: snapshot, clockTime: queueTime });
  await page.waitForFunction(() => testReadMemberPayload()?.payload?.plannerRunId === 'queue-run');
  assert.equal(await page.locator('.ocp-queue-warning-reason').count(), 0, '12h joined planning stays below 24h despite future turns');
  assert.equal(await page.locator('[data-ocp-queue-locked]').count(), 0);
});

test('visible Torn joins, progress-only updates, and leaves recalculate the CPR queue locally', async t => {
  const nativeDriver = nativeRole('Driver', 70, { occupant: 77, planningDegrees: 0 });
  const nativeLookout = nativeRole('Lookout', 70, { occupant: 88, planningDegrees: 0 });
  const openHacker = nativeRole('Hacker', 70);
  const joinedHacker = nativeRole('Hacker', 70, { occupant: 99, planningDegrees: 0 });
  const nativeTarget = nativeRole('Muscle #2', 80);
  const html = fixture.replace(crime,
    nativeCrime(101, [nativeDriver, nativeLookout, openHacker, nativeTarget]) +
    nativeCrime(102, [nativeTarget]));
  const snapshot = liveQueueSnapshot('cpr', [
    { id: 101, slots: [occupiedQueueSlot('Driver', 77, 0), occupiedQueueSlot('Lookout', 88, 0),
      { position: 'Hacker' }, targetQueueSlot] },
    { id: 102, slots: [targetQueueSlot] },
  ]);
  const page = await open(t, { saved: true, cpr: true, html, plannerSnapshot: snapshot, clockTime: queueTime });
  await page.waitForFunction(() => testReadMemberPayload()?.payload?.plannerRunId === 'live-queue-run');
  const card = page.locator('[data-oc-id="101"]');
  const join = card.locator('[data-fixture-role="Muscle #2"] button');
  const lock = card.locator('[data-ocp-queue-locked]');
  const requestCount = await page.evaluate(() => testCalls.length);
  assert.equal(await join.isEnabled(), true, 'two full turns are exactly 48 hours');

  await page.evaluate(html => {
    const card = document.querySelector('[data-oc-id="101"]');
    const button = card.querySelector('[data-fixture-role="Muscle #2"] button');
    button.addEventListener('click', () => { window.nativeJoins++; });
    card.querySelector('[data-fixture-role="Hacker"]').outerHTML = html;
    button.click();
  }, joinedHacker);
  assert.equal(await page.evaluate(() => nativeJoins), 0, 'the new queue blocks a click before the observer runs');
  await lock.waitFor({ timeout: 5000 });
  assert.equal(await join.isDisabled(), true);
  assert.equal(await page.locator('[data-oc-id="102"] button').isEnabled(), true);

  const progress = card.locator('[data-fixture-role="Driver"] .planning___m3');
  await progress.evaluate(el => {
    el.setAttribute('style', 'background: conic-gradient(var(--oc-clock-planning-bg) 360deg, transparent 0)');
  });
  await lock.waitFor({ state: 'detached', timeout: 5000 });
  assert.equal(await join.isEnabled(), true, 'a completed turn leaves exactly two full turns');

  await progress.evaluate(el => {
    el.setAttribute('style', 'background: conic-gradient(var(--oc-clock-planning-bg) 180deg, transparent 0)');
  });
  await lock.waitFor({ timeout: 5000 });
  await card.locator('[data-fixture-role="Hacker"]').evaluate((el, html) => { el.outerHTML = html; }, openHacker);
  await lock.waitFor({ state: 'detached', timeout: 5000 });
  await join.click();
  assert.equal(await page.evaluate(() => nativeJoins), 1);
  assert.equal(await page.evaluate(() => testCalls.length), requestCount);
});

test('unreadable native progress falls back to the saved queue instead of guessing a lock', async t => {
  const roles = [
    nativeRole('Driver', 75, { occupant: 77 }),
    nativeRole('Lookout', 75, { occupant: 88, planningDegrees: 0 }),
    nativeRole('Hacker', 75, { occupant: 99, planningDegrees: 0 }),
    nativeRole('Muscle #2', 80),
  ];
  const html = fixture.replace(crime, nativeCrime(101, roles) + nativeCrime(102, roles));
  const slots = progress => [occupiedQueueSlot('Driver', 77, progress), occupiedQueueSlot('Lookout', 88, 0),
    occupiedQueueSlot('Hacker', 99, 0), targetQueueSlot];
  const snapshot = liveQueueSnapshot('cpr', [{ id: 101, slots: slots(1) }, { id: 102, slots: slots(0.5) }]);
  const page = await open(t, { saved: true, cpr: true, html, plannerSnapshot: snapshot, clockTime: queueTime });
  await page.locator('[data-oc-id="102"] [data-ocp-queue-locked]').waitFor({ timeout: 5000 });
  assert.equal(await page.locator('[data-oc-id="101"] [data-fixture-role="Muscle #2"] button').isEnabled(), true);
});

test('the faction queue limit applies to both native and saved work and can be disabled without lifting CPR rules', async t => {
  const roles = planningDegrees => [
    nativeRole('Driver', 75, { occupant: 77, planningDegrees }),
    nativeRole('Lookout', 75, { occupant: 88, planningDegrees: 0 }),
    nativeRole('Hacker', 80),
    nativeRole('Muscle #2', 80),
  ];
  const html = fixture.replace(crime, nativeCrime(101, roles(180)) + nativeCrime(102, roles(undefined)));
  const slots = [occupiedQueueSlot('Driver', 77, 0.5), occupiedQueueSlot('Lookout', 88, 0),
    { position: 'Hacker', minimumRecommendedCpr: 0, maximumRecommendedCpr: 60 }, targetQueueSlot];
  const snapshot = liveQueueSnapshot('cpr', [{ id: 101, slots }, { id: 102, slots }]);
  snapshot.recommendationPolicy.planningQueueLimitHours = 24;
  snapshot.planner.members[0].crimes['Test OC'].Hacker = 80;
  const page = await open(t, { saved: true, cpr: true, html, plannerSnapshot: snapshot, clockTime: queueTime });
  const joins = page.locator('[data-fixture-role="Muscle #2"] button');
  const queueLabels = page.getByText('Queue full · over 24h of planning ahead', { exact: true });
  await queueLabels.last().waitFor();
  assert.equal(await queueLabels.count(), 4);
  assert.equal(await joins.first().isDisabled(), true);
  assert.equal(await joins.last().isDisabled(), true);
  const tornCalls = await page.evaluate(() => testCalls.filter(path => path === '/user/').length);

  await page.evaluate(() => {
    testPlannerSnapshot.revision = 'queue-limit-disabled';
    testPlannerSnapshot.recommendationPolicy.planningQueueLimitHours = 0;
  });
  await page.clock.fastForward(5 * 60 * 1000 + 500);
  await page.waitForFunction(() => testReadMemberPayload()?.payload?.planningQueueLimitHours === 0);
  await queueLabels.first().waitFor({ state: 'detached' });
  assert.equal(await joins.first().isEnabled(), true);
  assert.equal(await joins.last().isEnabled(), true);
  assert.equal(await page.locator('[data-ocp-cpr-locked]').count(), 2);
  assert.equal(await page.evaluate(() => testCalls.filter(path => path === '/user/').length), tornCalls);
});

function queueFallbackFixture(otherSlots, otherRoles = []) {
  const occupied = [
    occupiedQueueSlot('Driver', 77, 0),
    occupiedQueueSlot('Lookout', 88, 0),
    occupiedQueueSlot('Hacker', 99, 0),
  ];
  const roles = occupied.map(slot => nativeRole(slot.position, 75, {
    occupant: slot.currentUserId, planningDegrees: 0,
  }));
  const refusedSlot = { position: 'Robber', minimumRecommendedCpr: 80, maximumRecommendedCpr: 100 };
  const nativeDisabledSlot = { position: 'Safecracker', minimumRecommendedCpr: 0, maximumRecommendedCpr: 100 };
  const snapshot = liveQueueSnapshot('cpr', [
    { id: 101, slots: [...occupied, targetQueueSlot, refusedSlot, nativeDisabledSlot] },
    { id: 102, slots: otherSlots },
  ]);
  snapshot.recommendationPolicy.allowPlanningQueueFallback = true;
  Object.assign(snapshot.planner.members[0].crimes['Test OC'], { 'Muscle #1': 80, Robber: 70, Safecracker: 80 });
  const html = fixture.replace(crime, nativeCrime(101, [
    ...roles, nativeRole('Muscle #2', 80), nativeRole('Robber', 70), nativeRole('Safecracker', 80, { disabled: true }),
  ]) + (otherRoles.length ? nativeCrime(102, otherRoles) : ''));
  return { html, plannerSnapshot: snapshot };
}

test('the last-resort exception follows live openings without bypassing CPR or Torn availability', async t => {
  const alternative = { position: 'Muscle #1', minimumRecommendedCpr: 0, maximumRecommendedCpr: 100 };
  const occupiedAlternative = nativeRole('Muscle #1', 80, { occupant: 109, planningDegrees: 0 });
  const page = await open(t, {
    saved: true, cpr: true, clockTime: queueTime,
    ...queueFallbackFixture([{ ...alternative, currentUserId: 109, currentProgress: 0 }], [occupiedAlternative]),
  });
  const role = page.locator('[data-oc-id="101"] [data-fixture-role="Muscle #2"]');
  const exception = role.locator('.ocp-queue-fallback-reason');
  const join = role.getByRole('button', { name: 'Join' });
  const alternativeRole = page.locator('[data-oc-id="102"] [data-fixture-role="Muscle #1"]');
  await exception.waitFor();
  assert.equal(await join.isEnabled(), true);
  assert.equal(await page.locator('[data-fixture-role="Robber"] button').isDisabled(), true);
  assert.equal(await page.locator('[data-fixture-role="Safecracker"] button').isDisabled(), true);
  assert.equal(await page.locator('[data-fixture-role="Safecracker"] .ocp-queue-fallback-reason').count(), 0);
  const requestCount = await page.evaluate(() => testCalls.length);

  await join.evaluate(el => el.addEventListener('click', () => { window.nativeJoins++; }));
  await join.click();
  assert.equal(await page.evaluate(() => nativeJoins), 1);
  await alternativeRole.evaluate((el, openRole) => {
    el.outerHTML = openRole;
    // A join attempted before the observer paints must still see the new opening.
    document.querySelector('[data-fixture-role="Muscle #2"] button').click();
  }, nativeRole('Muscle #1', 80));
  assert.equal(await page.evaluate(() => nativeJoins), 1);
  await role.locator('[data-ocp-queue-locked]').waitFor();
  await exception.waitFor({ state: 'detached' });
  assert.equal(await alternativeRole.getByRole('button', { name: 'Join' }).isEnabled(), true);

  await alternativeRole.evaluate((el, occupiedRole) => { el.outerHTML = occupiedRole; }, occupiedAlternative);
  await exception.waitFor();
  assert.equal(await join.isEnabled(), true);
  assert.equal(await page.evaluate(() => testCalls.length), requestCount);
});

test('a saved eligible opening elsewhere prevents the exception until that role is filled', async t => {
  const alternative = { position: 'Muscle #1', minimumRecommendedCpr: 0, maximumRecommendedCpr: 100 };
  const page = await open(t, {
    saved: true, cpr: true, clockTime: queueTime,
    ...queueFallbackFixture([alternative]),
  });
  const role = page.locator('[data-fixture-role="Muscle #2"]');
  const exception = role.locator('.ocp-queue-fallback-reason');
  const join = role.getByRole('button', { name: 'Join' });
  await role.locator('[data-ocp-queue-locked]').waitFor();
  assert.equal(await exception.count(), 0);
  assert.equal(await join.isDisabled(), true);
  const tornCalls = await page.evaluate(() => testCalls.filter(path => path === '/user/').length);

  await page.evaluate(() => {
    testPlannerSnapshot.revision = 'queue-fallback-no-alternative';
    Object.assign(testPlannerSnapshot.planner.crimes[1].slots[0], { currentUserId: 109, currentProgress: 0 });
  });
  await page.clock.fastForward(5 * 60 * 1000 + 500);
  await exception.waitFor();
  assert.equal(await join.isEnabled(), true);
  assert.equal(await page.evaluate(() => testCalls.filter(path => path === '/user/').length), tornCalls);
});

test('the full-plan exception is scoped to the member’s own recommendation', async t => {
  const occupied = [
    occupiedQueueSlot('Driver', 77, 0),
    occupiedQueueSlot('Lookout', 88, 0),
    occupiedQueueSlot('Hacker', 99, 0),
  ];
  const planned = (position, memberId, hours) => ({
    position, minimumRecommendedCpr: 0, maximumRecommendedCpr: 100,
    recommended: { memberId, cpr: 80, available: 'now' },
    plannedStartAt: queueNow + hours * 3600,
  });
  const snapshot = liveQueueSnapshot('plan', [
    { id: 101, slots: [...occupied, planned('Muscle #2', 123, 72), planned('Robber', 456, 96)] },
    { id: 102, slots: [planned('Muscle #1', 789, 0)] },
  ]);
  snapshot.recommendationPolicy.allowPlanningQueueFallback = true;
  snapshot.planner.members[0].crimes['Test OC']['Muscle #1'] = 80;
  const html = fixture.replace(crime, nativeCrime(101, [
    ...occupied.map(slot => nativeRole(slot.position, 75, { occupant: slot.currentUserId, planningDegrees: 0 })),
    nativeRole('Muscle #2', 80), nativeRole('Robber', 80),
  ]) + nativeCrime(102, [nativeRole('Muscle #1', 80)]));
  const page = await open(t, { saved: true, html, plannerSnapshot: snapshot, clockTime: queueTime });
  const own = page.locator('[data-fixture-role="Muscle #2"]');
  const otherLong = page.locator('[data-fixture-role="Robber"]');
  await own.locator('.ocp-queue-fallback-reason').waitFor();
  assert.equal(await own.getByRole('button', { name: 'Join' }).isEnabled(), true);
  assert.equal(await otherLong.locator('[data-ocp-queue-locked]').isDisabled(), true);
  assert.equal(await otherLong.locator('.ocp-queue-fallback-reason').count(), 0);
  assert.equal(await page.locator('[data-fixture-role="Muscle #1"] button').isEnabled(), true);
});

test('the live full-plan queue counts a scheduled member only once after they join another role', async t => {
  const roles = [nativeRole('Driver', 75, { occupant: 77, planningDegrees: 180 }),
    nativeRole('Lookout', 75), nativeRole('Hacker', 75), nativeRole('Muscle #2', 80)];
  const html = fixture.replace(crime, nativeCrime(101, roles));
  const snapshot = liveQueueSnapshot('plan', [{ id: 101, slots: [
    occupiedQueueSlot('Driver', 77, 50), { position: 'Lookout' },
    { position: 'Hacker', recommended: { memberId: 99, cpr: 75 }, plannedStartAt: queueNow + 60 * 3600 }, targetQueueSlot,
  ] }]);
  const page = await open(t, { saved: true, html, plannerSnapshot: snapshot, clockTime: queueTime });
  await page.waitForFunction(() => testReadMemberPayload()?.payload?.plannerRunId === 'live-queue-run');
  const join = page.locator('[data-fixture-role="Muscle #2"] button');
  const requestCount = await page.evaluate(() => testCalls.length);
  assert.equal(await join.isEnabled(), true);

  await page.evaluate(html => {
    document.querySelector('[data-fixture-role="Lookout"]').outerHTML = html;
    window.clicked = false;
    const join = document.querySelector('[data-fixture-role="Muscle #2"] button');
    join.addEventListener('click', () => { window.clicked = true; }, { once: true });
    join.click();
  }, nativeRole('Lookout', 75, { occupant: 99, planningDegrees: 0 }));
  assert.equal(await page.evaluate(() => clicked), true, 'the former reservation does not count after its member joins');
  assert.equal(await join.isEnabled(), true);

  await page.locator('[data-fixture-role="Hacker"]').evaluate((el, html) => { el.outerHTML = html; },
    nativeRole('Hacker', 75, { occupant: 88, planningDegrees: 0 }));
  await page.locator('[data-fixture-role="Muscle #2"] [data-ocp-queue-locked]').waitFor({ timeout: 5000 });
  assert.equal(await join.isDisabled(), true);
  assert.equal(await page.evaluate(() => testCalls.length), requestCount);
});

test('Torn native cards show distinct CPR and queue colors and stop only the blocked Join buttons', async t => {
  const withinBand = { minimumRecommendedCpr: 65, maximumRecommendedCpr: 85 };
  const openSlot = position => ({ position, ...withinBand });
  const filled = (position, currentUserId, currentProgress) => ({ position, currentUserId, currentProgress });
  const html = fixture.replace(crime,
    nativeCrime(101, [
      nativeRole('Muscle #1', 74),
      nativeRole('Muscle #2', 58),
      nativeRole('Driver', null),
      nativeRole('Hacker', 90, { disabled: true }),
    ]) + nativeCrime(102, [
      nativeRole('Muscle #2', 58),
      nativeRole('Driver', null, { occupant: 77 }),
      nativeRole('Lookout', null, { occupant: 88 }),
      nativeRole('Hacker', null, { occupant: 99 }),
    ]));
  const snapshot = {
    revision: 'native-cards', recommendationPolicy: { mode: 'cpr' },
    planner: {
      id: 'native-cards-run', generatedAt: queueTime, snapshotKind: 'cpr',
      crimes: [
        { id: 101, status: 'Recruiting', name: 'Test OC', openSlots: 4,
          slots: ['Muscle #1', 'Muscle #2', 'Driver', 'Hacker'].map(openSlot) },
        { id: 102, status: 'Recruiting', name: 'Test OC', openSlots: 1,
          slots: [openSlot('Muscle #2'), filled('Driver', 77, 0.5), filled('Lookout', 88, 0), filled('Hacker', 99, 0)] },
      ],
      members: [{ memberId: 123, crimes: { 'Test OC': { 'Muscle #1': 74, 'Muscle #2': 58, Hacker: 90 } } }],
    },
  };
  const page = await open(t, { saved: true, cpr: true, html, plannerSnapshot: snapshot, clockTime: queueTime, width: 375 });
  const role = (id, name) => page.locator(`[data-oc-id="${id}"] [data-fixture-role="${name}"]`);
  const green = 'askeladds-oc-planner-role-cpr-eligible';
  const red = 'askeladds-oc-planner-role-cpr-blocked';
  const queue = 'askeladds-oc-planner-role-queue-full';
  await page.locator(`[data-fixture-role].${queue}`).waitFor({ timeout: 5000 });
  assert.match(await role(101, 'Muscle #1').getAttribute('class'), new RegExp(green));
  assert.equal(await role(101, 'Muscle #1').locator('.ocp-eligible-reason').innerText(), 'Eligible · CPR 74%');
  assert.equal(await role(101, 'Muscle #1').locator('.ocp-queue-fallback-reason').count(), 0);
  assert.match(await role(101, 'Muscle #2').getAttribute('class'), new RegExp(red));
  assert.match(await role(102, 'Muscle #2').getAttribute('class'), new RegExp(queue));
  assert.doesNotMatch(await role(102, 'Muscle #2').getAttribute('class'), new RegExp(red));
  assert.doesNotMatch(await role(101, 'Driver').getAttribute('class'), new RegExp(`${red}|${green}|${queue}`));
  for (const [card, color] of [[role(101, 'Muscle #1'), 'green'], [role(101, 'Muscle #2'), 'red'], [role(102, 'Muscle #2'), 'red']]) {
    const colors = await card.locator('.slotHeader___c5, .slotBody___f8').evaluateAll(
      parts => parts.map(part => getComputedStyle(part).backgroundColor),
    );
    assert.equal(colors.length, 2);
    for (const value of colors) {
      const [redChannel, greenChannel] = value.match(/\d+/g).map(Number);
      assert.ok(color === 'green' ? greenChannel > redChannel : redChannel > greenChannel, `${color} card uses ${value}`);
    }
  }
  assert.equal(await role(101, 'Driver').getByRole('button', { name: 'Join' }).isEnabled(), true);
  const cprBlocked = role(101, 'Muscle #2').getByRole('button', { name: 'Join' });
  const queueBlocked = role(102, 'Muscle #2').getByRole('button', { name: 'Join' });
  const tornDisabled = role(101, 'Hacker').getByRole('button', { name: 'Join' });
  assert.equal(await cprBlocked.getAttribute('aria-disabled'), 'true');
  assert.equal(await queueBlocked.getAttribute('aria-disabled'), 'true');
  assert.equal(await role(101, 'Muscle #2').getByText(/CPR 58%.*needs 65%/).isVisible(), true);
  assert.equal(await role(101, 'Hacker').getByText(/CPR 90%.*max 85%/).isVisible(), true);
  assert.equal(await role(102, 'Muscle #2').getByText(/Queue full/).isVisible(), true);
  assert.equal(await tornDisabled.isDisabled(), true);

  await page.evaluate(() => {
    window.joinedRoles = [];
    document.addEventListener('click', event => {
      const button = event.target.closest('button[class*="joinButton___"]');
      if (button) joinedRoles.push(button.closest('[data-fixture-role]').dataset.fixtureRole);
    });
  });
  const requestCount = await page.evaluate(() => testCalls.length);
  await cprBlocked.evaluate(button => button.click());
  await queueBlocked.evaluate(button => button.click());
  await role(101, 'Muscle #1').getByRole('button', { name: 'Join' }).click();
  assert.deepEqual(await page.evaluate(() => joinedRoles), ['Muscle #1']);
  assert.equal(await page.evaluate(() => testCalls.length), requestCount);

  await page.evaluate(() => {
    testPlannerSnapshot.revision = 'native-cards-updated';
    const cpr = testPlannerSnapshot.planner.members[0].crimes['Test OC'];
    cpr['Muscle #2'] = 72;
    cpr.Hacker = 75;
    testMenu['OC Planner: refresh']();
  });
  await page.waitForFunction(() => testReadMemberPayload()?.snapshotRevision === 'native-cards-updated');
  assert.equal(await cprBlocked.isEnabled(), true);
  assert.match(await role(101, 'Muscle #2').getAttribute('class'), new RegExp(green));
  assert.equal(await role(101, 'Muscle #2').locator('.ocp-eligible-reason').innerText(), 'Eligible · CPR 72%');
  assert.equal(await role(101, 'Muscle #2').locator('.ocp-cpr-reason').count(), 0);
  assert.equal(await tornDisabled.getAttribute('aria-disabled'), null);
  assert.equal(await tornDisabled.isDisabled(), true);
  assert.equal(await queueBlocked.isDisabled(), true);

  await page.evaluate(() => testMenu['OC Planner: forget API key']());
  assert.equal(await cprBlocked.getAttribute('aria-disabled'), null);
  assert.equal(await queueBlocked.getAttribute('aria-disabled'), null);
  assert.equal(await tornDisabled.isDisabled(), true);
});

test('full plan disables only the exact Join with over 48h ahead, and restores it after a fresh plan', async t => {
  const page = await open(t, { saved: true, html: queueHtml, plannerSnapshot: queueSnapshot('plan'), clockTime: queueTime });
  const join = page.locator('.native-join');
  await page.getByText('Queue full · over 48h of planning ahead', { exact: true }).waitFor();
  assert.equal(await join.isDisabled(), true);
  assert.equal(await page.locator('#leave').isEnabled(), true);
  assert.equal(await page.locator('#other-crime').isEnabled(), true);
  assert.equal(await page.locator('#earlier').isDisabled(), true);
  await join.locator('span').dispatchEvent('click');
  await join.evaluate(button => button.click());
  await join.focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => nativeJoins), 0);

  await page.evaluate(() => {
    const snapshot = testPlannerSnapshot;
    snapshot.revision = 'exactly-48';
    snapshot.planner.crimes[0].slots[0].currentProgress = 100;
    testMenu['OC Planner: refresh']();
  });
  await page.getByText('Queue full · over 48h of planning ahead', { exact: true }).waitFor({ state: 'detached' });
  assert.equal(await join.isEnabled(), true);
  assert.equal(await page.locator('#earlier').isDisabled(), true);
  await join.click();
  assert.equal(await page.evaluate(() => nativeJoins), 1);
});

test('CPR mode restores Join at 48h without a request and follows replaced role controls', async t => {
  const page = await open(t, { saved: true, cpr: true, html: queueHtml, width: 375, plannerSnapshot: queueSnapshot('cpr'), clockTime: queueTime });
  const lock = page.locator('[data-ocp-queue-locked]');
  await lock.waitFor();
  assert.equal(await page.locator('.askeladds-oc-planner-role-cpr-eligible').count(), 0);
  await page.evaluate(() => {
    const old = document.querySelector('.native-join');
    const replacement = document.createElement('button');
    replacement.className = old.className;
    replacement.textContent = 'Join';
    replacement.addEventListener('click', () => { window.nativeJoins++; });
    old.replaceWith(replacement);
    replacement.click();
  });
  assert.equal(await page.evaluate(() => nativeJoins), 0, 'a tap before the observer runs is blocked');
  await lock.waitFor();
  assert.equal(await page.locator('.ocp-queue-reason').count(), 1);
  const requestCount = await page.evaluate(() => testCalls.length);
  await page.clock.fastForward(9_000);
  await lock.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.native-join').isEnabled(), true);
  await page.locator('.native-join').click();
  assert.equal(await page.evaluate(() => nativeJoins), 1);
  assert.equal(await page.locator('.askeladds-oc-planner-role-queue-warning').count(), 1);
  assert.equal(await page.evaluate(() => testCalls.length), requestCount);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test('leaving the OC page removes its queue lock and preserves Torn’s disabled state', async t => {
  const page = await open(t, { saved: true, html: queueHtml, plannerSnapshot: queueSnapshot('plan'), clockTime: queueTime });
  const join = page.locator('.native-join');
  await page.locator('[data-ocp-queue-locked]').waitFor();
  await join.evaluate(button => { button.disabled = true; });
  await page.evaluate(() => { location.hash = '/tab=members'; });
  await page.locator('[data-ocp-queue-locked]').waitFor({ state: 'detached' });
  assert.equal(await join.isDisabled(), true);
  assert.equal(await join.getAttribute('aria-disabled'), null);
  assert.equal(await page.locator('.ocp-queue-reason').count(), 0);
});

for (const status of ['ready', 'missing', 'refreshing']) {
  test(`CPR mode records installed version and last use with a ${status} snapshot, independently of a complete plan`, async t => {
    const snapshot = status === 'ready' ? numberedSnapshot : {
      revision: 'cpr-' + status,
      planner: null,
      recommendationPolicy: { mode: 'cpr', cprSnapshotStatus: status === 'refreshing' ? 'refreshing' : 'waiting', snapshotSource: 'missing' },
    };
    const page = await open(t, { cpr: true, plannerSnapshot: snapshot });
    await page.locator(`${panel} .ocp-api-key`).fill('test-only');
    await page.locator(`${panel} .ocp-save-refresh`).click();
    await page.waitForFunction(() => testCalls.some(path => path.endsWith('/script-access')));
    const requests = await page.evaluate(() => testRequests);
    const checkIns = requests.filter(request => request.path.endsWith('/script-access'));
    assert.equal(checkIns.length, 1);
    const payload = JSON.parse(checkIns[0].data);
    assert.equal(payload.playerId, 123);
    assert.equal(String(payload.factionId), '41309');
    assert.equal(payload.scriptVersion, source.match(/@version\s+(\S+)/)[1]);
    assert.equal(payload.key, undefined, 'no Torn API key is sent to check-ins');
    assert.equal(requests.filter(request => request.path === '/user/').length, 1, 'no extra Torn calls for check-in');
    assert.equal(await page.evaluate(() => nativeJoins), 0);
  });
}
