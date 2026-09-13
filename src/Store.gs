/* Advanced Sheets batchUpdate commits changed records, audit and request receipt atomically. */
var TABLES_=['Teachers','Subjects','Classes','Eligibility','Periods','Terms','Versions','Lessons','Holidays','Absences','Constraints','Assignments','Adjustments','Settings','Audit','Requests'];
var STATIC_=['Teachers','Subjects','Classes','Eligibility','Periods','Terms','Versions','Lessons','Holidays','Constraints','Settings'];
var SCHEMA_={
 Teachers:['id','name','originalName','active','joinDate','leaveDate','participates','dailyLimit','department','sourcePages'],
 Subjects:['id','name','department'],Classes:['id','name','grade','room'],Eligibility:['id','teacherId','subjectId','grade','enabled','basis'],
 Periods:['id','number','start','end'],Terms:['id','name','start','end'],Versions:['id','name','start','end','status'],Lessons:['id','versionId','teacherId','classId','subjectId','day','period','room'],
 Holidays:['id','name','start','end','active'],Constraints:['id','teacherId','kind','start','end','day','periods','active','note'],
 Absences:['id','teacherId','date','termId','type','periods','reason','note','dayLessons','snapshots','status','revision'],
 Assignments:['id','key','date','absenceId','lesson','teacherId','teacherName','termId','status','reason','manualReason','overrideReason','approvedAt','executedAt','review','revision','reviewedAt'],
 Adjustments:['id','teacherId','termId','date','amount','reason','opening','members','at'],Settings:['id','margin','dailyLimit','schoolDays','rotation','dataRevision'],
 Audit:['id','at','actor','action','reason','before','after'],Requests:['id','op','payload','result','at']
};
function book_(){const id=PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');if(!id)throw new Error('شغّل setupProject أولًا من المشروع المرتبط بالجدول');return SpreadsheetApp.openById(id);}
function actor_(){return Session.getActiveUser().getEmail()||'';}
function authorize_(){
  const props=PropertiesService.getScriptProperties(),actor=actor_(),owner=props.getProperty('OWNER_EMAIL');
  const allow=(props.getProperty('ALLOWED_EMAILS')||owner||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
  // Owner-only deployment can have a blank active identity. This opt-in is never appropriate for public access.
  if(!actor&&props.getProperty('OWNER_ONLY_BLANK_IDENTITY')==='true')return '';
  if(!actor||!allow.includes(actor.toLowerCase()))throw new Error('الوصول غير مصرح. راجع قائمة الحسابات المسموحة وإعداد النشر.');return actor;
}
function setupProject(){
  const owner=PropertiesService.getScriptProperties().getProperty('OWNER_EMAIL');
  if(owner&&actor_()!==owner)throw new Error('إعداد المشروع متاح لمالك المشروع من محرر Apps Script فقط');
  const lock=LockService.getScriptLock();lock.waitLock(30000);
  try{
    const b=SpreadsheetApp.getActiveSpreadsheet();if(!b)throw new Error('افتح Apps Script من داخل Google Sheet');
    const p=PropertiesService.getScriptProperties();const old=p.getProperty('SPREADSHEET_ID');if(old&&old!==b.getId())throw new Error('المشروع مرتبط بجدول آخر');
    p.setProperty('SPREADSHEET_ID',b.getId());if(!p.getProperty('OWNER_EMAIL'))p.setProperty('OWNER_EMAIL',Session.getEffectiveUser().getEmail());
    b.setSpreadsheetTimeZone('Asia/Qatar');
    TABLES_.forEach(name=>{let sh=b.getSheetByName(name);if(!sh)sh=b.insertSheet(name);const cols=SCHEMA_[name];if(sh.getLastRow()===0){sh.getRange(1,1,1,cols.length).setValues([cols]);sh.setFrozenRows(1);sh.getRange(1,1,1,cols.length).setFontWeight('bold').setBackground('#dceee8');}else if(JSON.stringify(sh.getRange(1,1,1,cols.length).getValues()[0])!==JSON.stringify(cols))throw new Error('عناوين غير متوقعة في '+name);});
    SpreadsheetApp.flush();const before=readState_(true),after=Cover.copy(before),seed=schoolSeed_();
    // Seed once by entity ID; never reset user edits, absence, assignments or balances.
    if(!p.getProperty('SEED_INSTALLED')){TABLES_.forEach(k=>seed[k].forEach(r=>{if(!after[k].some(x=>x.id===r.id))after[k].push(r);}));commit_(before,after);p.setProperty('SEED_INSTALLED','2026-09-11-v1');}
    return validateSetup();
  }finally{lock.releaseLock();}
}
function validateSetup(){
  authorize_();
  const b=book_(),s=readState_(true),errors=[];
  if(b.getSpreadsheetTimeZone()!=='Asia/Qatar')errors.push('منطقة الجدول الزمنية ليست قطر');
  if(Session.getScriptTimeZone()!=='Asia/Qatar')errors.push('منطقة المشروع الزمنية ليست قطر');
  TABLES_.forEach(k=>{if(!b.getSheetByName(k))errors.push('ورقة مفقودة '+k);});
  s.Versions.filter(v=>v.status==='active').forEach(v=>{errors.push(...Cover.validateLessons(s,s.Lessons.filter(l=>l.versionId===v.id)));});
  return {ok:errors.length===0,errors,teachers:s.Teachers.length,lessons:s.Lessons.length,classes:s.Classes.length,terms:s.Terms.length};
}
function readState_(fresh){
  const b=book_(),cache=CacheService.getScriptCache();
  const revCell=Sheets.Spreadsheets.Values.get(b.getId(),"'Settings'!F2").values;
  const revision=revCell&&revCell[0]?String(revCell[0][0]):'0';
  const s={},missing=[];
  TABLES_.forEach(k=>{let cached=null;const prefix='cover:'+revision+':'+k;const count=!fresh&&STATIC_.includes(k)?Number(cache.get(prefix+':count')):0;
    if(count){const keys=Array.from({length:count},(_,i)=>prefix+':'+i),parts=cache.getAll(keys);if(keys.every(x=>parts[x]!==undefined))cached=keys.map(x=>parts[x]).join('');}
    if(cached)s[k]=JSON.parse(cached);else missing.push(k);});
  if(missing.length){
    const resp=Sheets.Spreadsheets.Values.batchGet(b.getId(),{ranges:missing.map(k=>"'"+k+"'!A2:"+column_(SCHEMA_[k].length)),valueRenderOption:'UNFORMATTED_VALUE'});
    missing.forEach((k,i)=>{const cols=SCHEMA_[k];s[k]=(resp.valueRanges[i].values||[]).filter(r=>r[0]!==undefined&&r[0]!=='').map(row=>{const obj={};cols.forEach((col,j)=>{if(row[j]!==undefined&&row[j]!=='')obj[col]=JSON.parse(String(row[j]));});return obj;});
      if(STATIC_.includes(k)){const str=JSON.stringify(s[k]),prefix='cover:'+revision+':'+k,parts={};let count=0;for(let j=0;j<str.length;j+=20000)parts[prefix+':'+count++]=str.slice(j,j+20000);parts[prefix+':count']=String(count);cache.putAll(parts,300);}
    });
  }return s;
}
function column_(n){let s='';while(n){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26);}return s;}
function commit_(before,after){
  const b=book_(),requests=[];let staticChanged=STATIC_.some(k=>JSON.stringify(before[k])!==JSON.stringify(after[k]));
  if(staticChanged&&after.Settings.length)after.Settings[0].dataRevision=Utilities.getUuid();
  TABLES_.forEach(k=>{
    const sheetId=b.getSheetByName(k).getSheetId(),cols=SCHEMA_[k];
    const rows=after[k];Cover.assert(rows.length>=before[k].length,'الحذف المباشر غير مسموح');
    rows.forEach((r,i)=>{
      if(JSON.stringify(r)===JSON.stringify(before[k][i]))return;
      if(STATIC_.includes(k))staticChanged=true;
      const values=cols.map(c=>{const v=r[c]===undefined?'':JSON.stringify(r[c]);Cover.assert(v.length<49000,'السجل كبير جدًا؛ قسّم العملية');return {userEnteredValue:{stringValue:v}};});
      requests.push({updateCells:{range:{sheetId,startRowIndex:i+1,endRowIndex:i+2,startColumnIndex:0,endColumnIndex:cols.length},rows:[{values}],fields:'userEnteredValue'}});
    });
    if(rows.length+1>b.getSheetByName(k).getMaxRows())requests.unshift({appendDimension:{sheetId,dimension:'ROWS',length:rows.length+1-b.getSheetByName(k).getMaxRows()}});
  });
  if(requests.length)Sheets.Spreadsheets.batchUpdate({requests},b.getId());
}
function doGet(){authorize_();return HtmlService.createTemplateFromFile('Index').evaluate().setTitle('احتياط | مدرسة تجريبية').addMetaTag('viewport','width=device-width, initial-scale=1');}
function apiRead(kind,p){
  authorize_();p=p||{};const s=readState_(false),d=p.date||Utilities.formatDate(new Date(),'Asia/Qatar','yyyy-MM-dd');
  if(kind==='bootstrap')return {today:d,teachers:s.Teachers,terms:s.Terms,periods:s.Periods,reasons:Cover.reasons};
  if(kind==='day'){
    const ns=Cover.needs(s,d),aa=s.Assignments.filter(a=>a.date===d),bs=(()=>{try{return Cover.balances(s,Cover.term(s,d).id,d.slice(0,7),{adjustmentsAsOf:d});}catch(e){return [];}})();
    return {date:d,day:Cover.day(d),schoolDay:Cover.schoolDay(s,d),absentTeachers:[...new Set(s.Absences.filter(a=>a.status==='active'&&a.date===d).map(a=>a.teacherId))],needs:ns,assignments:aa,balances:bs};
  }
  if(kind==='propose')return Cover.propose(s,d);
  if(kind==='alternatives'){
    const n=Cover.needs(s,d).find(n=>n.key===p.key)||s.Assignments.find(a=>a.id===p.assignmentId);Cover.assert(n,'الحصة غير موجودة');
    const local=(p.local||[]).filter(x=>x.key!==p.key).map(x=>{const nn=Cover.needs(s,d).find(n=>n.key===x.key);return nn?{...nn,teacherId:x.teacherId}:null;}).filter(Boolean);
    return s.Teachers.map(t=>({id:t.id,name:t.name,errors:Cover.availability(s,t,d,n.lesson.period,local,p.assignmentId,!!p.override)}));
  }
  if(kind==='absenceReport')return Cover.absenceReport(s,p.start,p.end);
  if(kind==='fairness')return {rows:Cover.balances(s,p.termId,p.month),assignments:s.Assignments.filter(a=>a.termId===p.termId),audit:s.Audit.filter(a=>a.action==='موازنة إدارية')};
  if(kind==='opening')return Cover.opening(s,p);
  if(kind==='settings'){const out={};STATIC_.filter(k=>k!=='Lessons').forEach(k=>out[k]=s[k]);return out;}
  if(kind==='lessons')return s.Lessons.filter(l=>l.versionId===p.versionId);
  if(kind==='previewImport')return {errors:Cover.validateLessons(s,p.lessons),count:p.lessons.length};
  throw new Error('طلب غير معروف');
}
function apiMutate(op,p,requestId,reason){
  const actor=authorize_();Cover.assert(typeof requestId==='string'&&/^[a-zA-Z0-9_-]{8,100}$/.test(requestId),'معرف الطلب غير صحيح');
  const lock=LockService.getScriptLock();lock.waitLock(30000);
  try{
    const before=readState_(false),after=Cover.copy(before);
    const hash=Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,JSON.stringify(p)));
    const result=Cover.run(after,op,p,{id:requestId,actor:actor||'هوية غير متاحة في طريقة النشر الحالية',now:new Date().toISOString(),reason:reason||'',payloadHash:hash});
    commit_(before,after);return {ok:true,result};
  }finally{lock.releaseLock();}
}
