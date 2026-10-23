const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {join} = require('node:path');
const {test} = require('node:test');
const {runInNewContext} = require('node:vm');
const source = readFileSync(join(__dirname,'../oc-planner-recommendations.user.js'),'utf8');
const start=source.indexOf('\tconst getSlotCprBand =');
const end=source.indexOf('\tconst formatCprBand =',start);
const getBand=runInNewContext(source.slice(start,end)+'\ngetSlotCprBand;');
test('new Useless tier inherits saved Low until explicitly configured',()=>{
 const slot={roleImpactLabel:'useless',minimumRecommendedCpr:0,maximumRecommendedCpr:100};
 const requirements={low:{'7':{min:20,max:55}}};
 assert.equal(getBand(slot,{difficulty:7},requirements).min,20);
 assert.equal(getBand(slot,{difficulty:7},requirements).max,55);
 requirements.useless={'7':{min:0,max:0}};
 assert.equal(getBand(slot,{difficulty:7},requirements).max,0);
 assert.equal(getBand({...slot,maximumRecommendedCpr:0},{difficulty:7},{}).max,0);
});
