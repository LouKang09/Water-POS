const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const secret = process.env.JWT_SECRET || "development-only-change-me";
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

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

async function strictAdminGuard(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  try {
    const claims = jwt.verify(token, secret);
    if (claims.role !== "admin" || !claims.email) throw new Error("role");
    const result = await pool.query(
      "SELECT id,email,password_hash,salt FROM admin_users WHERE email=$1 LIMIT 1",
      [String(claims.email).toLowerCase()]
    );
    if (!result.rows.length) throw new Error("account");
    req.adminAccount = result.rows[0];
    req.admin = claims;
    next();
  } catch {
    res.status(401).json({ error: "Admin authentication required." });
  }
}

const baseGet = express.application.get;
const basePost = express.application.post;
const basePatch = express.application.patch;
const baseDelete = express.application.delete;
const originalListen = express.application.listen;
const publicAdminPaths = new Set([
  "/api/admin/setup-status",
  "/api/admin/setup",
  "/api/admin/login"
]);

function shouldGuard(path) {
  return typeof path === "string" && path.startsWith("/api/admin/") && !publicAdminPaths.has(path);
}

express.application.get = function(path, ...handlers) {
  if (shouldGuard(path)) handlers.unshift(strictAdminGuard);
  return baseGet.call(this, path, ...handlers);
};

express.application.post = function(path, ...handlers) {
  if (shouldGuard(path)) handlers.unshift(strictAdminGuard);
  return basePost.call(this, path, ...handlers);
};

express.application.patch = function(path, ...handlers) {
  if (shouldGuard(path)) handlers.unshift(strictAdminGuard);
  return basePatch.call(this, path, ...handlers);
};

express.application.delete = function(path, ...handlers) {
  if (shouldGuard(path)) handlers.unshift(strictAdminGuard);
  return baseDelete.call(this, path, ...handlers);
};

function validEmail(email) {
  return email.includes("@") && !email.startsWith("@") && !email.endsWith("@") && email.slice(email.indexOf("@") + 1).includes(".");
}

function addRoutes(app) {
  baseGet.call(app, "/api/admin/account", strictAdminGuard, async (req, res) => {
    res.json({ email: req.adminAccount.email });
  });

  basePatch.call(app, "/api/admin/account", strictAdminGuard, async (req, res) => {
    try {
      const currentPassword = String(req.body.currentPassword || "");
      const newEmail = String(req.body.email || req.adminAccount.email).trim().toLowerCase();
      const newPassword = String(req.body.newPassword || "");

      if (!verifyPassword(currentPassword, req.adminAccount.salt, req.adminAccount.password_hash)) {
        return res.status(401).json({ error: "Current password is incorrect." });
      }
      if (!validEmail(newEmail)) {
        return res.status(400).json({ error: "Enter a valid admin email." });
      }
      if (newPassword && newPassword.length < 10) {
        return res.status(400).json({ error: "Use at least 10 characters for the new admin password." });
      }

      const conflict = await pool.query(
        "SELECT id FROM admin_users WHERE email=$1 AND id<>$2 LIMIT 1",
        [newEmail, req.adminAccount.id]
      );
      if (conflict.rows.length) {
        return res.status(409).json({ error: "That email is already used by another admin account." });
      }

      let passwordHash = req.adminAccount.password_hash;
      let salt = req.adminAccount.salt;
      if (newPassword) {
        const secure = makePasswordHash(newPassword);
        passwordHash = secure.hash;
        salt = secure.salt;
      }

      const updated = await pool.query(
        `UPDATE admin_users
         SET email=$1,password_hash=$2,salt=$3
         WHERE id=$4
         RETURNING id,email`,
        [newEmail, passwordHash, salt, req.adminAccount.id]
      );

      const row = updated.rows[0];
      const token = jwt.sign({ role: "admin", email: row.email }, secret, { expiresIn: "12h" });
      res.json({ token, email: row.email, passwordChanged: Boolean(newPassword) });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Unable to update the admin account." });
    }
  });
}

express.application.listen = function(...args) {
  addRoutes(this);
  return originalListen.apply(this, args);
};
