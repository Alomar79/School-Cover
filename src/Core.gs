/* Pure domain engine. Dates are ISO civil dates in Asia/Qatar; never host-local dates. */
var Cover = (function () {
  'use strict';
  const reasons=['مرضي','إجازة معتمدة','غياب عرضي','ظرف طارئ','استئذان','مهمة رسمية','أخرى','لم يُحدد بعد'];
  const copy=x=>JSON.parse(JSON.stringify(x));
  function assert(v,m){if(!v)throw new Error(m);}
  function date(s){assert(/^\d{4}-\d{2}-\d{2}$/.test(s||'') && new Date(s+'T12:00:00Z').toISOString().slice(0,10)===s,'التاريخ غير صحيح');return s;}
  const day=s=>new Date(date(s)+'T12:00:00Z').getUTCDay();
  const today=now=>new Date(new Date(now).getTime()+3*3600000).toISOString().slice(0,10);
  const inRange=(d,a,b)=>(!a||d>=a)&&(!b||d<=b);
  const byId=(s,k,id)=>{const x=s[k].find(x=>x.id===id);assert(x,'السجل المطلوب غير موجود');return x;};
  const cfg=s=>s.Settings[0];
  function term(s,d){const a=s.Terms.filter(t=>inRange(d,t.start,t.end));assert(a.length===1,'لا يوجد فصل دراسي محدد لهذا التاريخ');return a[0];}
  function version(s,d){const vs=s.Versions.filter(v=>v.status==='active'&&inRange(d,v.start,v.end));assert(vs.length===1,'لا يوجد جدول ساري لهذا التاريخ');return vs[0];}
  function schoolDay(s,d){return cfg(s).schoolDays.includes(day(d))&&!s.Holidays.some(h=>h.active!==false&&inRange(d,h.start,h.end));}
  function lessons(s,d){if(s._plan&&s._plan.date===d)return s._plan.lessons;const v=version(s,d);return s.Lessons.filter(l=>l.versionId===v.id&&l.day===day(d));}
  function snapshot(s,l){return {...copy(l),teacherName:byId(s,'Teachers',l.teacherId).name,className:byId(s,'Classes',l.classId).name,grade:byId(s,'Classes',l.classId).grade,subjectName:byId(s,'Subjects',l.subjectId).name,time:copy(byId(s,'Periods',String(l.period)))};}
  function absent(s,t,d,p){return s.Absences.some(a=>a.status==='active'&&a.teacherId===t&&a.date===d&&(a.type==='full'||a.periods.includes(p)));}
  function constraints(s,t,d,p){return s.Constraints.filter(c=>c.active!==false&&c.teacherId===t&&inRange(d,c.start,c.end)&&(c.day===null||c.day===undefined||c.day===day(d))&&(!c.periods.length||c.periods.includes(p)));}
  function active(t,d){return t.active&&inRange(d,t.joinDate,t.leaveDate)&&t.participates;}
  function balances(s,termId,month,cutoffs){
    const ts=byId(s,'Terms',termId);cutoffs=cutoffs||{};
    // Planning limits adjustment effectiveness to the selected day, while keeping
    // approved pending assignments across the semester. Historical opening balances
    // may explicitly limit assignments as well; these are independent conditions.
    const adjustmentEnd=cutoffs.adjustmentsAsOf?date(cutoffs.adjustmentsAsOf):ts.end;
    const assignmentEnd=cutoffs.assignmentsAsOf?date(cutoffs.assignmentsAsOf):ts.end;
    if(s._plan&&s._plan.termId===termId&&s._plan.month===month&&s._plan.date===adjustmentEnd&&assignmentEnd===ts.end)return s._plan.balances;
    return s.Teachers.map(t=>{
      const aa=s.Assignments.filter(a=>a.termId===termId&&a.teacherId===t.id&&a.date<=assignmentEnd);
      const done=aa.filter(a=>a.status==='executed'),pending=aa.filter(a=>a.status==='approved');
      const adjustments=s.Adjustments.filter(a=>a.termId===termId&&a.teacherId===t.id&&a.date<=adjustmentEnd);
      const balance=adjustments.reduce((n,a)=>n+a.amount,0),actual=done.length;
      return {teacherId:t.id,name:t.name,actual,monthActual:done.filter(a=>a.date.slice(0,7)===month).length,balance,fairness:actual+balance,pending:pending.length,rank:actual+balance+pending.length,monthPending:pending.filter(a=>a.date.slice(0,7)===month).length,last:done.map(a=>a.date).sort().pop()||'',adjustments:copy(adjustments)};
    });
  }
  function needs(s,d){
    const all=[];s.Absences.filter(a=>a.status==='active'&&a.date===d).forEach(a=>a.snapshots.forEach(l=>{
      const id=d+'|'+l.versionId+'|'+l.id;
      if(!all.some(x=>x.key===id))all.push({key:id,date:d,absenceId:a.id,lesson:copy(l)});
    }));return all.sort((a,b)=>a.lesson.period-b.lesson.period||a.lesson.className.localeCompare(b.lesson.className,'ar'));
  }
  const live=a=>a.status==='approved'||a.status==='executed';
  function availability(s,t,d,p,local,ignoreId,override){
    const errors=[];
    if(!active(t,d))errors.push('غير نشط أو خارج فترة المشاركة');
    if(absent(s,t.id,d,p))errors.push('غائب في هذه الحصة');
    if(lessons(s,d).some(l=>l.teacherId===t.id&&l.period===p))errors.push('لديه حصة تدريس');
    constraints(s,t.id,d,p).forEach(c=>errors.push(c.kind==='exemption'?'إعفاء ساري':'التزام مسجل'));
    const assigned=s.Assignments.filter(a=>a.id!==ignoreId&&a.date===d&&a.teacherId===t.id&&live(a));
    const temp=(local||[]).filter(a=>a.teacherId===t.id);
    if([...assigned,...temp].some(a=>a.lesson.period===p))errors.push('مكلف بحصة احتياط متزامنة');
    if(!override&&assigned.length+temp.length>=(t.dailyLimit===null||t.dailyLimit===undefined?cfg(s).dailyLimit:t.dailyLimit))errors.push('بلغ الحد اليومي');
    return [...new Set(errors)];
  }
  function candidates(s,n,local,ignoreId,override){
    const d=n.date,bs=balances(s,term(s,d).id,d.slice(0,7),{adjustmentsAsOf:d});
    const out=s.Teachers.filter(t=>!availability(s,t,d,n.lesson.period,local,ignoreId,override).length).map(t=>{
      const b=bs.find(b=>b.teacherId===t.id),count=local.filter(a=>a.teacherId===t.id).length;
      return {...b,rank:b.rank+count,month:b.monthActual+b.monthPending+count,load:lessons(s,d).filter(l=>l.teacherId===t.id).length+s.Assignments.filter(a=>live(a)&&a.id!==ignoreId&&a.date===d&&a.teacherId===t.id).length+count,qualified:s.Eligibility.some(e=>e.enabled&&e.teacherId===t.id&&e.subjectId===n.lesson.subjectId&&e.grade===n.lesson.grade),rotation:(s.Teachers.indexOf(t)-cfg(s).rotation+s.Teachers.length)%s.Teachers.length};
    });
    const min=Math.min(...out.map(c=>c.rank));const priority=out.filter(c=>c.qualified&&c.rank<=min+cfg(s).margin);
    const pool=priority.length?priority:out;
    pool.sort((a,b)=>a.rank-b.rank||a.month-b.month||a.load-b.load||(a.last||'0000').localeCompare(b.last||'0000')||a.rotation-b.rotation);
    return {all:out,ordered:pool.map(c=>({...c,reason:priority.length?'من معلمي المادة؛ الفارق عن الأقل '+(c.rank-min)+' حصة':'الأقل رصيدًا بين المتاحين'}))};
  }
  function propose(s,d){
    date(d);term(s,d);version(s,d);
    if(!schoolDay(s,d))return {rows:[],nodes:0,limited:false,message:'يوم غير دراسي؛ لا يُنشأ توزيع'};
    const plan={date:d,termId:term(s,d).id,month:d.slice(0,7),lessons:lessons(s,d),balances:balances(s,term(s,d).id,d.slice(0,7),{adjustmentsAsOf:d})};
    s=Object.assign(Object.create(s),{_plan:plan});
    const remaining=needs(s,d).filter(n=>!s.Assignments.some(a=>a.key===n.key&&live(a)));
    let best=[],nodes=0,limited=false,full=false;const cap=12000,started=Date.now();
    function search(todo,local){
      if(full)return;if(++nodes>cap||Date.now()-started>8000){limited=true;return;}
      if(local.length>best.length)best=copy(local);
      if(!todo.length){if(local.length===remaining.length)full=true;return;}
      if(local.length+todo.length<=best.length)return;
      const options=todo.map(n=>({n,c:candidates(s,n,local).ordered})).sort((a,b)=>a.c.length-b.c.length||a.n.lesson.period-b.n.lesson.period||a.n.key.localeCompare(b.n.key));
      const {n,c}=options[0],rest=todo.filter(x=>x.key!==n.key);
      for(const t of c){search(rest,[...local,{...n,teacherId:t.teacherId,rank:t.rank,reason:t.reason,status:'proposed'}]);if(full||limited)break;}
      if(!full&&!limited)search(rest,local);
    }
    search(remaining,[]);
    return {rows:remaining.map(n=>best.find(x=>x.key===n.key)||{...n,teacherId:'',status:'proposed',reason:limited?'تحتاج معالجة: بلغ البحث المحدود سقفه':'تحتاج معالجة: لا يوجد توزيع كامل ضمن القيود وأولوية المادة'}),nodes,limited};
  }
  function audit(s,ctx,action,before,after){s.Audit.push({id:ctx.id+'-audit-'+s.Audit.length,at:ctx.now,actor:ctx.actor||'هوية غير متاحة',action,reason:ctx.reason||'',before:copy(before===undefined?null:before),after:copy(after===undefined?null:after)});}
  function upsert(s,table,row){const i=s[table].findIndex(x=>x.id===row.id);if(i<0)s[table].push(row);else s[table][i]=row;}
  function review(s,ctx,dates){
    s.Assignments.filter(a=>a.status==='approved'&&(!dates||dates.includes(a.date))).forEach(a=>{
      const errors=availability(s,byId(s,'Teachers',a.teacherId),a.date,a.lesson.period,[],a.id,!!a.overrideReason);
      const n=needs(s,a.date).find(n=>n.key===a.key);
      if(!n)errors.push('الحصة لم تعد ضمن الغياب النشط');
      if(!schoolDay(s,a.date))errors.push('أصبح التاريخ يومًا غير دراسي');
      if(a.lesson.versionId!==version(s,a.date).id)errors.push('تغيرت نسخة الجدول؛ حدّث حصص الغياب وأعد التوزيع');
      const next=errors.join('؛ ');if(a.review!==next){const old=copy(a);a.review=next;a.revision=(a.revision||0)+1;a.reviewedAt=ctx.now;audit(s,ctx,'مراجعة تكليف',old,a);}
    });
  }
  function saveAbsence(s,p,ctx){
    const old=p.id?s.Absences.find(a=>a.id===p.id):null; if(old)assert(p.revision===old.revision,'تغير سجل الغياب؛ أعد تحميله');
    const t=byId(s,'Teachers',p.teacherId);date(p.date);const tm=term(s,p.date);assert(schoolDay(s,p.date),'لا يسجل غياب في يوم غير دراسي');
    assert(inRange(p.date,t.joinDate,t.leaveDate),'التاريخ خارج فترة عمل المعلم');assert(['full','partial'].includes(p.type),'نوع الغياب غير صحيح');assert(reasons.includes(p.reason),'اختر سبب الغياب');
    const periods=p.type==='full'?s.Periods.map(x=>x.number):[...new Set(p.periods)].sort((a,b)=>a-b);
    assert(periods.length&&periods.every(n=>s.Periods.some(x=>x.number===n)),'اختر حصصًا صحيحة');
    assert(!s.Absences.some(a=>a.status==='active'&&a.id!==p.id&&a.teacherId===p.teacherId&&a.date===p.date&&(a.type==='full'||p.type==='full'||a.periods.some(n=>periods.includes(n)))),'يوجد غياب متداخل؛ عدّل السجل الموجود أو ألغِه أولًا');
    // Preserve old-day lesson snapshots when only reason/period selection changes.
    const sameDay=old&&old.date===p.date&&old.teacherId===p.teacherId;
    const dayLessons=sameDay&&!p.refreshSchedule?old.dayLessons:lessons(s,p.date).filter(l=>l.teacherId===t.id).map(l=>snapshot(s,l));
    const row={id:p.id||ctx.id,teacherId:t.id,date:p.date,termId:tm.id,type:p.type,periods,reason:p.reason,note:String(p.note||'').slice(0,2000),dayLessons:copy(dayLessons),snapshots:copy(dayLessons.filter(l=>periods.includes(l.period))),status:'active',revision:old?old.revision+1:1};
    const historical=s.Assignments.some(a=>a.status==='executed'&&((old&&a.absenceId===old.id)||(a.teacherId===t.id&&a.date===p.date&&periods.includes(a.lesson.period))));
    if(historical){assert(p.confirmHistorical&&ctx.reason,'هذا التعديل يؤثر في غياب مرتبط بتنفيذ مؤكد؛ يلزم إقرار وسبب تصحيح');}
    if(p.refreshSchedule)assert(p.date>=today(ctx.now),'لا تعاد كتابة جدول غياب يوم سابق');
    upsert(s,'Absences',row);audit(s,ctx,old?'تعديل غياب':'تسجيل غياب',old,row);review(s,ctx,[p.date,...(old?[old.date]:[])]);return row;
  }
  function cancelAbsence(s,p,ctx){
    const a=byId(s,'Absences',p.id);if(a.status==='cancelled')return a;
    assert(p.revision===a.revision,'تغير السجل؛ أعد تحميله');assert(ctx.reason,'اكتب سبب الإلغاء');
    if(s.Assignments.some(x=>x.absenceId===a.id&&x.status==='executed'))assert(p.confirmHistorical,'يلزم إقرار تصحيح سجل مرتبط بتنفيذ مؤكد؛ التنفيذ يبقى محفوظًا');
    const old=copy(a);a.status='cancelled';a.revision++;audit(s,ctx,'إلغاء غياب',old,a);review(s,ctx,[a.date]);return a;
  }
  function approve(s,p,ctx){
    assert(schoolDay(s,p.date),'اليوم غير دراسي');const tm=term(s,p.date);const nn=needs(s,p.date),saved=[];
    const automatic=propose(s,p.date).rows;
    assert(Array.isArray(p.rows)&&p.rows.length,'لا توجد تكليفات للاعتماد');
    const duplicate=new Set();
    for(const r of p.rows){
      assert(!duplicate.has(r.key),'حصة مكررة في الطلب');duplicate.add(r.key);
      const n=nn.find(n=>n.key===r.key);assert(n,'تغيرت حصص الغياب؛ أعد الاقتراح');
      assert(n.lesson.versionId===version(s,p.date).id,'حدّث حصص الغياب إلى الجدول الساري قبل الاعتماد');
      const existing=s.Assignments.find(a=>a.key===r.key&&live(a));
      if(existing&&existing.teacherId===r.teacherId&&!existing.review){saved.push(existing);continue;}
      if(existing){assert(existing.status!=='executed','الحصة منفذة؛ استخدم التصحيح التاريخي');assert(p.replace&&ctx.reason,'استبدال المعتمد يحتاج إجراءً صريحًا وسببًا');const prev=copy(existing);existing.status='cancelled';existing.revision++;audit(s,ctx,'استبدال تكليف معتمد',prev,existing);}
      const t=byId(s,'Teachers',r.teacherId);const errors=availability(s,t,p.date,n.lesson.period,[],null,!!r.overrideReason);
      assert(!errors.length, t.name+': '+errors.join('؛ '));
      const auto=automatic.find(x=>x.key===r.key),manual=r.manual||!auto||auto.teacherId!==t.id;
      if(manual)assert(String(r.manualReason||'').trim()||String(r.overrideReason||'').trim(),'اكتب سبب التغيير اليدوي أو أعد الاقتراح بعد تغير التوفر');
      if(r.overrideReason)assert(typeof r.overrideReason==='string'&&r.overrideReason.trim(),'اكتب سبب تجاوز الحد اليومي');
      const a={...copy(n),id:ctx.id+'-'+saved.length,teacherId:t.id,teacherName:t.name,termId:tm.id,status:'approved',reason:manual?'اختيار إداري: '+String(r.manualReason||r.overrideReason):auto.reason,manualReason:String(r.manualReason||''),overrideReason:String(r.overrideReason||''),approvedAt:ctx.now,executedAt:'',review:'',revision:1};
      s.Assignments.push(a);audit(s,ctx,'اعتماد تكليف',null,a);saved.push(a);
      cfg(s).rotation=(s.Teachers.indexOf(t)+1)%s.Teachers.length;
    }return {ids:saved.map(a=>a.id)};
  }
  function assignmentAction(s,p,ctx){
    const a=byId(s,'Assignments',p.id);
    if(p.action==='execute'&&a.status==='executed'&&(!p.teacherId||p.teacherId===a.teacherId))return a;
    if(p.action==='cancel'&&a.status==='cancelled')return a;
    assert(p.revision===a.revision,'تغير التكليف؛ أعد تحميله');const old=copy(a);
    if(p.action==='cancel'){
      assert(ctx.reason,'اكتب سبب الإلغاء');if(a.status==='executed')assert(p.confirmHistorical,'إلغاء تنفيذ مؤكد يتطلب إقرار تصحيح تاريخي');a.status='cancelled';
    }else{
      assert(['execute','correct'].includes(p.action),'إجراء غير صحيح');
      if(p.action==='correct')assert(a.status==='executed'&&ctx.reason&&p.confirmHistorical,'تصحيح التنفيذ يتطلب إقرارًا وسببًا');
      else assert(a.status==='approved','لا يمكن تنفيذ تكليف غير معتمد');
      assert(a.date<=today(ctx.now),'لا يمكن تأكيد تنفيذ مستقبلي');
      assert(!a.review||p.action==='correct','هذا التكليف يحتاج معالجة قبل التنفيذ');
      const id=p.teacherId||a.teacherId;if(id!==a.teacherId)assert(ctx.reason,'اكتب سبب اختلاف المنفذ الحقيقي');
      const t=byId(s,'Teachers',id);
      // Historical corrections use original timetable version, not a newer schedule.
      const sc=copy(s);sc.Versions.forEach(v=>v.status='draft');const ov=byId(sc,'Versions',a.lesson.versionId);ov.status='active';ov.start=a.date;ov.end=a.date;
      const errors=availability(sc,t,a.date,a.lesson.period,[],a.id,!!(p.overrideReason||a.overrideReason));assert(!errors.length,errors.join('؛ '));
      a.teacherId=id;a.teacherName=t.name;a.status='executed';a.executedAt=ctx.now;a.overrideReason=p.overrideReason||a.overrideReason;
    }
    a.revision++;audit(s,ctx,p.action==='correct'?'تصحيح تنفيذ':p.action==='cancel'?'إلغاء تكليف':'تأكيد تنفيذ',old,a);return a;
  }
  function absenceReport(s,start,end){
    date(start);date(end);assert(start<=end,'الفترة غير صحيحة');
    return s.Teachers.map(t=>{
      const rows=s.Absences.filter(a=>a.teacherId===t.id&&inRange(a.date,start,end)&&a.status==='active');
      const personal=rows.filter(a=>a.reason!=='مهمة رسمية'),official=rows.filter(a=>a.reason==='مهمة رسمية');
      const count=(arr,fn)=>new Set(arr.flatMap(fn)).size;
      return {teacherId:t.id,name:t.name,full:count(personal.filter(a=>a.type==='full'),a=>[a.date]),partial:count(personal.filter(a=>a.type==='partial'),a=>[a.date]),affected:count(personal,a=>a.snapshots.map(l=>a.date+'|'+l.period)),officialDays:count(official,a=>[a.date]),officialLessons:count(official,a=>a.snapshots.map(l=>a.date+'|'+l.period)),rows:copy(rows)};
    }).sort((a,b)=>a.name.localeCompare(b.name,'ar'));
  }
  function opening(s,p){
    const t=byId(s,'Teachers',p.teacherId);date(p.date);const tm=term(s,p.date);
    const bs=balances(s,tm.id,p.date.slice(0,7),{adjustmentsAsOf:p.date,assignmentsAsOf:p.date});
    const group=s.Teachers.filter(x=>x.id!==t.id&&active(x,p.date)&&!s.Constraints.some(c=>c.active!==false&&c.teacherId===x.id&&c.kind==='exemption'&&!c.periods.length&&(c.day===null||c.day===undefined)&&inRange(p.date,c.start,c.end)));
    const members=group.map(t=>bs.find(b=>b.teacherId===t.id));return {amount:members.length?members.reduce((n,b)=>n+b.fairness,0)/members.length:0,members:members.map(b=>({teacherId:b.teacherId,name:b.name,fairness:b.fairness})),termId:tm.id};
  }
  function adjust(s,p,ctx){
    byId(s,'Teachers',p.teacherId);const tm=term(s,p.date);assert(ctx.reason,'اكتب سبب الموازنة');assert(Number.isFinite(p.amount),'قيمة الموازنة غير صحيحة');
    if(p.opening){const t=byId(s,'Teachers',p.teacherId);if(t.joinDate)assert(p.date===t.joinDate,'الرصيد الافتتاحي يحتسب عند تاريخ انضمام المعلم');assert(!s.Adjustments.some(a=>a.teacherId===p.teacherId&&a.termId===tm.id&&a.opening),'سبق تثبيت رصيد افتتاحي لهذا المعلم والفصل');const preview=opening(s,p);assert(Math.abs(preview.amount-p.amount)<1e-9&&JSON.stringify(preview.members)===JSON.stringify(p.members),'تغير المتوسط؛ أعد المعاينة');}
    const a={id:ctx.id,teacherId:p.teacherId,termId:tm.id,date:date(p.date),amount:p.amount,reason:ctx.reason,opening:!!p.opening,members:p.members||[],at:ctx.now};s.Adjustments.push(a);audit(s,ctx,'موازنة إدارية',null,a);return a;
  }
  function validateLessons(s,rows){
    const errors=[],seenT=new Set(),seenC=new Set(),ids=new Set();
    rows.forEach((l,i)=>{try{
      assert(l.id&&!ids.has(l.id),'معرف حصة مكرر أو فارغ');ids.add(l.id);
      byId(s,'Teachers',l.teacherId);byId(s,'Subjects',l.subjectId);byId(s,'Classes',l.classId);
      assert(cfg(s).schoolDays.includes(l.day)&&s.Periods.some(p=>p.number===l.period),'يوم أو حصة غير صحيح');
      const kt=[l.day,l.period,l.teacherId].join('|'),kc=[l.day,l.period,l.classId].join('|');
      assert(!seenT.has(kt),'حصتان متزامنتان للمعلم');assert(!seenC.has(kc),'حصتان متزامنتان للشعبة');seenT.add(kt);seenC.add(kc);
    }catch(e){errors.push('السطر '+(i+2)+': '+e.message);}});return errors;
  }
  function publishVersion(s,p,ctx){
    date(p.start);if(p.end)date(p.end);assert(!p.end||p.end>=p.start,'نهاية الجدول قبل بدايته');assert(p.start>=today(ctx.now),'التحديث اللاحق يبدأ اليوم أو مستقبلًا لحماية التاريخ');assert(ctx.reason,'اكتب سبب اعتماد الجدول');
    assert(Array.isArray(p.lessons)&&p.lessons.length,'الجدول فارغ');const errs=validateLessons(s,p.lessons);assert(!errs.length,errs.join('\n'));
    assert(!s.Versions.some(v=>v.id===p.id),'معرف النسخة مستخدم؛ أنشئ نسخة مستقلة');
    const old=copy(s.Versions);
    s.Versions.filter(v=>v.status==='active').forEach(v=>{
      if(inRange(p.start,v.start,v.end)){assert(v.start<p.start,'توجد نسخة تبدأ في التاريخ نفسه');v.end=new Date(new Date(p.start+'T12:00Z').getTime()-86400000).toISOString().slice(0,10);}
      assert(!inRange(v.start,p.start,p.end),'تتعارض النسخة مع جدول مستقبلي؛ حدد تاريخ نهاية مناسبًا');
    });
    s.Versions.push({id:p.id,name:p.name,start:p.start,end:p.end||'',status:'active'});
    p.lessons.forEach((l,i)=>s.Lessons.push({...copy(l),id:p.id+'-L'+i,versionId:p.id}));
    audit(s,ctx,'اعتماد نسخة جدول',old,s.Versions);review(s,ctx);return {message:'تم اعتماد الجدول؛ راجع غياب وتكليفات الأيام المستقبلية',affected:s.Absences.filter(a=>a.status==='active'&&inRange(a.date,p.start,p.end)).map(a=>({id:a.id,date:a.date,teacherId:a.teacherId}))};
  }
  function saveEntity(s,p,ctx){
    const allowed=['Teachers','Subjects','Classes','Eligibility','Constraints','Terms','Holidays','Settings'];assert(allowed.includes(p.table),'هذا النوع غير قابل للتعديل المباشر');
    const row=copy(p.row);assert(row.id&&ctx.reason,'يلزم سجل وسبب تعديل');const old=s[p.table].find(x=>x.id===row.id);
    if(old)assert(JSON.stringify(old)===JSON.stringify(p.before),'تغيرت البيانات؛ أعد فتح السجل');
    if(p.table==='Teachers'){assert(row.name&&typeof row.active==='boolean'&&typeof row.participates==='boolean','بيانات المعلم ناقصة');if(row.joinDate)date(row.joinDate);if(row.leaveDate)date(row.leaveDate);assert(!row.joinDate||!row.leaveDate||row.joinDate<=row.leaveDate,'فترة العمل غير صحيحة');assert(row.dailyLimit===null||Number.isInteger(row.dailyLimit)&&row.dailyLimit>=0,'الحد اليومي غير صحيح');}
    if(p.table==='Eligibility'){byId(s,'Teachers',row.teacherId);byId(s,'Subjects',row.subjectId);assert(s.Classes.some(c=>c.grade===row.grade),'الصف غير مسجل');assert(typeof row.enabled==='boolean','حدد حالة الأهلية');}
    if(['Subjects','Classes'].includes(p.table))assert(row.name,'اكتب الاسم');
    if(p.table==='Constraints'){
      byId(s,'Teachers',row.teacherId);assert(['commitment','exemption'].includes(row.kind),'نوع الالتزام غير صحيح');if(row.start)date(row.start);if(row.end)date(row.end);assert(!row.start||!row.end||row.start<=row.end,'الفترة غير صحيحة');assert(Array.isArray(row.periods)&&row.periods.every(n=>s.Periods.some(x=>x.number===n)),'حصص غير صحيحة');assert(row.day===null||Number.isInteger(row.day)&&row.day>=0&&row.day<=6,'اليوم غير صحيح');
    }
    if(['Terms','Holidays'].includes(p.table)){date(row.start);date(row.end);assert(row.start<=row.end,'الفترة غير صحيحة');}
    if(p.table==='Terms'){
      assert(!s.Terms.some(t=>t.id!==row.id&&row.start<=t.end&&row.end>=t.start),'الفصول متداخلة');
      if(old)assert(!s.Absences.some(a=>a.termId===row.id&&!inRange(a.date,row.start,row.end))&&!s.Assignments.some(a=>a.termId===row.id&&!inRange(a.date,row.start,row.end))&&!s.Adjustments.some(a=>a.termId===row.id&&!inRange(a.date,row.start,row.end)),'لا يمكن إخراج سجلات تاريخية من فصلها');
    }
    if(p.table==='Settings'){assert(row.id==='main'&&Number.isInteger(row.dailyLimit)&&row.dailyLimit>=0&&Number.isFinite(row.margin)&&row.margin>=0,'إعدادات غير صحيحة');assert(row.schoolDays.length&&row.schoolDays.every(d=>Number.isInteger(d)&&d>=0&&d<=6),'أيام الدراسة غير صحيحة');row.rotation=cfg(s).rotation;}
    upsert(s,p.table,row);audit(s,ctx,'تعديل '+p.table,old,row);review(s,ctx);return row;
  }
  function run(s,op,p,ctx){
    const fingerprint=ctx.payloadHash||JSON.stringify(p);
    const existing=s.Requests.find(r=>r.id===ctx.id);if(existing){assert(existing.op===op&&existing.payload===fingerprint,'معرف الطلب مستخدم لعملية أخرى');return copy(existing.result);}
    let result;
    switch(op){case 'saveAbsence':result=saveAbsence(s,p,ctx);break;case 'cancelAbsence':result=cancelAbsence(s,p,ctx);break;case 'approve':result=approve(s,p,ctx);break;case 'assignment':result=assignmentAction(s,p,ctx);break;case 'adjust':result=adjust(s,p,ctx);break;case 'entity':result=saveEntity(s,p,ctx);break;case 'publish':result=publishVersion(s,p,ctx);break;default:throw new Error('عملية غير معروفة');}
    s.Requests.push({id:ctx.id,op,payload:fingerprint,result:copy(result),at:ctx.now});return result;
  }
  return {copy,assert,date,day,today,term,version,schoolDay,lessons,snapshot,balances,needs,availability,candidates,propose,absenceReport,opening,validateLessons,run,reasons,review};
})();
if(typeof module!=='undefined')module.exports=Cover;
