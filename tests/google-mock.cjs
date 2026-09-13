const vm=require('node:vm'),fs=require('node:fs'),crypto=require('node:crypto');
function createMock(){
const grids={},props={},cache={},metrics={locks:0,batches:0,reads:0,failBefore:false,failAfter:false};let nextId=1;
function sheet(name){return {getSheetId:()=>grids[name].id,getLastRow:()=>grids[name].rows.length,getMaxRows:()=>grids[name].max,setFrozenRows(){},getRange(r,c,n,m){return {getValues:()=>Array.from({length:n},(_,i)=>Array.from({length:m},(_,j)=>grids[name].rows[r-1+i]?.[c-1+j]||'')),setValues(v){v.forEach((row,i)=>{grids[name].rows[r-1+i]??=[];row.forEach((x,j)=>grids[name].rows[r-1+i][c-1+j]=x);});return this;},setFontWeight(){return this;},setBackground(){return this;}};}};}
const book={getId:()=> 'TEST_SHEET',getSheetByName:n=>grids[n]?sheet(n):null,insertSheet(n){grids[n]={id:nextId++,rows:[],max:1000};return sheet(n);},setSpreadsheetTimeZone(v){props.tz=v;},getSpreadsheetTimeZone:()=>props.tz};
const values={get(id,range){metrics.reads++;const name=range.match(/'([^']+)'/)[1];return {values:grids[name]?.rows[1]?.[5]===undefined?[]:[[grids[name].rows[1][5]]]};},batchGet(id,o){metrics.reads++;return {valueRanges:o.ranges.map(r=>({values:JSON.parse(JSON.stringify(grids[r.match(/'([^']+)'/)[1]].rows.slice(1)))}))};}};
const context={console,Date,JSON,Math,Error,Set,Map,module:undefined,
 SpreadsheetApp:{getActiveSpreadsheet:()=>book,openById:()=>book,flush(){}},
 PropertiesService:{getScriptProperties:()=>({getProperty:k=>props[k]||null,setProperty(k,v){props[k]=v;}})},
 Session:{getActiveUser:()=>({getEmail:()=> 'owner@example.test'}),getEffectiveUser:()=>({getEmail:()=> 'owner@example.test'}),getScriptTimeZone:()=> 'Asia/Qatar'},
 CacheService:{getScriptCache:()=>({get:k=>cache[k]||null,getAll:keys=>Object.fromEntries(keys.filter(k=>cache[k]!==undefined).map(k=>[k,cache[k]])),put(k,v){cache[k]=v;},putAll(p){Object.assign(cache,p);}})},
 LockService:{getScriptLock:()=>({waitLock(){metrics.locks++;},releaseLock(){metrics.locks--;}})},
 Utilities:{getUuid:()=>crypto.randomUUID(),formatDate:()=> '2026-09-13',DigestAlgorithm:{SHA_256:'sha256'},computeDigest:(alg,s)=>crypto.createHash('sha256').update(s).digest(),base64Encode:s=>Buffer.from(s).toString('base64')},
 Sheets:{Spreadsheets:{Values:values,batchUpdate(o){metrics.batches++;if(metrics.failBefore){metrics.failBefore=false;throw Error('Simulated network failure before commit');}const staged=JSON.parse(JSON.stringify(grids));for(const req of o.requests){if(req.appendDimension){const g=Object.values(staged).find(g=>g.id===req.appendDimension.sheetId);g.max+=req.appendDimension.length;}else{const u=req.updateCells,g=Object.values(staged).find(g=>g.id===u.range.sheetId);u.rows.forEach((r,i)=>{g.rows[u.range.startRowIndex+i]??=[];r.values.forEach((v,j)=>g.rows[u.range.startRowIndex+i][u.range.startColumnIndex+j]=v.userEnteredValue.stringValue);});}}Object.assign(grids,staged);if(metrics.failAfter){metrics.failAfter=false;throw Error('Simulated lost success response');}return {};}}}
};
vm.createContext(context);for(const file of ['Core.gs','Seed.gs','Store.gs'])vm.runInContext(fs.readFileSync('src/'+file,'utf8'),context,{filename:file});
return {context,grids,props,metrics};
}
module.exports={createMock};
