const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const secret = process.env.JWT_SECRET || "development-only-change-me";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

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

function posGuard(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  try {
    const user = jwt.verify(token, secret);
    if (user.role !== "pos") throw new Error("role");
    req.posUser = user;
    next();
  } catch {
    res.status(401).json({ error: "POS login required." });
  }
}

const originalGet = express.application.get;
const originalPost = express.application.post;
const originalListen = express.application.listen;

const guardedGet = new Set(["/api/pos/queue", "/api/pos/queue/:id/receipt"]);
const guardedPost = new Set(["/api/sales", "/api/pos/queue/:id/complete"]);

express.application.get = function(path, ...handlers) {
  if (guardedGet.has(path)) handlers.unshift(posGuard);
  return originalGet.call(this, path, ...handlers);
};

express.application.post = function(path, ...handlers) {
  if (guardedPost.has(path)) handlers.unshift(posGuard);
  return originalPost.call(this, path, ...handlers);
};

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pos_users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_login_at TIMESTAMPTZ
    );
  `);
}

function addRoutes(app) {
  originalGet.call(app, "/api/pos/setup-status", async (req, res) => {
    const result = await pool.query("SELECT COUNT(*)::int AS count FROM pos_users WHERE active=TRUE");
    res.json({ needsSetup: result.rows[0].count === 0 });
  });

  originalPost.call(app, "/api/pos/setup", async (req, res) => {
    const name = String(req.body.name || "").trim().slice(0, 120);
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (name.length < 2) return res.status(400).json({ error: "Enter the POS user's name." });
    if (!email.includes("@") || !email.slice(email.indexOf("@") + 1).includes(".")) return res.status(400).json({ error: "Enter a valid email." });
    if (password.length < 8) return res.status(400).json({ error: "Use at least 8 characters for the POS password." });
    const count = await pool.query("SELECT COUNT(*)::int AS count FROM pos_users WHERE active=TRUE");
    if (count.rows[0].count > 0) return res.status(409).json({ error: "POS setup is already complete." });
    const secure = passwordData(password);
    const created = await pool.query(
      "INSERT INTO pos_users(name,email,password_hash,salt,last_login_at) VALUES($1,$2,$3,$4,NOW()) RETURNING id,name,email",
      [name, email, secure.hash, secure.salt]
    );
    const user = created.rows[0];
    const token = jwt.sign({ role: "pos", id: user.id, name: user.name, email: user.email }, secret, { expiresIn: "12h" });
    res.status(201).json({ token, user });
  });

  originalPost.call(app, "/api/pos/login", async (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const result = await pool.query("SELECT id,name,email,password_hash,salt FROM pos_users WHERE email=$1 AND active=TRUE LIMIT 1", [email]);
    if (!result.rows.length || !passwordMatches(password, result.rows[0].salt, result.rows[0].password_hash)) {
      return res.status(401).json({ error: "Invalid POS email or password." });
    }
    const row = result.rows[0];
    await pool.query("UPDATE pos_users SET last_login_at=NOW() WHERE id=$1", [row.id]);
    const token = jwt.sign({ role: "pos", id: row.id, name: row.name, email: row.email }, secret, { expiresIn: "12h" });
    res.json({ token, user: { id: row.id, name: row.name, email: row.email } });
  });

  originalGet.call(app, "/api/pos/me", posGuard, (req, res) => {
    res.json({ id: req.posUser.id, name: req.posUser.name, email: req.posUser.email });
  });
}

express.application.listen = function(...args) {
  const app = this;
  return ensureTable().then(() => {
    addRoutes(app);
    return originalListen.apply(app, args);
  });
};
