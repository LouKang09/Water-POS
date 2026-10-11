const express = require("express");
const path = require("path");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
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
app.get("/brand/inyou-official.webp", (req,res) => res.redirect(302,"/brand/inyou-official-hd.png"));
app.get("/brand/inyou-official.png", (req,res) => res.redirect(302,"/brand/inyou-official-hd.png"));
app.get("/brand/inyou-official.jpg", (req,res) => res.redirect(302,"/brand/inyou-official-hd.png"));
app.get("/brand/inyou-official-hd.png", (req,res) => {
  res.setHeader("Cache-Control","public, max-age=86400");
  res.type("image/png").sendFile(path.join(__dirname,"branding","inyou-official-hd.png"));
});
const SITE_MODE = process.env.SITE_MODE || "pos";
app.use(express.static(path.join(__dirname, "public"), {
  index: SITE_MODE === "queue" ? false : "index.html",
  etag: false,
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html") || filePath.endsWith(".js") || filePath.endsWith(".css")) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    }
  }
}));
if (SITE_MODE === "queue") {
  app.get("/", (req,res) => res.sendFile(path.join(__dirname, "public", "queue.html")));
}

const JWT_SECRET = process.env.JWT_SECRET || "development-only-change-me";

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sales (
      id SERIAL PRIMARY KEY,
      transaction_ref TEXT UNIQUE NOT NULL,
      payment_method TEXT NOT NULL CHECK (payment_method IN ('Cash','GCash','Other','Pay Later')),
      payment_provider TEXT,
      payment_reference TEXT,
      gcash_reference TEXT,
      total NUMERIC(12,2) NOT NULL,
      receipt_mime TEXT,
      receipt_image BYTEA,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sale_items (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      label TEXT NOT NULL,
      unit_price NUMERIC(12,2) NOT NULL,
      qty INTEGER NOT NULL CHECK (qty > 0),
      line_total NUMERIC(12,2) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      amount NUMERIC(12,2) NOT NULL CHECK (amount > 0),
      category TEXT NOT NULL,
      note TEXT,
      expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS used_products (
      id SERIAL PRIMARY KEY,
      label TEXT NOT NULL,
      price NUMERIC(12,2) NOT NULL CHECK (price > 0),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tenant_accounts (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      unit_no TEXT NOT NULL,
      access_token_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

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

    CREATE INDEX IF NOT EXISTS delivery_queue_status_created_idx
      ON delivery_queue(status, created_at);

    ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_provider TEXT;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_reference TEXT;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_reference_status TEXT;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS delivery_room_unit TEXT;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_status TEXT;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS was_pay_later BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

    UPDATE sales
    SET payment_provider = COALESCE(payment_provider, 'GCash'),
        payment_reference = COALESCE(payment_reference, gcash_reference),
        payment_reference_status = COALESCE(payment_reference_status, 'verified')
    WHERE payment_method = 'GCash';

    UPDATE sales
    SET payment_reference_status = COALESCE(
      payment_reference_status,
      CASE WHEN payment_method IN ('Cash','Pay Later') THEN NULL
           WHEN payment_reference IS NOT NULL THEN 'verified'
           ELSE 'unreadable'
      END
    );

    UPDATE sales
    SET payment_status = CASE WHEN payment_method='Pay Later' THEN 'unpaid' ELSE 'paid' END
    WHERE payment_status IS NULL;

    UPDATE sales
    SET paid_at = created_at
    WHERE payment_status='paid' AND paid_at IS NULL;

    ALTER TABLE sales ALTER COLUMN payment_status SET DEFAULT 'paid';
    ALTER TABLE sales ALTER COLUMN payment_status SET NOT NULL;

    ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_payment_status_check;
    ALTER TABLE sales
      ADD CONSTRAINT sales_payment_status_check
      CHECK (payment_status IN ('paid','unpaid'));

    ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_payment_method_check;
    ALTER TABLE sales
      ADD CONSTRAINT sales_payment_method_check
      CHECK (payment_method IN ('Cash','GCash','Other','Pay Later'));
  `);
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function makePasswordHash(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString("hex") };
}

function verifyPassword(password, salt, storedHash) {
  const candidate = crypto.scryptSync(password, salt, 64).toString("hex");
  return safeEqual(candidate, storedHash);
}

function adminAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Admin authentication required." });
  }
}

function tokenHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

async function tenantAuth(req,res,next) {
  try {
    const auth=req.headers.authorization || "";
    const token=auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) return res.status(401).json({error:"Tenant account required."});
    const hash=tokenHash(token);
    const { rows }=await pool.query(
      "SELECT id,name,phone,unit_no FROM tenant_accounts WHERE access_token_hash=$1 LIMIT 1",
      [hash]
    );
    if (!rows.length) return res.status(401).json({error:"Tenant account required."});
    req.tenant=rows[0];
    next();
  } catch(e){ next(e); }
}

function cleanPhone(value) {
  return String(value || "").replace(/[^0-9+]/g,"").slice(0,20);
}

function digitsOnly(value) {
  return String(value || "").split("").filter(ch => ch >= "0" && ch <= "9").join("");
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
  const ref = normalizePaymentReference(value, provider);
  if (provider === "GCash") return ref.length >= 6 && ref.length <= 18;
  const digitCount = ref.split("").filter(ch => ch >= "0" && ch <= "9").length;
  return ref.length >= 6 && ref.length <= 40 && digitCount >= 4;
}

function isSingleDigitCorrection(detected, submitted) {
  if (!detected || !submitted) return false;
  if (detected === submitted) return true;
  if (Math.abs(detected.length - submitted.length) > 1) return false;

  if (detected.length === submitted.length) {
    let differences = 0;
    for (let i = 0; i < detected.length; i++) {
      if (detected[i] !== submitted[i]) differences += 1;
      if (differences > 1) return false;
    }
    return true;
  }

  const shorter = detected.length < submitted.length ? detected : submitted;
  const longer = detected.length < submitted.length ? submitted : detected;
  let i = 0;
  let j = 0;
  let skipped = 0;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i += 1;
      j += 1;
    } else {
      skipped += 1;
      j += 1;
      if (skipped > 1) return false;
    }
  }
  return true;
}

function txRef() {
  const d = new Date();
  const stamp = [
    d.getFullYear(),
    String(d.getMonth()+1).padStart(2,"0"),
    String(d.getDate()).padStart(2,"0")
  ].join("") + "-" + [
    String(d.getHours()).padStart(2,"0"),
    String(d.getMinutes()).padStart(2,"0"),
    String(d.getSeconds()).padStart(2,"0")
  ].join("");
  return "WP-" + stamp + "-" + crypto.randomBytes(2).toString("hex").toUpperCase();
}

async function validatedItems(items) {
  if (!Array.isArray(items) || !items.length) throw new Error("Add at least one item.");
  const allowed = {
    Delivery: [25,35,45],
    "Pick-Up": [5,10,20,30,40],
    New: [200],
  };
  const usedRows = await pool.query("SELECT id, label, price FROM used_products WHERE active = TRUE");
  const usedMap = new Map(usedRows.rows.map(r => [String(r.id), { label:r.label, price:Number(r.price) }]));

  const clean = [];
  for (const raw of items) {
    const category = String(raw.category || "");
    const qty = Math.max(1, parseInt(raw.qty, 10) || 1);
    let price = Number(raw.unitPrice);
    let label = String(raw.label || "");

    if (category === "Used") {
      const product = usedMap.get(String(raw.productId || ""));
      if (!product) throw new Error("A Used item is no longer available.");
      price = product.price;
      label = product.label;
    } else {
      if (!allowed[category] || !allowed[category].includes(price)) {
        throw new Error("Invalid price for " + category + ".");
      }

      if (category === "Pick-Up" && (price === 5 || price === 10)) {
        const variant = String(raw.variant || "").trim();
        if (!["Tumbler","Bottled Water"].includes(variant)) {
          throw new Error("Choose Tumbler or Bottled Water for Pick-Up ₱" + price + ".");
        }
        label = variant + " · Pick-Up ₱" + price;
      } else {
        label = category === "New" ? "New Gallon" : category + " ₱" + price;
      }
    }

    clean.push({ category, label, unitPrice:price, qty, lineTotal:price * qty });
  }
  return clean;
}

app.get("/api/health", (req,res) => res.json({ ok:true }));

app.get("/api/used-products", async (req,res,next) => {
  try {
    const { rows } = await pool.query("SELECT id, label, price FROM used_products WHERE active=TRUE ORDER BY id");
    res.json(rows.map(r => ({...r, price:Number(r.price)})));
  } catch (e) { next(e); }
});

app.post("/api/sales", upload.single("receipt"), async (req,res,next) => {
  const client = await pool.connect();
  try {
    const paymentMethod = String(req.body.paymentMethod || "");
    const allowedOtherProviders = ["Maya","MariBank","GoTyme","VYBE by BPI"];
    if (!["Cash","GCash","Other","Pay Later"].includes(paymentMethod)) {
      return res.status(400).json({error:"Invalid payment method."});
    }

    const paymentProvider =
      paymentMethod === "GCash"
        ? "GCash"
        : paymentMethod === "Other"
          ? String(req.body.paymentProvider || "").trim()
          : null;

    if (paymentMethod === "Other" && !allowedOtherProviders.includes(paymentProvider)) {
      return res.status(400).json({error:"Choose Maya, MariBank, GoTyme, or VYBE by BPI."});
    }

    const items = await validatedItems(JSON.parse(req.body.items || "[]"));
    const total = items.reduce((sum,item)=>sum+item.lineTotal,0);
    const reference = txRef();
    const hasDelivery = items.some(item => item.category === "Delivery");
    const deliveryRoomUnit = hasDelivery
      ? String(req.body.roomUnit || "").trim().slice(0, 100)
      : null;

    if (hasDelivery && !deliveryRoomUnit) {
      return res.status(400).json({error:"Room / Unit is required for Delivery orders."});
    }

    const isDigital = paymentMethod !== "Cash" && paymentMethod !== "Pay Later";
    const submittedReference = isDigital
      ? normalizePaymentReference(req.body.paymentReference || req.body.gcashReference, paymentProvider)
      : null;
    const detectedReference = isDigital
      ? normalizePaymentReference(req.body.detectedReference || req.body.gcashDetectedReference, paymentProvider)
      : null;
    const ocrVerified = req.body.ocrVerified === "true" || req.body.gcashOcrVerified === "true";

    if (isDigital && !req.file) {
      return res.status(400).json({error: paymentProvider + " receipt image is required."});
    }
    if (isDigital && !String(req.file.mimetype || "").startsWith("image/")) {
      return res.status(400).json({error:"The payment receipt must be an image."});
    }

    // A digital payment may proceed without a readable OCR reference as long as the
    // receipt image is attached. These are explicitly marked for admin cross-checking.
    let paymentReference = null;
    let referenceStatus = isDigital ? "unreadable" : null;

    if (isDigital && ocrVerified && detectedReference) {
      if (!isValidPaymentReference(detectedReference, paymentProvider)) {
        return res.status(400).json({error:"The reference read from the image is not valid. Re-scan or save it as unreadable with the receipt attached."});
      }
      if (!isValidPaymentReference(submittedReference, paymentProvider)) {
        return res.status(400).json({error:"The corrected payment reference is incomplete or invalid."});
      }
      if (!isSingleDigitCorrection(detectedReference, submittedReference)) {
        return res.status(400).json({error:"The payment reference differs too much from what was read in the receipt. Re-scan or save the attached receipt for review."});
      }
      paymentReference = submittedReference;
      referenceStatus = "verified";
    }

    await client.query("BEGIN");
    const sale = await client.query(
      `INSERT INTO sales (
         transaction_ref,payment_method,payment_provider,payment_reference,payment_reference_status,
         gcash_reference,delivery_room_unit,total,receipt_mime,receipt_image,
         payment_status,was_pay_later,paid_at
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id, transaction_ref, created_at`,
      [
        reference,
        paymentMethod,
        paymentProvider,
        paymentReference,
        referenceStatus,
        paymentMethod === "GCash" ? paymentReference : null,
        deliveryRoomUnit,
        total,
        req.file?.mimetype || null,
        req.file?.buffer || null,
        paymentMethod === "Pay Later" ? "unpaid" : "paid",
        paymentMethod === "Pay Later",
        paymentMethod === "Pay Later" ? null : new Date()
      ]
    );

    for (const item of items) {
      await client.query(
        `INSERT INTO sale_items (sale_id,category,label,unit_price,qty,line_total)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [sale.rows[0].id,item.category,item.label,item.unitPrice,item.qty,item.lineTotal]
      );
    }

    await client.query("COMMIT");
    res.status(201).json({
      id:sale.rows[0].id,
      transactionRef:sale.rows[0].transaction_ref,
      total,
      createdAt:sale.rows[0].created_at
    });
  } catch(e) {
    await client.query("ROLLBACK").catch(()=>{});
    if (e instanceof SyntaxError || /Add at least|Invalid price|Used item/.test(e.message)) {
      return res.status(400).json({error:e.message});
    }
    next(e);
  } finally {
    client.release();
  }
});

app.post("/api/queue/account", async (req,res,next) => {
  try {
    const name=String(req.body.name || "").trim().slice(0,120);
    const phone=cleanPhone(req.body.phone);
    const unitNo=String(req.body.unitNo || "").trim().slice(0,80);

    if (name.length < 2) return res.status(400).json({error:"Enter your name."});
    if (phone.replace(/\D/g,"").length < 7) return res.status(400).json({error:"Enter a valid phone number."});
    if (!unitNo) return res.status(400).json({error:"Unit number is required."});

    const existing=await pool.query("SELECT id,unit_no FROM tenant_accounts WHERE phone=$1 LIMIT 1",[phone]);
    if (existing.rows.length && existing.rows[0].unit_no.trim().toLowerCase() !== unitNo.toLowerCase()) {
      return res.status(409).json({error:"This phone number is already registered to a different unit."});
    }

    const rawToken=crypto.randomBytes(32).toString("hex");
    const hash=tokenHash(rawToken);
    let row;

    if (existing.rows.length) {
      const result=await pool.query(
        `UPDATE tenant_accounts
         SET name=$1,unit_no=$2,access_token_hash=$3,updated_at=NOW()
         WHERE id=$4
         RETURNING id,name,phone,unit_no`,
        [name,unitNo,hash,existing.rows[0].id]
      );
      row=result.rows[0];
    } else {
      const result=await pool.query(
        `INSERT INTO tenant_accounts(name,phone,unit_no,access_token_hash)
         VALUES($1,$2,$3,$4)
         RETURNING id,name,phone,unit_no`,
        [name,phone,unitNo,hash]
      );
      row=result.rows[0];
    }

    res.status(existing.rows.length ? 200 : 201).json({token:rawToken,account:row});
  } catch(e){ next(e); }
});

app.get("/api/queue/me", tenantAuth, async (req,res) => {
  res.json(req.tenant);
});

app.get("/api/queue/requests", tenantAuth, async (req,res,next) => {
  try {
    const { rows }=await pool.query(
      `SELECT id,unit_no,unit_price,qty,total,payment_method,payment_provider,
              payment_reference,payment_reference_status,status,created_at,completed_at,
              (receipt_image IS NOT NULL) AS has_receipt
       FROM delivery_queue
       WHERE tenant_id=$1
       ORDER BY created_at DESC
       LIMIT 30`,
      [req.tenant.id]
    );
    res.json(rows.map(r=>({
      ...r,
      unit_price:Number(r.unit_price),
      total:Number(r.total),
      qty:Number(r.qty)
    })));
  } catch(e){ next(e); }
});

app.post("/api/queue/requests", tenantAuth, upload.single("receipt"), async (req,res,next) => {
  try {
    const unitPrice=Number(req.body.unitPrice);
    const qty=Math.max(1,Math.min(100,parseInt(req.body.qty,10)||1));
    if (![25,35,45].includes(unitPrice)) {
      return res.status(400).json({error:"Choose a valid Delivery price."});
    }

    const paymentMethod=String(req.body.paymentMethod || "");
    if (!["Cash","GCash","Other"].includes(paymentMethod)) {
      return res.status(400).json({error:"Choose Cash or an online payment."});
    }

    const allowedOtherProviders=["Maya","MariBank","GoTyme","VYBE by BPI"];
    const paymentProvider=
      paymentMethod==="GCash" ? "GCash" :
      paymentMethod==="Other" ? String(req.body.paymentProvider || "").trim() :
      null;

    if (paymentMethod==="Other" && !allowedOtherProviders.includes(paymentProvider)) {
      return res.status(400).json({error:"Choose Maya, MariBank, GoTyme, or VYBE by BPI."});
    }

    const isDigital=paymentMethod!=="Cash";
    if (isDigital && !req.file) {
      return res.status(400).json({error:paymentProvider+" receipt image is required."});
    }
    if (isDigital && !String(req.file.mimetype || "").startsWith("image/")) {
      return res.status(400).json({error:"The payment receipt must be an image."});
    }

    let paymentReference=null;
    let paymentReferenceStatus=isDigital ? "unreadable" : null;
    if (isDigital && String(req.body.ocrVerified)==="true") {
      const detected=normalizePaymentReference(req.body.detectedReference,paymentProvider);
      const submitted=normalizePaymentReference(req.body.paymentReference,paymentProvider);
      if (isValidPaymentReference(detected,paymentProvider) &&
          isValidPaymentReference(submitted,paymentProvider) &&
          isSingleDigitCorrection(detected,submitted)) {
        paymentReference=submitted;
        paymentReferenceStatus="verified";
      }
    }

    const total=unitPrice*qty;
    const { rows }=await pool.query(
      `INSERT INTO delivery_queue(
        tenant_id,unit_no,unit_price,qty,total,payment_method,payment_provider,
        payment_reference,payment_reference_status,receipt_mime,receipt_image
       )
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id,unit_no,unit_price,qty,total,payment_method,payment_provider,
                 payment_reference,payment_reference_status,status,created_at`,
      [
        req.tenant.id,req.tenant.unit_no,unitPrice,qty,total,paymentMethod,paymentProvider,
        paymentReference,paymentReferenceStatus,req.file?.mimetype||null,req.file?.buffer||null
      ]
    );

    const row=rows[0];
    res.status(201).json({
      ...row,
      unit_price:Number(row.unit_price),
      total:Number(row.total),
      qty:Number(row.qty)
    });
  } catch(e){ next(e); }
});

app.get("/api/pos/queue", async (req,res,next) => {
  try {
    const { rows }=await pool.query(
      `SELECT q.id,q.unit_no,q.unit_price,q.qty,q.total,q.payment_method,q.payment_provider,
              q.payment_reference,q.payment_reference_status,q.status,q.created_at,
              (q.receipt_image IS NOT NULL) AS has_receipt,
              t.name AS tenant_name,t.phone AS tenant_phone
       FROM delivery_queue q
       JOIN tenant_accounts t ON t.id=q.tenant_id
       WHERE q.status='requested'
       ORDER BY q.created_at ASC
       LIMIT 100`
    );
    res.json(rows.map(r=>({
      ...r,
      unit_price:Number(r.unit_price),
      total:Number(r.total),
      qty:Number(r.qty)
    })));
  } catch(e){ next(e); }
});

app.get("/api/pos/queue/:id/receipt", async (req,res,next) => {
  try {
    const { rows }=await pool.query(
      "SELECT receipt_mime,receipt_image FROM delivery_queue WHERE id=$1 LIMIT 1",
      [req.params.id]
    );
    if (!rows.length || !rows[0].receipt_image) return res.status(404).end();
    res.type(rows[0].receipt_mime || "image/jpeg").send(rows[0].receipt_image);
  } catch(e){ next(e); }
});

app.post("/api/pos/queue/:id/complete", async (req,res,next) => {
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    const queueResult=await client.query(
      `SELECT q.*,t.name AS tenant_name,t.phone AS tenant_phone
       FROM delivery_queue q
       JOIN tenant_accounts t ON t.id=q.tenant_id
       WHERE q.id=$1
       FOR UPDATE`,
      [req.params.id]
    );

    if (!queueResult.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({error:"Queue request not found."});
    }

    const q=queueResult.rows[0];
    if (q.status!=="requested") {
      await client.query("ROLLBACK");
      return res.status(409).json({error:"This request has already been processed."});
    }

    const reference=txRef();
    const sale=await client.query(
      `INSERT INTO sales(
        transaction_ref,payment_method,payment_provider,payment_reference,payment_reference_status,
        gcash_reference,delivery_room_unit,total,receipt_mime,receipt_image
       )
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id,transaction_ref,created_at`,
      [
        reference,q.payment_method,q.payment_provider,q.payment_reference,q.payment_reference_status,
        q.payment_method==="GCash" ? q.payment_reference : null,
        q.unit_no,q.total,q.receipt_mime,q.receipt_image
      ]
    );

    await client.query(
      `INSERT INTO sale_items(sale_id,category,label,unit_price,qty,line_total)
       VALUES($1,'Delivery',$2,$3,$4,$5)`,
      [sale.rows[0].id,"Delivery ₱"+Number(q.unit_price),q.unit_price,q.qty,q.total]
    );

    await client.query(
      `UPDATE delivery_queue
       SET status='completed',sale_id=$1,completed_at=NOW()
       WHERE id=$2`,
      [sale.rows[0].id,q.id]
    );

    await client.query("COMMIT");
    res.json({
      saleId:sale.rows[0].id,
      transactionRef:sale.rows[0].transaction_ref,
      total:Number(q.total)
    });
  } catch(e) {
    await client.query("ROLLBACK").catch(()=>{});
    next(e);
  } finally {
    client.release();
  }
});

app.get("/api/admin/setup-status", async (req,res,next) => {
  try {
    const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM admin_users");
    res.json({ needsSetup: rows[0].count === 0 });
  } catch (e) { next(e); }
});

app.post("/api/admin/setup", async (req,res,next) => {
  const client = await pool.connect();
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (!email.includes("@") || email.startsWith("@") || email.endsWith("@") || !email.slice(email.indexOf("@") + 1).includes(".")) return res.status(400).json({error:"Enter a valid email."});
    if (password.length < 10) return res.status(400).json({error:"Use at least 10 characters for the admin password."});

    await client.query("BEGIN");
    await client.query("LOCK TABLE admin_users IN EXCLUSIVE MODE");
    const count = await client.query("SELECT COUNT(*)::int AS count FROM admin_users");
    if (count.rows[0].count > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({error:"Admin setup is already complete."});
    }

    const secure = makePasswordHash(password);
    await client.query(
      "INSERT INTO admin_users(email,password_hash,salt) VALUES($1,$2,$3)",
      [email, secure.hash, secure.salt]
    );
    await client.query("COMMIT");
    const token = jwt.sign({ role:"admin", email }, JWT_SECRET, { expiresIn:"12h" });
    res.status(201).json({token,email});
  } catch(e) {
    await client.query("ROLLBACK").catch(()=>{});
    next(e);
  } finally { client.release(); }
});

app.post("/api/admin/login", async (req,res,next) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const { rows } = await pool.query(
      "SELECT email,password_hash,salt FROM admin_users WHERE email=$1 LIMIT 1",
      [email]
    );
    if (!rows.length || !verifyPassword(password, rows[0].salt, rows[0].password_hash)) {
      return res.status(401).json({error:"Invalid email or password."});
    }
    const token = jwt.sign({ role:"admin", email }, JWT_SECRET, { expiresIn:"12h" });
    res.json({token, email});
  } catch(e) { next(e); }
});

app.get("/api/admin/summary", adminAuth, async (req,res,next) => {
  try {
    const from = req.query.from || "2000-01-01";
    const to = req.query.to || "2999-12-31";
    const sales = await pool.query(
      `SELECT COUNT(*)::int AS transactions,
              COALESCE(SUM(total),0)::numeric AS sales,
              COALESCE(SUM(total) FILTER (WHERE payment_method='Cash'),0)::numeric AS cash,
              COALESCE(SUM(total) FILTER (WHERE payment_method='GCash'),0)::numeric AS gcash,
              COALESCE(SUM(total) FILTER (WHERE payment_method='Other'),0)::numeric AS other
       FROM sales
       WHERE (created_at AT TIME ZONE 'Asia/Manila')::date BETWEEN $1::date AND $2::date`, [from,to]);
    const expenses = await pool.query(
      `SELECT COALESCE(SUM(amount),0)::numeric AS expenses
       FROM expenses WHERE expense_date BETWEEN $1::date AND $2::date`, [from,to]);
    const s = sales.rows[0], ex = Number(expenses.rows[0].expenses);
    res.json({
      transactions:s.transactions,
      sales:Number(s.sales),
      cash:Number(s.cash),
      gcash:Number(s.gcash),
      other:Number(s.other),
      expenses:ex,
      net:Number(s.sales)-ex
    });
  } catch(e){ next(e); }
});

app.get("/api/admin/sales-trend", adminAuth, async (req,res,next) => {
  try {
    const localToday = await pool.query("SELECT to_char((NOW() AT TIME ZONE 'Asia/Manila')::date,'YYYY-MM-DD') AS day");
    const defaultDay = localToday.rows[0].day;
    const from = req.query.from || defaultDay;
    const to = req.query.to || defaultDay;

    const { rows } = await pool.query(`
      WITH days AS (
        SELECT generate_series($1::date, $2::date, interval '1 day')::date AS day
      ),
      daily AS (
        SELECT (created_at AT TIME ZONE 'Asia/Manila')::date AS day,
               COALESCE(SUM(total),0)::numeric AS sales,
               COALESCE(SUM(total) FILTER (WHERE payment_method='Cash'),0)::numeric AS cash,
               COALESCE(SUM(total) FILTER (WHERE payment_method='GCash'),0)::numeric AS gcash,
               COALESCE(SUM(total) FILTER (WHERE payment_method='Other'),0)::numeric AS other,
               COUNT(*)::int AS transactions
        FROM sales
        WHERE (created_at AT TIME ZONE 'Asia/Manila')::date BETWEEN $1::date AND $2::date
        GROUP BY (created_at AT TIME ZONE 'Asia/Manila')::date
      )
      SELECT to_char(days.day,'YYYY-MM-DD') AS date,
             COALESCE(daily.sales,0)::numeric AS sales,
             COALESCE(daily.cash,0)::numeric AS cash,
             COALESCE(daily.gcash,0)::numeric AS gcash,
             COALESCE(daily.other,0)::numeric AS other,
             COALESCE(daily.transactions,0)::int AS transactions
      FROM days
      LEFT JOIN daily ON daily.day = days.day
      ORDER BY days.day
    `, [from,to]);

    res.json(rows.map(r => ({
      date:r.date,
      sales:Number(r.sales),
      cash:Number(r.cash),
      gcash:Number(r.gcash),
      other:Number(r.other),
      transactions:Number(r.transactions)
    })));
  } catch(e){ next(e); }
});

app.get("/api/admin/sales", adminAuth, async (req,res,next) => {
  try {
    const from = req.query.from || "2000-01-01";
    const to = req.query.to || "2999-12-31";
    const { rows } = await pool.query(`
      SELECT s.id,s.transaction_ref,s.payment_method,
             COALESCE(s.payment_provider, CASE WHEN s.payment_method='GCash' THEN 'GCash' ELSE NULL END) AS payment_provider,
             COALESCE(s.payment_reference,s.gcash_reference) AS payment_reference,
             s.payment_reference_status,
             s.delivery_room_unit,
             s.total,s.created_at,
             (s.receipt_image IS NOT NULL) AS has_receipt,
             COALESCE(json_agg(json_build_object(
               'category',i.category,'label',i.label,'unitPrice',i.unit_price,'qty',i.qty,'lineTotal',i.line_total
             ) ORDER BY i.id) FILTER (WHERE i.id IS NOT NULL), '[]') AS items
      FROM sales s LEFT JOIN sale_items i ON i.sale_id=s.id
      WHERE (s.created_at AT TIME ZONE 'Asia/Manila')::date BETWEEN $1::date AND $2::date
      GROUP BY s.id ORDER BY s.created_at DESC LIMIT 500
    `, [from,to]);
    res.json(rows.map(r => ({...r,total:Number(r.total)})));
  } catch(e){ next(e); }
});

app.patch("/api/admin/sales/:saleId/reference", adminAuth, async (req,res,next) => {
  try {
    const saleId = Number(req.params.saleId);
    if (!Number.isInteger(saleId) || saleId <= 0) {
      return res.status(400).json({error:"Invalid sale."});
    }

    const existing = await pool.query(
      `SELECT id,payment_method,payment_reference_status,
              COALESCE(payment_provider, CASE WHEN payment_method='GCash' THEN 'GCash' ELSE NULL END) AS payment_provider
       FROM sales WHERE id=$1 LIMIT 1`,
      [saleId]
    );

    if (!existing.rows.length) return res.status(404).json({error:"Sale not found."});
    const sale = existing.rows[0];
    if (sale.payment_method === "Cash") {
      return res.status(400).json({error:"Cash transactions do not use a payment receipt reference."});
    }
    if (sale.payment_reference_status !== "unreadable") {
      return res.status(409).json({error:"Only unreadable receipts can be completed manually."});
    }

    const provider = sale.payment_provider || "";
    const reference = normalizePaymentReference(req.body.reference, provider);
    if (!isValidPaymentReference(reference, provider)) {
      return res.status(400).json({error:"Enter a valid payment reference before marking this receipt complete."});
    }

    const { rows } = await pool.query(
      `UPDATE sales
       SET payment_reference=$1,
           gcash_reference=CASE WHEN payment_method='GCash' THEN $1 ELSE gcash_reference END,
           payment_reference_status='manual'
       WHERE id=$2
       RETURNING id,payment_reference,payment_reference_status`,
      [reference,saleId]
    );

    res.json(rows[0]);
  } catch(e) { next(e); }
});

app.get("/api/admin/receipts/:saleId", adminAuth, async (req,res,next) => {
  try {
    const { rows } = await pool.query("SELECT receipt_mime,receipt_image FROM sales WHERE id=$1", [req.params.saleId]);
    if (!rows.length || !rows[0].receipt_image) return res.status(404).end();
    res.type(rows[0].receipt_mime || "image/jpeg").send(rows[0].receipt_image);
  } catch(e){ next(e); }
});

app.get("/api/admin/expenses", adminAuth, async (req,res,next) => {
  try {
    const { rows } = await pool.query("SELECT id,amount,category,note,expense_date,created_at FROM expenses ORDER BY expense_date DESC,id DESC LIMIT 300");
    res.json(rows.map(r => ({...r,amount:Number(r.amount)})));
  } catch(e){ next(e); }
});

app.post("/api/admin/expenses", adminAuth, async (req,res,next) => {
  try {
    const amount = Number(req.body.amount);
    const category = String(req.body.category || "").trim();
    const note = String(req.body.note || "").trim();
    const expenseDate = req.body.expenseDate || new Date().toISOString().slice(0,10);
    if (!(amount > 0) || !category) return res.status(400).json({error:"Amount and category are required."});
    const { rows } = await pool.query(
      "INSERT INTO expenses(amount,category,note,expense_date) VALUES($1,$2,$3,$4) RETURNING *",
      [amount,category,note,expenseDate]
    );
    res.status(201).json({...rows[0],amount:Number(rows[0].amount)});
  } catch(e){ next(e); }
});

app.delete("/api/admin/expenses/:id", adminAuth, async (req,res,next) => {
  try {
    await pool.query("DELETE FROM expenses WHERE id=$1",[req.params.id]);
    res.status(204).end();
  } catch(e){ next(e); }
});

app.get("/api/admin/used-products", adminAuth, async (req,res,next) => {
  try {
    const { rows } = await pool.query("SELECT id,label,price,active FROM used_products ORDER BY id DESC");
    res.json(rows.map(r=>({...r,price:Number(r.price)})));
  } catch(e){ next(e); }
});

app.post("/api/admin/used-products", adminAuth, async (req,res,next) => {
  try {
    const label=String(req.body.label||"").trim(), price=Number(req.body.price);
    if(!label || !(price>0)) return res.status(400).json({error:"Label and price are required."});
    const {rows}=await pool.query("INSERT INTO used_products(label,price) VALUES($1,$2) RETURNING *",[label,price]);
    res.status(201).json({...rows[0],price:Number(rows[0].price)});
  } catch(e){ next(e); }
});

app.patch("/api/admin/used-products/:id", adminAuth, async (req,res,next) => {
  try {
    const active = Boolean(req.body.active);
    const {rows}=await pool.query("UPDATE used_products SET active=$1 WHERE id=$2 RETURNING *",[active,req.params.id]);
    if(!rows.length) return res.status(404).json({error:"Product not found."});
    res.json({...rows[0],price:Number(rows[0].price)});
  } catch(e){ next(e); }
});

app.use((err,req,res,next)=>{
  console.error(err);
  res.status(500).json({error:"Something went wrong. Please try again."});
});

initDb()
  .then(()=>app.listen(PORT,()=>console.log("Water POS running on port",PORT)))
  .catch(err=>{ console.error("Database initialization failed",err); process.exit(1); });
