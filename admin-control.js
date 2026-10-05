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

function manualReference(dateTime) {
  const compact = String(dateTime || "")
    .replace(/[^0-9]/g, "")
    .slice(0, 14)
    .padEnd(14, "0");
  return "MAN-" + compact + "-" + crypto.randomBytes(2).toString("hex").toUpperCase();
}

function cleanManualReference(value, provider) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return null;
  const cleaned = raw
    .split("")
    .filter(ch => (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "-")
    .join("")
    .slice(0, 60);
  return provider === "GCash" ? cleaned.replace(/\D/g, "").slice(0, 18) : cleaned;
}

function normalizeManualItems(value) {
  if (!Array.isArray(value) || value.length < 1) throw new Error("Add at least one transaction item.");
  if (value.length > 30) throw new Error("A manual transaction can contain up to 30 item rows.");
  const allowedCategories = new Set(["Delivery", "Pick-Up", "New", "Used"]);
  return value.map((raw, index) => {
    const category = String(raw.category || "").trim();
    const price = Number(raw.unitPrice);
    const qty = Number.parseInt(raw.qty, 10);
    let label = String(raw.label || "").trim().slice(0, 120);
    if (!allowedCategories.has(category)) throw new Error("Choose a valid category for item " + (index + 1) + ".");
    if (!(price > 0) || price > 100000) throw new Error("Enter a valid price for item " + (index + 1) + ".");
    if (!Number.isInteger(qty) || qty < 1 || qty > 500) throw new Error("Enter a valid quantity for item " + (index + 1) + ".");
    if (!label) label = category === "New" ? "New Gallon" : category + " ₱" + price;
    return { category, label, unitPrice: price, qty, lineTotal: price * qty };
  });
}

function parseManualDateTime(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) return null;
  const instant = new Date(text + ":00+08:00");
  if (!Number.isFinite(instant.getTime())) return null;
  return { text, instant };
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
        return res.status(400).json({ error: "Current password is incorrect." });
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

  baseGet.call(app, "/api/admin/pos-users", strictAdminGuard, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id,name,email,active,created_at,last_login_at
         FROM pos_users
         ORDER BY id ASC`
      );
      res.json(rows);
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Unable to load POS users." });
    }
  });

  basePatch.call(app, "/api/admin/pos-users/:id", strictAdminGuard, async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid POS user." });

      const existing = await pool.query(
        "SELECT id,name,email,password_hash,salt,active FROM pos_users WHERE id=$1 LIMIT 1",
        [id]
      );
      if (!existing.rows.length) return res.status(404).json({ error: "POS user not found." });

      const current = existing.rows[0];
      const name = String(req.body.name || current.name).trim().slice(0, 120);
      const email = String(req.body.email || current.email).trim().toLowerCase();
      const newPassword = String(req.body.newPassword || "");

      if (name.length < 2) return res.status(400).json({ error: "Enter the POS user's name." });
      if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid POS user email." });
      if (newPassword && newPassword.length < 8) {
        return res.status(400).json({ error: "Use at least 8 characters for the new POS password." });
      }

      const conflict = await pool.query(
        "SELECT id FROM pos_users WHERE email=$1 AND id<>$2 LIMIT 1",
        [email, id]
      );
      if (conflict.rows.length) return res.status(409).json({ error: "That POS email is already in use." });

      let passwordHash = current.password_hash;
      let salt = current.salt;
      if (newPassword) {
        const secure = makePasswordHash(newPassword);
        passwordHash = secure.hash;
        salt = secure.salt;
      }

      const { rows } = await pool.query(
        `UPDATE pos_users
         SET name=$1,email=$2,password_hash=$3,salt=$4
         WHERE id=$5
         RETURNING id,name,email,active,created_at,last_login_at`,
        [name, email, passwordHash, salt, id]
      );
      res.json({ ...rows[0], passwordChanged: Boolean(newPassword) });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Unable to update the POS user." });
    }
  });

  basePost.call(app, "/api/admin/manual-sales", strictAdminGuard, async (req, res) => {
    const client = await pool.connect();
    try {
      const parsedDate = parseManualDateTime(req.body.dateTime);
      if (!parsedDate) return res.status(400).json({ error: "Choose a valid transaction date and time." });
      if (parsedDate.instant.getTime() > Date.now() + 5 * 60 * 1000) {
        return res.status(400).json({ error: "Manual transactions cannot be dated in the future." });
      }

      const items = normalizeManualItems(req.body.items);
      const total = items.reduce((sum, item) => sum + item.lineTotal, 0);
      const paymentMethod = String(req.body.paymentMethod || "Cash");
      if (!["Cash", "GCash", "Other"].includes(paymentMethod)) {
        return res.status(400).json({ error: "Choose a valid payment method." });
      }

      const allowedOtherProviders = ["Maya", "MariBank", "GoTyme", "VYBE by BPI"];
      const paymentProvider = paymentMethod === "GCash"
        ? "GCash"
        : paymentMethod === "Other"
          ? String(req.body.paymentProvider || "").trim()
          : null;
      if (paymentMethod === "Other" && !allowedOtherProviders.includes(paymentProvider)) {
        return res.status(400).json({ error: "Choose the payment provider for this historical transaction." });
      }

      const paymentReference = paymentMethod === "Cash"
        ? null
        : cleanManualReference(req.body.paymentReference, paymentProvider);
      const referenceStatus = paymentMethod === "Cash" ? null : "manual";
      const roomUnit = String(req.body.roomUnit || "").trim().slice(0, 100) || null;
      const reference = manualReference(parsedDate.text);

      await client.query("BEGIN");
      const created = await client.query(
        `INSERT INTO sales(
          transaction_ref,payment_method,payment_provider,payment_reference,payment_reference_status,
          gcash_reference,delivery_room_unit,total,receipt_mime,receipt_image,created_at
         )
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL,NULL,$9::timestamptz)
         RETURNING id,transaction_ref,total,created_at`,
        [
          reference,
          paymentMethod,
          paymentProvider,
          paymentReference,
          referenceStatus,
          paymentMethod === "GCash" ? paymentReference : null,
          roomUnit,
          total,
          parsedDate.text + ":00+08:00"
        ]
      );

      for (const item of items) {
        await client.query(
          `INSERT INTO sale_items(sale_id,category,label,unit_price,qty,line_total)
           VALUES($1,$2,$3,$4,$5,$6)`,
          [created.rows[0].id, item.category, item.label, item.unitPrice, item.qty, item.lineTotal]
        );
      }
      await client.query("COMMIT");
      res.status(201).json({
        ...created.rows[0],
        total: Number(created.rows[0].total),
        itemCount: items.length
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (/Add at least|item row|valid category|valid price|valid quantity/.test(error.message)) {
        return res.status(400).json({ error: error.message });
      }
      console.error(error);
      res.status(500).json({ error: "Unable to save the manual transaction." });
    } finally {
      client.release();
    }
  });
}

express.application.listen = function(...args) {
  addRoutes(this);
  return originalListen.apply(this, args);
};
