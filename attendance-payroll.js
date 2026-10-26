"use strict";
const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");
const { posGuard } = require("./pos-auth");
const pool = new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.NODE_ENV==="production"?{rejectUnauthorized:false}:false});
const SHIFT_START_MIN=9*60, SHIFT_END_MIN=18*60, LUNCH_MIN=60, LATE_START_MIN=30;
let schemaPromise;
const sql = (db,text,params=[])=>db.query(text,params);
function manilaParts(when=new Date()){
  const p=Object.fromEntries(new Intl.DateTimeFormat("en-GB",{timeZone:"Asia/Manila",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(when).map(x=>[x.type,x.value]));
  return {date:p.year+"-"+p.month+"-"+p.day,mins:Number(p.hour)*60+Number(p.minute)};
}
function dateValid(s){return typeof s==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&!Number.isNaN(Date.parse(s+"T00:00:00Z"))&&new Date(s+"T00:00:00Z").toISOString().slice(0,10)===s;}
function parseManilaDateTime(value,label){
  if(value==null||value==="")return null;
  const text=String(value).trim();
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)||!dateValid(text.slice(0,10)))throw Object.assign(new Error("Enter a valid "+label+" date and time in Philippine time."),{status:400});
  const parsed=new Date(text+":00+08:00");
  if(!Number.isFinite(parsed.getTime()))throw Object.assign(new Error("Enter a valid "+label+" date and time in Philippine time."),{status:400});
  return parsed;
}
function money(n){return Math.round((Number(n)+Number.EPSILON)*100)/100;}
function duration(a,b){return Math.max(0,(new Date(b).getTime()-new Date(a).getTime())/60000);}
function validId(s){const n=Number(s);return Number.isSafeInteger(n)&&n>0?n:null;}
function yyyyMmDd(y,m,d){return y+"-"+String(m).padStart(2,"0")+"-"+String(d).padStart(2,"0");}
function periodBounds(year,month,half){
  const yy=Number(year),mm=Number(month);
  if(!Number.isInteger(yy)||yy<2020||yy>2100||!Number.isInteger(mm)||mm<1||mm>12||!["first","second"].includes(half))throw Object.assign(new Error("Invalid payroll period."),{status:400});
  const last=new Date(Date.UTC(yy,mm,0)).getUTCDate();
  const from=yyyyMmDd(yy,mm,half==="first"?1:16),to=yyyyMmDd(yy,mm,half==="first"?15:last);
  return {from,to,year:yy,month:mm,half,label:(half==="first"?"Oct 1-15":"Oct 16-31").replace("Oct",new Intl.DateTimeFormat("en-US",{month:"short",timeZone:"UTC"}).format(new Date(Date.UTC(yy,mm-1,1)))).replace("31",String(last))};
}
async function ensureSchema(){
  if(!schemaPromise) schemaPromise=(async()=>{
    await pool.query(`
      CREATE TABLE IF NOT EXISTS employee_pay_rates(
        user_id INTEGER PRIMARY KEY REFERENCES pos_users(id) ON DELETE CASCADE,
        payroll_name TEXT,
        daily_wage NUMERIC(12,2) NOT NULL DEFAULT 582 CHECK(daily_wage>=0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS attendance_shifts(
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES pos_users(id),
        work_day DATE NOT NULL,
        clock_in TIMESTAMPTZ NOT NULL,
        clock_out TIMESTAMPTZ,
        state TEXT NOT NULL DEFAULT 'working' CHECK(state IN('working','lunch','out')),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id,work_day)
      );
      CREATE TABLE IF NOT EXISTS attendance_pauses(
        id BIGSERIAL PRIMARY KEY,
        shift_id BIGINT NOT NULL REFERENCES attendance_shifts(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN('lunch','pause')),
        started_at TIMESTAMPTZ NOT NULL,
        ended_at TIMESTAMPTZ,
        CHECK(ended_at IS NULL OR ended_at>=started_at)
      );
      CREATE INDEX IF NOT EXISTS attendance_pauses_shift_idx ON attendance_pauses(shift_id,started_at);
      CREATE TABLE IF NOT EXISTS attendance_audit(
        id BIGSERIAL PRIMARY KEY,
        shift_id BIGINT NOT NULL REFERENCES attendance_shifts(id),
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        note TEXT,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS payroll_settings(
        id SMALLINT PRIMARY KEY CHECK(id=1),
        next_payslip_no INTEGER NOT NULL DEFAULT 46 CHECK(next_payslip_no>0)
      );
      INSERT INTO payroll_settings(id,next_payslip_no) VALUES (1,46) ON CONFLICT(id) DO NOTHING;
      CREATE TABLE IF NOT EXISTS payroll_payslips(
        id BIGSERIAL PRIMARY KEY,
        payslip_no INTEGER NOT NULL UNIQUE,
        user_id INTEGER NOT NULL REFERENCES pos_users(id),
        period_from DATE NOT NULL,
        period_to DATE NOT NULL,
        pay_date DATE NOT NULL,
        employee_name TEXT NOT NULL,
        period_label TEXT NOT NULL,
        earnings JSONB NOT NULL,
        deductions JSONB NOT NULL,
        payroll_notes TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id,period_from,period_to)
      );
      CREATE TABLE IF NOT EXISTS payroll_payslip_audit(
        id BIGSERIAL PRIMARY KEY,
        payslip_no INTEGER NOT NULL,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        snapshot JSONB,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  })().catch(e=>{schemaPromise=null;throw e});
  return schemaPromise;
}
function posAuth(req,res,next){
  // The attendance API must accept the same POS sessions as /api/pos/me,
  // /api/sales and the online queue. A legacy JWT-only guard here caused
  // immediate 401s (and forced client-side logout) after successful sign-in.
  return posGuard(req,res,()=>{
    req.attendanceUser=req.posUser;
    next();
  });
}
const wrap=fn=>(req,res)=>Promise.resolve().then(ensureSchema).then(()=>fn(req,res)).catch(e=>{console.error("Attendance/payroll:",e);res.status(e.status||500).json({error:e.status?e.message:"Unable to process attendance or payroll. Try again."});});
async function shiftView(db,shift,when=new Date()){
 if(!shift)return null;
 const r=await sql(db,"SELECT id,kind,started_at,ended_at FROM attendance_pauses WHERE shift_id=$1 ORDER BY started_at ASC,id ASC",[shift.id]);
 const end=shift.state==="out"?shift.clock_out:when;
 const elapsed=duration(shift.clock_in,end);
 let lunch=0,paused=0;
 for(const b of r.rows){const mins=duration(b.started_at,b.ended_at||end);if(b.kind==="lunch")lunch+=mins;else paused+=mins;}
 const lunchRows=r.rows.filter(x=>x.kind==="lunch");
 const activeLunch=lunchRows.find(x=>!x.ended_at);
 const firstLunch=lunchRows[0];
 const totalMinutes=Math.max(0,Math.round(elapsed-lunch-paused));
 const clockInMinute=manilaParts(new Date(shift.clock_in)).mins;
 const clockOutMinute=shift.clock_out?manilaParts(new Date(shift.clock_out)).mins:null;
 const lateMinutes=Math.max(0,clockInMinute-SHIFT_START_MIN);
 const earlyOutMinutes=shift.state==="out"&&clockOutMinute!==null?Math.max(0,SHIFT_END_MIN-clockOutMinute):0;
 return {id:shift.id,userId:shift.user_id,day:dayString(shift.work_day),state:shift.state,clockIn:shift.clock_in,clockOut:shift.clock_out,paidWorkMinutes:totalMinutes,lunchMinutes:Math.round(lunch),pausedMinutes:Math.round(paused),lunchStartedAt:activeLunch?.started_at||null,lunchStartAt:firstLunch?.started_at||null,lunchEndAt:firstLunch?.ended_at||null,lunchIntervals:lunchRows.map(x=>({startedAt:x.started_at,endedAt:x.ended_at})),lateMinutes,earlyOutMinutes,early:shift.state==="out"&&(totalMinutes<480||earlyOutMinutes>0)};
}
async function todayShift(db,userId){
 const day=manilaParts().date;
 const r=await sql(db,"SELECT * FROM attendance_shifts WHERE user_id=$1 AND work_day=$2::date LIMIT 1",[userId,day]);
 return r.rows[0]||null;
}
function attendanceRoutes(app){
 app.get("/api/pos/attendance",posAuth,wrap(async(req,res)=>{
   const s=await todayShift(pool,req.attendanceUser.id);
   res.set("Cache-Control","no-store").json({serverNow:new Date().toISOString(),shift:await shiftView(pool,s),shiftEnd:"18:00",scheduledMinutes:540,lunchMinutes:60});
 }));
 app.post("/api/pos/attendance/:action",posAuth,wrap(async(req,res)=>{
   const action=req.params.action;
   if(!["time-in","time-out","continue","lunch-start","lunch-end"].includes(action))return res.status(404).json({error:"Unknown attendance action."});
   const client=await pool.connect();
   try{
     await client.query("BEGIN");
     await client.query("SELECT pg_advisory_xact_lock($1)",[1000000+req.attendanceUser.id]);
     const day=manilaParts().date;
     const now=new Date();
     const current=await sql(client,"SELECT * FROM attendance_shifts WHERE user_id=$1 AND work_day=$2::date FOR UPDATE",[req.attendanceUser.id,day]);
     let shift=current.rows[0];
     if(action==="time-in"){
       if(shift){await client.query("ROLLBACK");return res.status(409).json({error:shift.state==="out"?"Already clocked out today. Use Continue Shift.":"You are already clocked in today."});}
       const ins=await sql(client,"INSERT INTO attendance_shifts(user_id,work_day,clock_in) VALUES($1,$2::date,NOW()) RETURNING *",[req.attendanceUser.id,day]);
       shift=ins.rows[0];
     } else {
       if(!shift){await client.query("ROLLBACK");return res.status(409).json({error:"Please time in first."});}
       if(action==="continue"){
         if(shift.state!=="out"){await client.query("ROLLBACK");return res.status(409).json({error:"Shift is already active."});}
         await sql(client,"UPDATE attendance_pauses SET ended_at=NOW() WHERE shift_id=$1 AND kind='pause' AND ended_at IS NULL",[shift.id]);
         shift=(await sql(client,"UPDATE attendance_shifts SET state='working',clock_out=NULL,updated_at=NOW() WHERE id=$1 RETURNING *",[shift.id])).rows[0];
       } else if(action==="lunch-start"){
         if(shift.state!=="working"){await client.query("ROLLBACK");return res.status(409).json({error:"End your current lunch or continue your shift first."});}
         await sql(client,"INSERT INTO attendance_pauses(shift_id,kind,started_at) VALUES($1,'lunch',NOW())",[shift.id]);
         shift=(await sql(client,"UPDATE attendance_shifts SET state='lunch',updated_at=NOW() WHERE id=$1 RETURNING *",[shift.id])).rows[0];
       } else if(action==="lunch-end"){
         if(shift.state!=="lunch"){await client.query("ROLLBACK");return res.status(409).json({error:"You have not started your lunch."});}
         await sql(client,"UPDATE attendance_pauses SET ended_at=NOW() WHERE shift_id=$1 AND kind='lunch' AND ended_at IS NULL",[shift.id]);
         shift=(await sql(client,"UPDATE attendance_shifts SET state='working',updated_at=NOW() WHERE id=$1 RETURNING *",[shift.id])).rows[0];
       } else if(action==="time-out"){
         if(shift.state==="out"){await client.query("ROLLBACK");return res.status(409).json({error:"Already clocked out. Tap Continue Shift if needed."});}
         if(shift.state==="lunch"){await client.query("ROLLBACK");return res.status(409).json({error:"End Lunch before clocking out."});}
         const before=await shiftView(client,shift,now);
         const early=before.paidWorkMinutes<480||manilaParts(now).mins<SHIFT_END_MIN;
         if(early&&req.body?.confirmEarly!==true){
           await client.query("ROLLBACK");
           return res.status(409).json({needsConfirmation:true,workedMinutes:before.paidWorkMinutes,error:"You have not completed 9 hours / the 6:00 PM clock-out time. Continue working, or confirm Early Time Out. You can resume today's shift afterward."});
         }
         shift=(await sql(client,"UPDATE attendance_shifts SET state='out',clock_out=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *",[shift.id])).rows[0];
         await sql(client,"INSERT INTO attendance_pauses(shift_id,kind,started_at) VALUES($1,'pause',NOW())",[shift.id]);
       }
     }
     await sql(client,"INSERT INTO attendance_audit(shift_id,actor,action,note) VALUES($1,$2,$3,$4)",[shift.id,"pos:"+req.attendanceUser.id,action,action==="time-out"&&req.body?.confirmEarly?"Early clock-out confirmed":null]);
     await client.query("COMMIT");
     res.json({ok:true,shift:await shiftView(pool,shift)});
   }catch(e){await client.query("ROLLBACK").catch(()=>{});throw e;}finally{client.release();}
 }));

 app.post("/api/admin/payroll/employees",wrap(async(req,res)=>{
   const name=String(req.body?.name||"").trim().slice(0,120);
   const email=String(req.body?.email||"").trim().toLowerCase();
   const password=String(req.body?.password||"");
   const rate=Number(req.body?.dailyWage??582);
   if(name.length<2||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<8||password.length>128||!Number.isFinite(rate)||rate<0||rate>100000){
     return res.status(400).json({error:"Enter an employee name, valid email, password of at least 8 characters, and valid daily rate."});
   }
   const client=await pool.connect();
   try{
     await client.query("BEGIN");
     const salt=crypto.randomBytes(16).toString("hex");
     const hash=crypto.scryptSync(password,salt,64).toString("hex");
     const inserted=await sql(client,"INSERT INTO pos_users(name,email,password_hash,salt,active,auth_version) VALUES($1,$2,$3,$4,TRUE,1) RETURNING id,name,email,active",[name,email,hash,salt]);
     const user=inserted.rows[0];
     await sql(client,"INSERT INTO employee_pay_rates(user_id,payroll_name,daily_wage) VALUES($1,$2,$3)",[user.id,name,money(rate)]);
     await client.query("COMMIT");
     res.status(201).json({...user,payroll_name:name,daily_wage:money(rate)});
   }catch(e){await client.query("ROLLBACK").catch(()=>{});if(e.code==="23505")e=Object.assign(new Error("That employee login email is already registered."),{status:409});throw e;}finally{client.release();}
 }));
 app.get("/api/admin/payroll/employees",wrap(async(req,res)=>{
   const r=await sql(pool,"SELECT u.id,u.name,u.email,u.active,COALESCE(p.payroll_name,u.name) AS payroll_name,COALESCE(p.daily_wage,582) AS daily_wage FROM pos_users u LEFT JOIN employee_pay_rates p ON p.user_id=u.id ORDER BY u.name,u.id");
   res.json(r.rows);
 }));
 app.patch("/api/admin/payroll/employees/:id",wrap(async(req,res)=>{
   const id=validId(req.params.id),rate=Number(req.body?.dailyWage),name=String(req.body?.payrollName||"").trim().slice(0,120);
   if(!id||!name||!Number.isFinite(rate)||rate<0||rate>100000)return res.status(400).json({error:"Enter a valid name and nonnegative daily wage."});
   const r=await sql(pool,"INSERT INTO employee_pay_rates(user_id,payroll_name,daily_wage) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET payroll_name=EXCLUDED.payroll_name,daily_wage=EXCLUDED.daily_wage,updated_at=NOW() RETURNING *",[id,name,money(rate)]);
   res.json(r.rows[0]);
 }));
 app.get("/api/admin/payroll/settings",wrap(async(req,res)=>{
   const [s,l]=await Promise.all([sql(pool,"SELECT next_payslip_no FROM payroll_settings WHERE id=1"),sql(pool,"SELECT COALESCE(MAX(payslip_no),0)::int max_no FROM payroll_payslips")]);
   res.json({nextPayslipNo:Number(s.rows[0].next_payslip_no),highestIssued:Number(l.rows[0].max_no)});
 }));
 app.patch("/api/admin/payroll/settings",wrap(async(req,res)=>{
   const n=validId(req.body?.nextPayslipNo);
   if(!n)return res.status(400).json({error:"Enter a valid starting payslip number."});
   const max=await sql(pool,"SELECT COALESCE(MAX(payslip_no),0)::int AS issued FROM payroll_payslips");
   if(n<=Number(max.rows[0].issued))return res.status(400).json({error:"Next payslip number must exceed the highest already issued."});
   await sql(pool,"UPDATE payroll_settings SET next_payslip_no=$1 WHERE id=1",[n]);res.json({nextPayslipNo:n});
 }));
 app.get("/api/admin/payroll/attendance",wrap(async(req,res)=>{
   const from=req.query.from,to=req.query.to;
   if(!dateValid(from)||!dateValid(to)||from>to||duration(from+"T00:00:00Z",to+"T00:00:00Z")>35*1440)return res.status(400).json({error:"Choose a valid date range up to 35 days."});
   const uid=req.query.employeeId?validId(req.query.employeeId):null;
   const r=await sql(pool,"SELECT s.*,u.name FROM attendance_shifts s JOIN pos_users u ON u.id=s.user_id WHERE s.work_day BETWEEN $1::date AND $2::date AND ($3::int IS NULL OR s.user_id=$3) ORDER BY s.work_day DESC,u.name",[from,to,uid]);
   res.json(await Promise.all(r.rows.map(async s=>({...await shiftView(pool,s),name:s.name}))));
 }));
 app.patch("/api/admin/payroll/attendance/:id",wrap(async(req,res)=>{
   const id=validId(req.params.id),note=String(req.body?.reason||"").trim().slice(0,400);
   if(!id||!note)return res.status(400).json({error:"A valid DTR record and correction reason are required."});
   const clockInAt=parseManilaDateTime(req.body?.clockInAt,"time-in");
   const clockOutAt=parseManilaDateTime(req.body?.clockOutAt,"time-out");
   const lunchStartAt=parseManilaDateTime(req.body?.lunchStartAt,"lunch start");
   const lunchEndAt=parseManilaDateTime(req.body?.lunchEndAt,"lunch end");
   if(!clockInAt)return res.status(400).json({error:"Time-in is required."});
   const now=new Date();
   if(clockInAt>now||(clockOutAt&&clockOutAt>now)||(lunchStartAt&&lunchStartAt>now)||(lunchEndAt&&lunchEndAt>now))return res.status(400).json({error:"Attendance timestamps cannot be in the future."});
   if(!lunchStartAt&&lunchEndAt)return res.status(400).json({error:"Enter lunch start before lunch end."});
   if(lunchStartAt&&!lunchEndAt&&clockOutAt)return res.status(400).json({error:"Enter lunch end or clear lunch start before setting a final time-out."});
   if(lunchStartAt&&lunchStartAt<clockInAt)return res.status(400).json({error:"Lunch cannot start before time-in."});
   if(lunchEndAt&&lunchEndAt<lunchStartAt)return res.status(400).json({error:"Lunch end must be after lunch start."});
   if(clockOutAt&&clockOutAt<=clockInAt)return res.status(400).json({error:"Time-out must be after time-in."});
   if(lunchEndAt&&clockOutAt&&lunchEndAt>clockOutAt)return res.status(400).json({error:"Lunch must end before time-out."});
   const client=await pool.connect();
   try{
     await client.query("BEGIN");
     const found=await sql(client,"SELECT * FROM attendance_shifts WHERE id=$1 FOR UPDATE",[id]);
     if(!found.rows.length){await client.query("ROLLBACK");return res.status(404).json({error:"Attendance record not found."});}
     const shift=found.rows[0],day=dayString(shift.work_day);
     if(manilaParts(clockInAt).date!==day||(clockOutAt&&manilaParts(clockOutAt).date!==day)||(lunchStartAt&&manilaParts(lunchStartAt).date!==day)||(lunchEndAt&&manilaParts(lunchEndAt).date!==day)){
       await client.query("ROLLBACK");return res.status(400).json({error:"Corrected timestamps must stay on the DTR work date shown."});
     }
     const lunchRows=await sql(client,"SELECT id,started_at,ended_at FROM attendance_pauses WHERE shift_id=$1 AND kind='lunch' ORDER BY started_at ASC,id ASC",[id]);
     const first=lunchRows.rows[0];
     if(!lunchStartAt&&!lunchEndAt){
       if(first)await sql(client,"DELETE FROM attendance_pauses WHERE id=$1",[first.id]);
     }else if(first){
       await sql(client,"UPDATE attendance_pauses SET started_at=$2,ended_at=$3 WHERE id=$1",[first.id,lunchStartAt,lunchEndAt]);
     }else{
       await sql(client,"INSERT INTO attendance_pauses(shift_id,kind,started_at,ended_at) VALUES($1,'lunch',$2,$3)",[id,lunchStartAt,lunchEndAt]);
     }
     const state=clockOutAt?"out":(lunchStartAt&&!lunchEndAt?"lunch":"working");
     const changed=(await sql(client,"UPDATE attendance_shifts SET clock_in=$2,clock_out=$3,state=$4,updated_at=NOW() WHERE id=$1 RETURNING *",[id,clockInAt,clockOutAt,state])).rows[0];
     if(clockOutAt){
       const openPause=await sql(client,"SELECT id FROM attendance_pauses WHERE shift_id=$1 AND kind='pause' AND ended_at IS NULL ORDER BY started_at DESC,id DESC LIMIT 1",[id]);
       if(openPause.rows.length)await sql(client,"UPDATE attendance_pauses SET started_at=$2,ended_at=NULL WHERE id=$1",[openPause.rows[0].id,clockOutAt]);
       else await sql(client,"INSERT INTO attendance_pauses(shift_id,kind,started_at) VALUES($1,'pause',$2)",[id,clockOutAt]);
     }else{
       await sql(client,"DELETE FROM attendance_pauses WHERE shift_id=$1 AND kind='pause' AND ended_at IS NULL",[id]);
     }
     await sql(client,"INSERT INTO attendance_audit(shift_id,actor,action,note) VALUES($1,$2,'admin-edit',$3)",[id,"admin:"+String(req.adminAccount?.id||"unknown"),note]);
     await client.query("COMMIT");
     res.json({ok:true,shift:await shiftView(pool,changed)});
   }catch(e){await client.query("ROLLBACK").catch(()=>{});throw e;}finally{client.release();}
 }));
 app.post("/api/admin/payroll/attendance/:id/close",wrap(async(req,res)=>{
   const id=validId(req.params.id),note=String(req.body?.reason||"").trim().slice(0,400);
   if(!id||!note)return res.status(400).json({error:"A reason is required for an admin time-out."});
   const client=await pool.connect();
   try{
     await client.query("BEGIN");
     const r=await sql(client,"SELECT * FROM attendance_shifts WHERE id=$1 FOR UPDATE",[id]);
     if(!r.rows.length){await client.query("ROLLBACK");return res.status(404).json({error:"Attendance record not found."});}
     const s=r.rows[0];
     if(s.state==="out"){await client.query("ROLLBACK");return res.status(409).json({error:"This shift is already clocked out."});}
     const day=dayString(s.work_day);
     const at=req.body?.clockOutAt?new Date(String(req.body.clockOutAt)+"+08:00"):new Date(day<manilaParts().date?day+"T18:00:00+08:00":new Date().toISOString());
     if(!Number.isFinite(at.getTime())||at<=new Date(s.clock_in)||at>new Date()){await client.query("ROLLBACK");return res.status(400).json({error:"Clock-out must be after time-in and not in the future."});}
     await sql(client,"UPDATE attendance_pauses SET ended_at=$2 WHERE shift_id=$1 AND ended_at IS NULL",[id,at]);
     const changed=await sql(client,"UPDATE attendance_shifts SET state='out',clock_out=$2,updated_at=NOW() WHERE id=$1 RETURNING *",[id,at]);
     await sql(client,"INSERT INTO attendance_audit(shift_id,actor,action,note) VALUES($1,$2,$3,$4)",[id,"admin:"+req.adminAccount.id,"admin-time-out",note]);
     await client.query("COMMIT");res.json({ok:true,shift:await shiftView(pool,changed.rows[0])});
   }catch(e){await client.query("ROLLBACK").catch(()=>{});throw e;}finally{client.release();}
 }));
 app.get("/api/admin/payroll/preview",wrap(async(req,res)=>{
   const id=validId(req.query.employeeId);if(!id)return res.status(400).json({error:"Choose an employee."});
   const bounds=periodBounds(req.query.year,req.query.month,req.query.half);
   const employee=await sql(pool,"SELECT u.id,u.name,COALESCE(p.payroll_name,u.name) AS payroll_name,COALESCE(p.daily_wage,582) AS daily_wage FROM pos_users u LEFT JOIN employee_pay_rates p ON p.user_id=u.id WHERE u.id=$1",[id]);
   if(!employee.rows.length)return res.status(404).json({error:"Employee not found."});
   const e=employee.rows[0],rate=Number(e.daily_wage);
   const days=await sql(pool,"SELECT * FROM attendance_shifts WHERE user_id=$1 AND work_day BETWEEN $2::date AND $3::date ORDER BY work_day",[id,bounds.from,bounds.to]);
   const results=[];
   let lateMinutes=0,earlyMinutes=0,extraLunchMinutes=0,pausedMinutes=0,daysPaid=0,pending=0;
   for(const s of days.rows){
     const view=await shiftView(pool,s);
     const completed=s.state==="out";
     const arrival=manilaParts(new Date(s.clock_in)).mins;
     const late=Math.max(0,arrival-SHIFT_START_MIN);
     const lateCharged=late>=LATE_START_MIN?late:0;
     const outMinute=s.clock_out?manilaParts(new Date(s.clock_out)).mins:null;
     const early=completed?Math.max(0,SHIFT_END_MIN-outMinute):0;
     const lunchOver=completed?Math.max(0,view.lunchMinutes-LUNCH_MIN):0;
     // Charge at most 8 paid hours per day. An extremely short shift must
     // never generate a negative wage or duplicate the same missing time.
     let remaining=480;
     const chargedLate=completed?Math.min(remaining,lateCharged):0;remaining-=chargedLate;
     const chargedEarly=completed?Math.min(remaining,early):0;remaining-=chargedEarly;
     const chargedLunch=completed?Math.min(remaining,lunchOver):0;remaining-=chargedLunch;
     const chargedPause=completed?Math.min(remaining,view.pausedMinutes):0;
     if(completed){daysPaid++;lateMinutes+=chargedLate;earlyMinutes+=chargedEarly;extraLunchMinutes+=chargedLunch;pausedMinutes+=chargedPause;}else pending++;
     results.push({id:s.id,date:dayString(s.work_day),completed,clockIn:view.clockIn,clockOut:view.clockOut,lunchStartAt:view.lunchStartAt,lunchEndAt:view.lunchEndAt,paidWorkMinutes:view.paidWorkMinutes,lateMinutes:late,lateDeductedMinutes:chargedLate,earlyMinutes:early,lunchMinutes:view.lunchMinutes,extraLunchMinutes:lunchOver,pausedMinutes:view.pausedMinutes,state:s.state});
   }
   const perMin=rate/480;
   const gross=money(daysPaid*rate);
   const earnings=[{label:bounds.label+" · "+daysPaid+" completed day"+(daysPaid===1?"":"s")+" × ₱"+rate.toFixed(2),amount:gross}];
   const deductions=[
     {label:"Late",amount:money(lateMinutes*perMin)},
     {label:"Early Time Out",amount:money(earlyMinutes*perMin)},
     {label:"Excess Lunch",amount:money(extraLunchMinutes*perMin)},
     {label:"Time-Out Gap",amount:money(pausedMinutes*perMin)}
   ];
   const existing=await sql(pool,"SELECT * FROM payroll_payslips WHERE user_id=$1 AND period_from=$2::date AND period_to=$3::date",[id,bounds.from,bounds.to]);
   const settings=await sql(pool,"SELECT next_payslip_no FROM payroll_settings WHERE id=1");
   const saved=existing.rows[0];
   res.json({employee:{...e,daily_wage:rate},period:bounds,payDate:manilaParts().date,estimatedPayslipNo:saved?.payslip_no||settings.rows[0].next_payslip_no,earnings,deductions,days:results,completedDays:daysPaid,openDays:pending,lateMinutes,earlyMinutes,extraLunchMinutes,pausedMinutes,saved:saved?{...saved,period_from:dayString(saved.period_from),period_to:dayString(saved.period_to),pay_date:dayString(saved.pay_date)}:null});
 }));
 app.get("/api/admin/payroll/payslips",wrap(async(req,res)=>{
   const r=await sql(pool,"SELECT id,payslip_no,employee_name,period_from,period_to,pay_date,updated_at,user_id FROM payroll_payslips ORDER BY updated_at DESC LIMIT 80");
   res.json(r.rows.map(x=>({...x,period_from:dayString(x.period_from),period_to:dayString(x.period_to),pay_date:dayString(x.pay_date)})));
 }));
 app.delete("/api/admin/payroll/payslips/:id",wrap(async(req,res)=>{
   const id=validId(req.params.id);
   if(!id)return res.status(400).json({error:"Invalid saved payslip."});
   const client=await pool.connect();
   try{
     await client.query("BEGIN");
     const found=await sql(client,"SELECT * FROM payroll_payslips WHERE id=$1 FOR UPDATE",[id]);
     if(!found.rows.length){await client.query("ROLLBACK");return res.status(404).json({error:"Saved payslip not found."});}
     const row=found.rows[0];
     await sql(client,"INSERT INTO payroll_payslip_audit(payslip_no,actor,action,snapshot) VALUES($1,$2,'delete',$3::jsonb)",[row.payslip_no,"admin:"+String(req.adminAccount?.id||"unknown"),JSON.stringify(row)]);
     await sql(client,"DELETE FROM payroll_payslips WHERE id=$1",[id]);
     await client.query("COMMIT");
     res.json({ok:true,id:row.id,payslip_no:row.payslip_no});
   }catch(e){await client.query("ROLLBACK").catch(()=>{});throw e;}finally{client.release();}
 }));
 app.post("/api/admin/payroll/payslips",wrap(async(req,res)=>{
   const id=validId(req.body?.employeeId),bounds=periodBounds(req.body?.year,req.body?.month,req.body?.half);
   const name=String(req.body?.employeeName||"").trim().slice(0,120),payDate=String(req.body?.payDate||"");
   const label=String(req.body?.periodLabel||bounds.label).trim().slice(0,120),notes=String(req.body?.notes||"").trim().slice(0,500);
   if(!id||!name||!dateValid(payDate)||!label)return res.status(400).json({error:"Enter employee name, pay date and period."});
   const cleanRows=(rows)=>{if(!Array.isArray(rows)||rows.length>15)throw Object.assign(new Error("Up to 15 editable rows per column are allowed."),{status:400});return rows.map(x=>{const name=String(x.label||"").trim().slice(0,100),amount=Number(x.amount);if(!name||!Number.isFinite(amount)||amount<0||amount>10000000)throw Object.assign(new Error("Each earning or deduction needs a label and a valid amount."),{status:400});return {label:name,amount:money(amount)};});};
   const earnings=cleanRows(req.body.earnings),deductions=cleanRows(req.body.deductions);
   if(!earnings.length)return res.status(400).json({error:"Add at least one earning row."});
   const client=await pool.connect();
   try{
     await client.query("BEGIN");
     const check=await sql(client,"SELECT id FROM pos_users WHERE id=$1",[id]);
     if(!check.rows.length){await client.query("ROLLBACK");return res.status(404).json({error:"Employee not found."});}
     const old=await sql(client,"SELECT id,payslip_no FROM payroll_payslips WHERE user_id=$1 AND period_from=$2::date AND period_to=$3::date FOR UPDATE",[id,bounds.from,bounds.to]);
     let row;
     if(old.rows.length){
       row=(await sql(client,"UPDATE payroll_payslips SET pay_date=$2::date,employee_name=$3,period_label=$4,earnings=$5::jsonb,deductions=$6::jsonb,payroll_notes=$7,updated_at=NOW() WHERE id=$1 RETURNING *",[old.rows[0].id,payDate,name,label,JSON.stringify(earnings),JSON.stringify(deductions),notes])).rows[0];
     }else{
       const setting=await sql(client,"SELECT next_payslip_no FROM payroll_settings WHERE id=1 FOR UPDATE");
       const next=Number(setting.rows[0].next_payslip_no);
       row=(await sql(client,"INSERT INTO payroll_payslips(payslip_no,user_id,period_from,period_to,pay_date,employee_name,period_label,earnings,deductions,payroll_notes) VALUES($1,$2,$3::date,$4::date,$5::date,$6,$7,$8::jsonb,$9::jsonb,$10) RETURNING *",[next,id,bounds.from,bounds.to,payDate,name,label,JSON.stringify(earnings),JSON.stringify(deductions),notes])).rows[0];
       await sql(client,"UPDATE payroll_settings SET next_payslip_no=$1 WHERE id=1",[next+1]);
     }
     await client.query("COMMIT");
     res.json({...row,period_from:dayString(row.period_from),period_to:dayString(row.period_to),pay_date:dayString(row.pay_date),gross:money(earnings.reduce((a,x)=>a+x.amount,0)),deductionTotal:money(deductions.reduce((a,x)=>a+x.amount,0)),netPay:money(earnings.reduce((a,x)=>a+x.amount,0)-deductions.reduce((a,x)=>a+x.amount,0))});
   }catch(e){await client.query("ROLLBACK").catch(()=>{});throw e;}finally{client.release();}
 }));
}
function dayString(value){if(typeof value==="string")return value.slice(0,10);return manilaParts(value).date;}
const originalListen=express.application.listen;
express.application.listen=function(...args){
  attendanceRoutes(this);
  return originalListen.apply(this,args);
};
