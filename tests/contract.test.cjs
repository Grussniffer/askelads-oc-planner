const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {test} = require('node:test');
const {runInNewContext} = require('node:vm');

// The same input corpus is run against the frontend and backend. Always call
// the installed script's real functions so copies of its rules cannot drift.
const corpus = JSON.parse(readFileSync(join(__dirname,'fixtures/oc-cpr-contract.json'),'utf8'));
const source = readFileSync(join(__dirname,'../oc-planner-recommendations.user.js'),'utf8');
const helpers = source.slice(source.indexOf('\tconst normalizeText ='), source.indexOf('\tconst ROLE_TITLE_SELECTOR ='));
const bands = source.slice(source.indexOf('\tconst getSlotCprBand ='), source.indexOf('\tconst formatCprBand ='));
const lookup = source.slice(source.indexOf('\tconst getMemberCprForSlot ='), source.indexOf('\tconst findFlexibleSlots ='));
const api = runInNewContext(helpers+bands+lookup+'\n({getMemberCprForSlot,memberFitsSlotBand});');

for (const entry of corpus.cases) {
  test('shared OC identity contract: '+entry.id,()=>{
    const planner={members:[{memberId:123,crimes:entry.crimes}]};
    const crime={name:entry.crimeName,difficulty:3};
    const slot={position:entry.position,role:entry.role,minimumRecommendedCpr:0,maximumRecommendedCpr:100};
    const cpr=api.getMemberCprForSlot(planner,123,crime,slot);
    assert.equal(cpr,entry.expected===null ? undefined : entry.expected);
    assert.equal(api.memberFitsSlotBand(cpr,slot,crime,{}),entry.expected!==null,
      'real zero is eligible within a zero-minimum band; absent or invalid CPR is not');
  });
}
