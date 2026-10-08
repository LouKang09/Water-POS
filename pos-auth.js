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

function validEmail(email) {
  return email.includes("@") && !email.startsWith("@") && !email.endsWith("@") && email.slice(email.indexOf("@") + 1).includes(".");
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
const originalPatch = express.application.patch;
const originalListen = express.application.listen;

const guardedGet = new Set(["/api/pos/queue", "/api/pos/queue/:id/receipt", "/api/pos/unpaid"]);
const guardedPost = new Set(["/api/sales", "/api/pos/queue/:id/complete", "/api/pos/unpaid/:id/settle"]);

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
    if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid email." });
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

  originalGet.call(app, "/api/pos/me", posGuard, async (req, res) => {
    try {
      const result = await pool.query(
        "SELECT id,name,email FROM pos_users WHERE id=$1 AND active=TRUE LIMIT 1",
        [req.posUser.id]
      );
      if (!result.rows.length) return res.status(401).json({ error: "POS account is no longer active." });
      res.json(result.rows[0]);
    } catch {
      res.status(500).json({ error: "Unable to load POS account." });
    }
  });

  originalPatch.call(app, "/api/pos/account", posGuard, async (req, res) => {
    try {
      const existing = await pool.query(
        "SELECT id,name,email,password_hash,salt,active FROM pos_users WHERE id=$1 AND active=TRUE LIMIT 1",
        [req.posUser.id]
      );
      if (!existing.rows.length) return res.status(404).json({ error: "POS account not found." });

      const row = existing.rows[0];
      const currentPassword = String(req.body.currentPassword || "");
      const email = String(req.body.email || row.email).trim().toLowerCase();
      const newPassword = String(req.body.newPassword || "");

      if (!passwordMatches(currentPassword, row.salt, row.password_hash)) {
        return res.status(400).json({ error: "Current password is incorrect." });
      }
      if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid email." });
      if (newPassword && newPassword.length < 8) {
        return res.status(400).json({ error: "Use at least 8 characters for the new password." });
      }

      const conflict = await pool.query(
        "SELECT id FROM pos_users WHERE email=$1 AND id<>$2 LIMIT 1",
        [email, row.id]
      );
      if (conflict.rows.length) return res.status(409).json({ error: "That email is already used by another POS user." });

      let passwordHash = row.password_hash;
      let salt = row.salt;
      if (newPassword) {
        const secure = passwordData(newPassword);
        passwordHash = secure.hash;
        salt = secure.salt;
      }

      const updated = await pool.query(
        `UPDATE pos_users
         SET email=$1,password_hash=$2,salt=$3
         WHERE id=$4
         RETURNING id,name,email`,
        [email, passwordHash, salt, row.id]
      );
      const user = updated.rows[0];
      const token = jwt.sign({ role: "pos", id: user.id, name: user.name, email: user.email }, secret, { expiresIn: "12h" });
      res.json({ token, user, passwordChanged: Boolean(newPassword) });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Unable to update the POS account." });
    }
  });
}

express.application.listen = function(...args) {
  const app = this;
  return ensureTable().then(() => {
    addRoutes(app);
    return originalListen.apply(app, args);
  });
};
