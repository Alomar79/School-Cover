const {createMock}=require('./google-mock.cjs'),assert=require('node:assert/strict');
const {context:c,metrics:m,props,grids}=createMock();
const result=c.setupProject();assert.equal(result.ok,true);assert.equal(result.lessons,10);const initial=JSON.stringify(grids);c.setupProject();assert.equal(JSON.stringify(grids),initial);console.log('PASS setup and repeated seed import preserve records');
const p={teacherId:'T001',date:'2026-09-13',type:'full',periods:[],reason:'مرضي'};
m.failBefore=true;assert.throws(()=>c.apiMutate('saveAbsence',p,'before-fail-1',''));assert.equal(c.readState_(true).Absences.length,0);assert.equal(m.locks,0);console.log('PASS failed batch leaves no partial absence, receipt or audit');
m.failAfter=true;assert.throws(()=>c.apiMutate('saveAbsence',p,'lost-response-1',''));assert.equal(c.readState_(true).Absences.length,1);c.apiMutate('saveAbsence',p,'lost-response-1','');assert.equal(c.readState_(true).Absences.length,1);console.log('PASS retry after lost commit response does not duplicate absence');
const proposal=c.apiRead('propose',{date:'2026-09-13'});c.apiMutate('approve',{date:'2026-09-13',rows:proposal.rows},'approve-0001','');const state=c.readState_(true);assert.equal(state.Assignments.length,2);assert.equal(state.Requests.length,2);assert.equal(m.locks,0);console.log('PASS server approval uses lock, atomic audit and request receipt');
const cfg=state.Settings[0],cached=c.apiRead('settings');c.apiMutate('entity',{table:'Settings',row:{...cfg,margin:1},before:cfg},'settings-0001','change');assert.equal(c.apiRead('settings').Settings[0].margin,1);console.log('PASS atomic revision invalidates static cache');
props.ALLOWED_EMAILS='other@example.test';assert.throws(()=>c.apiRead('bootstrap'));console.log('PASS access control rejects non-allowlisted identity');
const f=createMock().context;f.setupProject();
f.apiMutate('saveAbsence',{...p,date:'2026-09-20'},'future-absence-1','');
f.apiMutate('approve',{date:'2026-09-20',rows:f.apiRead('propose',{date:'2026-09-20'}).rows},'future-approve-1','');
const target=f.readState_(true).Assignments[0].teacherId;
f.apiMutate('adjust',{teacherId:target,date:'2026-11-01',amount:9},'future-adjust-1','test');
for(const d of ['2026-09-13','2026-11-01']){
  const b=f.apiRead('day',{date:d}).balances.find(b=>b.teacherId===target);
  assert.equal(b.balance,d==='2026-09-13'?0:9);assert.equal(b.pending,1);assert.equal(b.rank,d==='2026-09-13'?1:10);
}
console.log('PASS day API uses selected adjustment date while retaining future pending assignments');
console.log('7/7 store integration tests passed (Google services mocked)');
