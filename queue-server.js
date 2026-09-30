const express = require("express");
const path = require("path");
const crypto = require("crypto");
const multer = require("multer");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public"), {
  index: false,
  etag: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html") || filePath.endsWith(".js") || filePath.endsWith(".css")) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    }
  }
}));
app.get("/", (req,res) => res.sendFile(path.join(__dirname, "public", "queue.html")));

function tokenHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function makePasswordHash(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(String(password), salt, 64).toString("hex") };
}

function safeEqual(a,b) {
  const ab=Buffer.from(String(a));
  const bb=Buffer.from(String(b));
  return ab.length===bb.length && crypto.timingSafeEqual(ab,bb);
}

function verifyPassword(password,salt,storedHash) {
  const candidate=crypto.scryptSync(String(password), salt, 64).toString("hex");
  return safeEqual(candidate,storedHash);
}

function cleanPhone(value) {
  return String(value || "").replace(/[^0-9+]/g,"").slice(0,20);
}

function digitsOnly(value) {
  return String(value || "").replace(/\D/g,"");
}

function normalizePaymentReference(value, provider = "") {
  const cleaned = String(value || "")
    .toUpperCase()
    .split("")
    .filter(ch => (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "-")
    .join("")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return provider === "GCash" ? digitsOnly(cleaned) : cleaned;
}

function isValidPaymentReference(value, provider = "") {
  const ref=normalizePaymentReference(value,provider);
  if (provider === "GCash") return ref.length >= 6 && ref.length <= 18;
  const digitCount=(ref.match(/\d/g)||[]).length;
  return ref.length >= 6 && ref.length <= 40 && digitCount >= 4;
}

function isSingleCorrection(detected,submitted) {
  if (!detected || !submitted) return false;
  if (detected === submitted) return true;
  if (Math.abs(detected.length-submitted.length)>1) return false;
  if (detected.length===submitted.length) {
    let diff=0;
    for (let i=0;i<detected.length;i++) {
      if (detected[i]!==submitted[i]) diff++;
      if (diff>1) return false;
    }
    return true;
  }
  const shorter=detected.length<submitted.length?detected:submitted;
  const longer=detected.length<submitted.length?submitted:detected;
  let i=0,j=0,skip=0;
  while(i<shorter.length&&j<longer.length){
    if(shorter[i]===longer[j]){i++;j++;}
    else{skip++;j++;if(skip>1)return false;}
  }
  return true;
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenant_accounts (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      unit_no TEXT NOT NULL,
      access_token_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE tenant_accounts ADD COLUMN IF NOT EXISTS password_hash TEXT;
    ALTER TABLE tenant_accounts ADD COLUMN IF NOT EXISTS password_salt TEXT;

    CREATE TABLE IF NOT EXISTS delivery_queue (
      id SERIAL PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenant_accounts(id) ON DELETE CASCADE,
      unit_no TEXT NOT NULL,
      unit_price NUMERIC(12,2) NOT NULL CHECK (unit_price IN (25,35,45)),
      qty INTEGER NOT NULL CHECK (qty > 0 AND qty <= 100),
      total NUMERIC(12,2) NOT NULL,
      payment_method TEXT NOT NULL CHECK (payment_method IN ('Cash','GCash','Other')),
      payment_provider TEXT,
      payment_reference TEXT,
      payment_reference_status TEXT,
      receipt_mime TEXT,
      receipt_image BYTEA,
      status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','completed','cancelled')),
      sale_id INTEGER REFERENCES sales(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
  `);
}

async function tenantAuth(req,res,next) {
  try {
    const auth=req.headers.authorization||"";
    const token=auth.startsWith("Bearer ")?auth.slice(7):"";
    if(!token) return res.status(401).json({error:"Tenant login required."});
    const { rows }=await pool.query(
      "SELECT id,name,phone,unit_no FROM tenant_accounts WHERE access_token_hash=$1 LIMIT 1",
      [tokenHash(token)]
    );
    if(!rows.length) return res.status(401).json({error:"Tenant login required."});
    req.tenant=rows[0];
    next();
  } catch(e){next(e);}
}

function accountPayload(row) {
  return { id:row.id,name:row.name,phone:row.phone,unit_no:row.unit_no };
}

function validatePassword(value) {
  const password=String(value||"");
  if(password.length<6) return "Use at least 6 characters for your password.";
  if(password.length>100) return "Password is too long.";
  return "";
}

app.get("/api/health", (req,res)=>res.json({ok:true,site:"queue-preview"}));

app.post("/api/queue/account", async (req,res,next)=>{
  try {
    const name=String(req.body.name||"").trim().slice(0,120);
    const phone=cleanPhone(req.body.phone);
    const unitNo=String(req.body.unitNo||"").trim().slice(0,80);
    const password=String(req.body.password||"");
    const passwordError=validatePassword(password);

    if(name.length<2) return res.status(400).json({error:"Enter your name."});
    if(phone.replace(/\D/g,"").length<7) return res.status(400).json({error:"Enter a valid phone number."});
    if(!unitNo) return res.status(400).json({error:"Unit number is required."});
    if(passwordError) return res.status(400).json({error:passwordError});

    const existing=await pool.query(
      "SELECT id,password_hash FROM tenant_accounts WHERE phone=$1 LIMIT 1",
      [phone]
    );
    if(existing.rows.length){
      return res.status(409).json({
        code:existing.rows[0].password_hash?"ACCOUNT_EXISTS":"LEGACY_ACCOUNT",
        error:existing.rows[0].password_hash
          ? "An account with this phone already exists. Use Existing User Login."
          : "This preview account already exists. Use Existing User Login to set your password first."
      });
    }

    const secure=makePasswordHash(password);
    const rawToken=crypto.randomBytes(32).toString("hex");
    const { rows }=await pool.query(
      `INSERT INTO tenant_accounts(name,phone,unit_no,access_token_hash,password_hash,password_salt)
       VALUES($1,$2,$3,$4,$5,$6)
       RETURNING id,name,phone,unit_no`,
      [name,phone,unitNo,tokenHash(rawToken),secure.hash,secure.salt]
    );
    res.status(201).json({token:rawToken,account:accountPayload(rows[0])});
  } catch(e){next(e);}
});

app.post("/api/queue/login", async (req,res,next)=>{
  try {
    const phone=cleanPhone(req.body.phone);
    const password=String(req.body.password||"");
    const { rows }=await pool.query(
      "SELECT id,name,phone,unit_no,password_hash,password_salt FROM tenant_accounts WHERE phone=$1 LIMIT 1",
      [phone]
    );
    if(!rows.length) return res.status(401).json({error:"Phone number or password is incorrect."});
    const account=rows[0];
    if(!account.password_hash || !account.password_salt){
      return res.status(409).json({code:"LEGACY_SETUP",error:"This account was created before login was added. Set a password using your Unit # once."});
    }
    if(!verifyPassword(password,account.password_salt,account.password_hash)){
      return res.status(401).json({error:"Phone number or password is incorrect."});
    }

    const rawToken=crypto.randomBytes(32).toString("hex");
    await pool.query(
      "UPDATE tenant_accounts SET access_token_hash=$1,updated_at=NOW() WHERE id=$2",
      [tokenHash(rawToken),account.id]
    );
    res.json({token:rawToken,account:accountPayload(account)});
  } catch(e){next(e);}
});

app.post("/api/queue/claim", async (req,res,next)=>{
  try {
    const phone=cleanPhone(req.body.phone);
    const unitNo=String(req.body.unitNo||"").trim();
    const password=String(req.body.password||"");
    const passwordError=validatePassword(password);
    if(passwordError) return res.status(400).json({error:passwordError});

    const { rows }=await pool.query(
      "SELECT id,name,phone,unit_no,password_hash FROM tenant_accounts WHERE phone=$1 LIMIT 1",
      [phone]
    );
    if(!rows.length) return res.status(404).json({error:"Existing preview account not found."});
    const account=rows[0];
    if(account.password_hash) return res.status(409).json({error:"This account already has a password. Use Existing User Login."});
    if(account.unit_no.trim().toLowerCase()!==unitNo.toLowerCase()){
      return res.status(401).json({error:"Phone number and Unit # do not match the existing account."});
    }

    const secure=makePasswordHash(password);
    const rawToken=crypto.randomBytes(32).toString("hex");
    await pool.query(
      `UPDATE tenant_accounts
       SET password_hash=$1,password_salt=$2,access_token_hash=$3,updated_at=NOW()
       WHERE id=$4`,
      [secure.hash,secure.salt,tokenHash(rawToken),account.id]
    );
    res.json({token:rawToken,account:accountPayload(account)});
  } catch(e){next(e);}
});

app.get("/api/queue/me", tenantAuth, async (req,res)=>res.json(req.tenant));

app.get("/api/queue/requests", tenantAuth, async (req,res,next)=>{
  try {
    const { rows }=await pool.query(
      `SELECT id,unit_no,unit_price,qty,total,payment_method,payment_provider,
              payment_reference,payment_reference_status,status,created_at,completed_at,
              (receipt_image IS NOT NULL) AS has_receipt
       FROM delivery_queue
       WHERE tenant_id=$1
       ORDER BY created_at DESC LIMIT 30`,
      [req.tenant.id]
    );
    res.json(rows.map(r=>({...r,unit_price:Number(r.unit_price),total:Number(r.total),qty:Number(r.qty)})));
  } catch(e){next(e);}
});

app.post("/api/queue/requests", tenantAuth, upload.single("receipt"), async (req,res,next)=>{
  try {
    const unitPrice=Number(req.body.unitPrice);
    const qty=Math.max(1,Math.min(100,parseInt(req.body.qty,10)||1));
    if(![25,35,45].includes(unitPrice)) return res.status(400).json({error:"Choose a valid Delivery price."});

    const paymentMethod=String(req.body.paymentMethod||"");
    if(!["Cash","GCash","Other"].includes(paymentMethod)) return res.status(400).json({error:"Choose Cash or an online payment."});

    const allowedOtherProviders=["Maya","MariBank","GoTyme","VYBE by BPI"];
    const paymentProvider=paymentMethod==="GCash"?"GCash":paymentMethod==="Other"?String(req.body.paymentProvider||"").trim():null;
    if(paymentMethod==="Other"&&!allowedOtherProviders.includes(paymentProvider)){
      return res.status(400).json({error:"Choose Maya, MariBank, GoTyme, or VYBE by BPI."});
    }

    const isDigital=paymentMethod!=="Cash";
    if(isDigital&&!req.file) return res.status(400).json({error:paymentProvider+" receipt image is required."});
    if(isDigital&&!String(req.file.mimetype||"").startsWith("image/")) return res.status(400).json({error:"The payment receipt must be an image."});

    let paymentReference=null;
    let paymentReferenceStatus=isDigital?"unreadable":null;
    if(isDigital&&String(req.body.ocrVerified)==="true"){
      const detected=normalizePaymentReference(req.body.detectedReference,paymentProvider);
      const submitted=normalizePaymentReference(req.body.paymentReference,paymentProvider);
      if(isValidPaymentReference(detected,paymentProvider)&&isValidPaymentReference(submitted,paymentProvider)&&isSingleCorrection(detected,submitted)){
        paymentReference=submitted;
        paymentReferenceStatus="verified";
      }
    }

    const total=unitPrice*qty;
    const { rows }=await pool.query(
      `INSERT INTO delivery_queue(
        tenant_id,unit_no,unit_price,qty,total,payment_method,payment_provider,
        payment_reference,payment_reference_status,receipt_mime,receipt_image
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id,unit_no,unit_price,qty,total,payment_method,payment_provider,
                 payment_reference,payment_reference_status,status,created_at`,
      [req.tenant.id,req.tenant.unit_no,unitPrice,qty,total,paymentMethod,paymentProvider,
       paymentReference,paymentReferenceStatus,req.file?.mimetype||null,req.file?.buffer||null]
    );
    const row=rows[0];
    res.status(201).json({...row,unit_price:Number(row.unit_price),total:Number(row.total),qty:Number(row.qty)});
  } catch(e){next(e);}
});

app.use((err,req,res,next)=>{
  console.error(err);
  if(err&&err.code==="LIMIT_FILE_SIZE") return res.status(400).json({error:"Receipt image is too large. Use an image under 8 MB."});
  res.status(500).json({error:"Something went wrong."});
});

initDb()
  .then(()=>app.listen(PORT,()=>console.log(`Water Queue Preview running on port ${PORT}`)))
  .catch(err=>{console.error("Database initialization failed",err);process.exit(1)});
