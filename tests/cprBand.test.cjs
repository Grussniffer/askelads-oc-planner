const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {test} = require('node:test');
const {runInNewContext} = require('node:vm');
const source = readFileSync(join(__dirname,'../oc-planner-recommendations.user.js'),'utf8');
const start=source.indexOf('\tconst getSlotCprBand =');
const end=source.indexOf('\tconst formatCprBand =',start);
const helpers=source.slice(source.indexOf('\tconst getCprNumber ='),source.indexOf('\tconst ROLE_TITLE_SELECTOR ='));
const getBand=runInNewContext(helpers+source.slice(start,end)+'\ngetSlotCprBand;');
test('new Useless tier inherits saved Low until explicitly configured',()=>{
 const slot={roleImpactLabel:'useless',minimumRecommendedCpr:0,maximumRecommendedCpr:100};
 const requirements={low:{'7':{min:20,max:55}}};
 assert.equal(getBand(slot,{difficulty:7},requirements).min,20);
 assert.equal(getBand(slot,{difficulty:7},requirements).max,55);
 requirements.useless={'7':{min:0,max:0}};
 assert.equal(getBand(slot,{difficulty:7},requirements).max,0);
 assert.equal(getBand({...slot,maximumRecommendedCpr:0},{difficulty:7},{}).max,0);
});

test('invalid or absent limits never turn into a permissive default band',()=>{
 for (const value of [null,undefined,'',' ',false,true,[],[80],{},Infinity,-1,101]) {
  assert.equal(getBand({minimumRecommendedCpr:value,maximumRecommendedCpr:80},{difficulty:3},{}),undefined);
  assert.equal(getBand({minimumRecommendedCpr:20,maximumRecommendedCpr:value},{difficulty:3},{}),undefined);
 }
 assert.equal(getBand({minimumRecommendedCpr:80,maximumRecommendedCpr:70},{difficulty:3},{}),undefined);
 const band=getBand({roleImpactLabel:'low',minimumRecommendedCpr:20,maximumRecommendedCpr:80},{difficulty:3},{low:{'3':{min:null,max:''}}});
 assert.equal(band.min,20);
 assert.equal(band.max,80);
});

test('policy bands are atomic, current valid settings win and malformed tiers cannot borrow another tier',()=>{
 const slot={roleImpactLabel:'low',minimumRecommendedCpr:20,maximumRecommendedCpr:80};
 const requirements={low:{'3':{min:35,max:60}}};
 assert.equal(getBand(slot,{difficulty:3},requirements).min,35);
 assert.equal(getBand(slot,{difficulty:3},requirements).max,60);
 for (const configured of [{min:35},{max:60},{min:70,max:30},{min:35,max:null}]) {
  assert.equal(getBand(slot,{difficulty:3},{low:{'3':configured}}).min,20);
  assert.equal(getBand(slot,{difficulty:3},{low:{'3':configured}}).max,80);
 }
 for (const difficulty of [null,0,2.6,11,'invalid']) {
  assert.equal(getBand(slot,{difficulty},requirements).min,20);
 }
 const useless={...slot,roleImpactLabel:'useless'};
 assert.equal(getBand(useless,{difficulty:3},requirements).min,35);
 assert.equal(getBand(useless,{difficulty:3},{...requirements,useless:{'3':{min:15}}}).min,20,'present incomplete Useless must not borrow Low');
});
