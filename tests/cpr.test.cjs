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
  const normalizeCrimeName = ${source.match(/const normalizeCrimeName = ([\s\S]*?);/)[1]};
  const normalizeRoleName = ${source.match(/const normalizeRoleName = ([\s\S]*?);/)[1]};
  ${source.slice(source.indexOf('\tconst getCprNumber ='), source.indexOf('\tconst ROLE_TITLE_SELECTOR ='))}
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
  assert.equal(lookup({ 'Muscle #1': 99 }), undefined);
});

test('normalizes case and whitespace, including the role index', () => {
  assert.equal(lookup({ '  mUsClE  # 2  ': 81 }), 81);
});

test('numbered role aliases with and without # retain exact precedence and never borrow siblings', () => {
  const variants = ['Hustler #2', 'Hustler # 2', 'Hustler 2', 'Hustler2'];
  for (const position of variants) {
    for (const stored of variants) {
      assert.equal(lookup({ Hustler: 99, 'Hustler 1': 92, [stored]: 65 }, position, position), 65);
      for (const value of [0, null, '', 'unknown', Infinity]) {
        assert.equal(lookup({ Hustler: 99, [stored]: value }, position, position), value === 0 ? 0 : undefined);
      }
    }
    assert.equal(lookup({ Hustler: 61 }, position, position), 61);
    assert.equal(lookup({ 'Hustler 1': 62 }, position, position), undefined);
    assert.equal(lookup({ Hustler1: 62 }, position, position), undefined);
  }
});

test('does not replace an explicit zero or invalid exact CPR with generic CPR', () => {
  for (const value of [0, null, '', 'unknown', Infinity]) {
    assert.equal(lookup({ Muscle: 99, 'Muscle #2': value }), value === 0 ? 0 : undefined);
  }
  assert.equal(lookup({ 'Muscle #2': '76' }), 76);
});

test('does not read another member or crime and tolerates missing data', () => {
  assert.equal(getCpr({ members: [{ memberId: 999, crimes: { [crime.name]: { Muscle: 90 } } }] }, 123, crime, { role: 'Muscle' }), undefined);
  assert.equal(getCpr({ members: [{ memberId: 123, crimes: { Other: { Muscle: 90 } } }] }, 123, crime, { role: 'Muscle' }), undefined);
  assert.equal(getCpr({}, 123, crime, { role: 'Muscle' }), undefined);
});

test('Guardian Angels source aliases share CPR across accents, composition, case and whitespace', () => {
  const names = ['Guardian Angels', 'Guardian Ángels', 'Guardian A\u0301ngels', '  GUARDIAN  ÁNGELS  '];
  for (const stored of names) for (const requested of names) {
    const planner = {members:[{memberId:123,crimes:{[stored]:{Enforcer:67}}}]};
    assert.equal(getCpr(planner,123,{name:requested},{position:'Enforcer',role:'Enforcer'}),67);
  }
});

test('exact crime-name CPR wins over aliases and unrelated punctuation remains distinct', () => {
  const planner = {members:[{memberId:123,crimes:{
    'Guardian Angels':{Enforcer:60},
    'Guardian Ángels':{Enforcer:77},
    'Guardian-Angels':{Enforcer:91},
  }}]};
  assert.equal(getCpr(planner,123,{name:'Guardian Angels'},{position:'Enforcer',role:'Enforcer'}),60);
  assert.equal(getCpr(planner,123,{name:'Guardian Ángels'},{position:'Enforcer',role:'Enforcer'}),77);
  assert.equal(getCpr(planner,123,{name:' GUARDIAN A\u0301NGELS '},{position:'Enforcer',role:'Enforcer'}),77);
  assert.equal(getCpr(planner,123,{name:'Guardian-Angels'},{position:'Enforcer',role:'Enforcer'}),91);
  assert.equal(getCpr(planner,123,{name:'GuardianAngels'},{position:'Enforcer',role:'Enforcer'}),undefined);
  assert.equal(getCpr(planner,123,{name:'Guardian Angels!'},{position:'Enforcer',role:'Enforcer'}),undefined);
});

test('crime aliases keep numbered role isolation and explicit invalid CPR', () => {
  const planner = {members:[{memberId:123,crimes:{'Guardian Ángels':{Muscle:95,'Muscle #1':62,'Muscle #2':null}}}]};
  assert.equal(getCpr(planner,123,{name:'Guardian Angels'},{position:'Muscle 1',role:'Muscle'}),62);
  assert.equal(getCpr(planner,123,{name:'Guardian Angels'},{position:'Muscle 2',role:'Muscle'}),undefined);
});

test('partial crime aliases can supply absent roles but never replace explicit zero or invalid roles', () => {
  const lookupCrime = (crimes, name, role) => getCpr({members:[{memberId:123,crimes}]},123,{name},{position:role,role});
  const partial = {'Guardian Angels':{Enforcer:65}, 'Guardian Ángels':{Hustler:70}};
  assert.equal(lookupCrime(partial,'Guardian Angels','Hustler'),70);
  assert.equal(lookupCrime(partial,'Guardian Ángels','Enforcer'),65);
  for (const value of [0,null,'',undefined,'unknown',Infinity]) {
    assert.equal(lookupCrime({'Guardian Angels':{Enforcer:value}, 'Guardian Ángels':{Enforcer:77}},'Guardian Angels','Enforcer'),value === 0 ? 0 : undefined);
    assert.equal(lookupCrime({'Guardian Angels':{Enforcer:77}, 'Guardian Ángels':{Enforcer:value}},'Guardian Ángels','Enforcer'),value === 0 ? 0 : undefined);
  }
});

test('literal role identity wins over conflicting normalized aliases in either insertion order', () => {
  for (const roles of [
    {'Muscle 2':84,' muscle #2 ':73,'Muscle #2':0,Muscle:99},
    {'Muscle #2':0,' muscle #2 ':73,'Muscle 2':84,Muscle:99},
  ]) {
    assert.equal(lookup(roles,'Muscle #2'),0);
    assert.equal(lookup(roles,'Muscle 2'),84);
    assert.equal(lookup(roles,' muscle #2 '),73);
  }
  assert.equal(lookup({'Muscle 2':84,' muscle #2 ':73},' MUSCLE #2 '),73);
});

test('rejects coerced non-numbers and out-of-range CPR while preserving real zero', () => {
  for (const value of [null,undefined,'',' ',true,false,[],[64],{},-1,101,'101',NaN,Infinity]) {
    assert.equal(lookup({'Muscle #2':value,Muscle:99}),undefined, String(value));
  }
  for (const [value,expected] of [[0,0],['0',0],[100,100],['64.5',64.5]]) {
    assert.equal(lookup({'Muscle #2':value}),expected);
  }
});

test('numbered Unknown placeholders use a real mapped role without becoming a false position',()=>{
  assert.equal(lookup({'Muscle #2':70},'Unknown #2','Muscle #2'),70);
  assert.equal(lookup({'Muscle #2':70},'2','Muscle #2'),70);
  assert.equal(lookup({'Unknown #2':99},'Unknown #2','Unknown #1'),undefined);
});
