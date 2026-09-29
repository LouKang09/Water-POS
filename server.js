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
app.use(express.static(path.join(__dirname, "public")));

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
      payment_method TEXT NOT NULL CHECK (payment_method IN ('Cash','GCash')),
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
    "Pick-Up": [20,30,40],
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
      label = category === "New" ? "New Gallon" : category + " ₱" + price;
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
    const paymentMethod = req.body.paymentMethod;
    if (!["Cash","GCash"].includes(paymentMethod)) return res.status(400).json({error:"Invalid payment method."});
    const items = await validatedItems(JSON.parse(req.body.items || "[]"));
    const total = items.reduce((s,i)=>s+i.lineTotal,0);
    const reference = txRef();
    const gcashReference = paymentMethod === "GCash" ? String(req.body.gcashReference || "").trim() : null;

    if (paymentMethod === "GCash" && !req.file) return res.status(400).json({error:"GCash receipt image is required."});
    if (paymentMethod === "GCash" && !gcashReference) return res.status(400).json({error:"GCash reference is required."});

    await client.query("BEGIN");
    const sale = await client.query(
      `INSERT INTO sales (transaction_ref,payment_method,gcash_reference,total,receipt_mime,receipt_image)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, transaction_ref, created_at`,
      [reference,paymentMethod,gcashReference,total,req.file?.mimetype || null,req.file?.buffer || null]
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
  } finally { client.release(); }
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
    if (!/^\\S+@\\S+\\.\\S+$/.test(email)) return res.status(400).json({error:"Enter a valid email."});
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
              COALESCE(SUM(total) FILTER (WHERE payment_method='GCash'),0)::numeric AS gcash
       FROM sales WHERE created_at::date BETWEEN $1::date AND $2::date`, [from,to]);
    const expenses = await pool.query(
      `SELECT COALESCE(SUM(amount),0)::numeric AS expenses
       FROM expenses WHERE expense_date BETWEEN $1::date AND $2::date`, [from,to]);
    const s = sales.rows[0], ex = Number(expenses.rows[0].expenses);
    res.json({
      transactions:s.transactions,
      sales:Number(s.sales),
      cash:Number(s.cash),
      gcash:Number(s.gcash),
      expenses:ex,
      net:Number(s.sales)-ex
    });
  } catch(e){ next(e); }
});

app.get("/api/admin/sales", adminAuth, async (req,res,next) => {
  try {
    const { rows } = await pool.query(`
      SELECT s.id,s.transaction_ref,s.payment_method,s.gcash_reference,s.total,s.created_at,
             (s.receipt_image IS NOT NULL) AS has_receipt,
             COALESCE(json_agg(json_build_object(
               'category',i.category,'label',i.label,'unitPrice',i.unit_price,'qty',i.qty,'lineTotal',i.line_total
             ) ORDER BY i.id) FILTER (WHERE i.id IS NOT NULL), '[]') AS items
      FROM sales s LEFT JOIN sale_items i ON i.sale_id=s.id
      GROUP BY s.id ORDER BY s.created_at DESC LIMIT 200
    `);
    res.json(rows.map(r => ({...r,total:Number(r.total)})));
  } catch(e){ next(e); }
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
