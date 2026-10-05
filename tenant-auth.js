const crypto = require("crypto");
const express = require("express");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

function cleanPhone(value) {
  return String(value || "").replace(/[^0-9+]/g, "").slice(0, 20);
}

function tokenHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function passwordData(value, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(value, salt, 64).toString("hex") };
}

function passwordMatches(value, salt, hash) {
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(value, salt, 64).toString("hex");
  const a = Buffer.from(test);
  const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function signupHandler(req, res) {
  try {
    const name = String(req.body.name || "").trim().slice(0, 120);
    const phone = cleanPhone(req.body.phone);
    const unitNo = String(req.body.unitNo || "").trim().slice(0, 80);
    const password = String(req.body.password || "");
    if (name.length < 2) return res.status(400).json({ error: "Enter your name." });
    if (phone.replace(/\D/g, "").length < 7) return res.status(400).json({ error: "Enter a valid phone number." });
    if (!unitNo) return res.status(400).json({ error: "Unit number is required." });
    if (password.length < 6) return res.status(400).json({ error: "Use at least 6 characters for your password." });

    const existing = await pool.query("SELECT id,password_hash FROM tenant_accounts WHERE phone=$1 LIMIT 1", [phone]);
    if (existing.rows.length) {
      if (existing.rows[0].password_hash) {
        return res.status(409).json({ code: "ACCOUNT_EXISTS", error: "This phone number already has an account. Use Existing User Login." });
      }
      return res.status(409).json({ code: "LEGACY_ACCOUNT", error: "This is an older preview account. Verify it once below to set a password." });
    }

    const secure = passwordData(password);
    const rawToken = crypto.randomBytes(32).toString("hex");
    const result = await pool.query(
      `INSERT INTO tenant_accounts(name,phone,unit_no,access_token_hash,password_hash,password_salt)
       VALUES($1,$2,$3,$4,$5,$6)
       RETURNING id,name,phone,unit_no`,
      [name, phone, unitNo, tokenHash(rawToken), secure.hash, secure.salt]
    );
    res.status(201).json({ token: rawToken, account: result.rows[0] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Unable to create your account." });
  }
}

async function loginHandler(req, res) {
  try {
    const phone = cleanPhone(req.body.phone);
    const password = String(req.body.password || "");
    const result = await pool.query(
      "SELECT id,name,phone,unit_no,password_hash,password_salt FROM tenant_accounts WHERE phone=$1 LIMIT 1",
      [phone]
    );
    if (!result.rows.length) return res.status(401).json({ error: "Invalid phone number or password." });
    const row = result.rows[0];
    if (!row.password_hash) {
      return res.status(409).json({ code: "LEGACY_SETUP", error: "This is an older preview account. Verify it once to set a password." });
    }
    if (!passwordMatches(password, row.password_salt, row.password_hash)) {
      return res.status(401).json({ error: "Invalid phone number or password." });
    }
    const rawToken = crypto.randomBytes(32).toString("hex");
    await pool.query("UPDATE tenant_accounts SET access_token_hash=$1,updated_at=NOW() WHERE id=$2", [tokenHash(rawToken), row.id]);
    res.json({ token: rawToken, account: { id: row.id, name: row.name, phone: row.phone, unit_no: row.unit_no } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Unable to log in." });
  }
}

async function claimHandler(req, res) {
  try {
    const phone = cleanPhone(req.body.phone);
    const unitNo = String(req.body.unitNo || "").trim();
    const password = String(req.body.password || "");
    if (!unitNo) return res.status(400).json({ error: "Unit number is required." });
    if (password.length < 6) return res.status(400).json({ error: "Use at least 6 characters for your password." });

    const result = await pool.query("SELECT id,name,phone,unit_no,password_hash FROM tenant_accounts WHERE phone=$1 LIMIT 1", [phone]);
    if (!result.rows.length || result.rows[0].unit_no.trim().toLowerCase() !== unitNo.toLowerCase()) {
      return res.status(401).json({ error: "Phone number and unit do not match an existing account." });
    }
    const row = result.rows[0];
    if (row.password_hash) return res.status(409).json({ error: "This account already has a password. Use Existing User Login." });

    const secure = passwordData(password);
    const rawToken = crypto.randomBytes(32).toString("hex");
    await pool.query(
      "UPDATE tenant_accounts SET password_hash=$1,password_salt=$2,access_token_hash=$3,updated_at=NOW() WHERE id=$4",
      [secure.hash, secure.salt, tokenHash(rawToken), row.id]
    );
    res.json({ token: rawToken, account: { id: row.id, name: row.name, phone: row.phone, unit_no: row.unit_no } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Unable to claim the existing account." });
  }
}

const originalPost = express.application.post;
const originalListen = express.application.listen;

express.application.post = function(path, ...handlers) {
  if (path === "/api/queue/account") {
    return originalPost.call(this, path, signupHandler);
  }
  return originalPost.call(this, path, ...handlers);
};

async function ensureColumns() {
  await pool.query(`
    ALTER TABLE tenant_accounts ADD COLUMN IF NOT EXISTS password_hash TEXT;
    ALTER TABLE tenant_accounts ADD COLUMN IF NOT EXISTS password_salt TEXT;
  `);
}

function addRoutes(app) {
  originalPost.call(app, "/api/queue/signup", signupHandler);
  originalPost.call(app, "/api/queue/login", loginHandler);
  originalPost.call(app, "/api/queue/claim", claimHandler);
}

express.application.listen = function(...args) {
  const app = this;
  return ensureColumns().then(() => {
    addRoutes(app);
    return originalListen.apply(app, args);
  });
};
