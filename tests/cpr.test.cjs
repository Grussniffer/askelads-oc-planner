const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');

// Exercise the installed userscript's lookup, not a duplicate implementation.
const source = readFileSync(join(__dirname, '../oc-planner-recommendations.user.js'), 'utf8');
const start = source.indexOf('\tconst getMemberCprForSlot =');
const end = source.indexOf('\tconst memberFitsSlotBand =', start);
assert.ok(start >= 0 && end > start);
const getCpr = runInNewContext(`
  const normalizeText = ${source.match(/const normalizeText = ([\s\S]*?);/)[1]};
  ${source.slice(start, end)}
  getMemberCprForSlot;
`);
const crime = { name: 'Window of Opportunity' };
const lookup = (roles, position = 'Muscle #2', role = 'Muscle') => getCpr(
  { members: [{ memberId: 123, crimes: { 'Window of Opportunity': roles } }] },
  123, crime, { position, role },
);

test('reads each numbered position rather than treating its CPR as missing', () => {
  const roles = { Engineer: 84, 'Looter #1': 85, 'Looter #2': 85, 'Muscle #1': 86, 'Muscle #2': 86 };
  assert.equal(lookup(roles, 'Engineer', 'Engineer'), 84);
  assert.equal(lookup(roles, 'Looter #1', 'Looter'), 85);
  assert.equal(lookup(roles, 'Looter #2', 'Looter'), 85);
  assert.equal(lookup(roles, 'Muscle #1'), 86);
  assert.equal(lookup(roles, 'Muscle #2'), 86);
});

test('exact position wins over a generic role and differently numbered siblings', () => {
  const roles = { Muscle: 95, 'Muscle #1': 82, 'Muscle #2': 63 };
  assert.equal(lookup(roles, 'Muscle #1'), 82);
  assert.equal(lookup(roles), 63);
});

test('legacy generic role data still works without borrowing another numbered slot', () => {
  assert.equal(lookup({ Muscle: 78 }), 78);
  assert.equal(lookup({ Muscle: 78 }, 'Muscle #2', 'Muscle #2'), 78);
  assert.equal(lookup({ 'Muscle #1': 99 }), 0);
});

test('normalizes case and whitespace, including the role index', () => {
  assert.equal(lookup({ '  mUsClE  # 2  ': 81 }), 81);
});

test('does not replace an explicit zero or invalid exact CPR with generic CPR', () => {
  for (const value of [0, null, '', 'unknown', Infinity]) {
    assert.equal(lookup({ Muscle: 99, 'Muscle #2': value }), 0);
  }
  assert.equal(lookup({ 'Muscle #2': '76' }), 76);
});

test('does not read another member or crime and tolerates missing data', () => {
  assert.equal(getCpr({ members: [{ memberId: 999, crimes: { [crime.name]: { Muscle: 90 } } }] }, 123, crime, { role: 'Muscle' }), 0);
  assert.equal(getCpr({ members: [{ memberId: 123, crimes: { Other: { Muscle: 90 } } }] }, 123, crime, { role: 'Muscle' }), 0);
  assert.equal(getCpr({}, 123, crime, { role: 'Muscle' }), 0);
});
