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

function resetCodeHash(userId, code) {
  return crypto.createHmac("sha256", secret).update(String(userId) + ":" + String(code)).digest("hex");
}

function safeHashEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// Password reset emails use Resend's HTTPS API (no outbound SMTP required).
// For initial testing, onboarding@resend.dev can only send to the Resend account owner's email.
// Set RESEND_FROM_EMAIL to an address on a verified domain for production.
async function sendPasswordOtp(email, name, code) {
  const apiKey = String(process.env.RESEND_API_KEY || "").trim();
  if (!apiKey) {
    const error = new Error("Resend API key is not configured (RESEND_API_KEY).");
    error.code = "MAIL_NOT_CONFIGURED";
    throw error;
  }

  const from = String(process.env.RESEND_FROM_EMAIL || "INYOU Water POS <onboarding@resend.dev>").trim();
  const plainName = String(name || "POS User");
  const safeName = plainName.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      signal: controller.signal,
      body: JSON.stringify({
        from,
        to: [email],
        subject: "INYOU Water POS password reset code",
        text: `Hello ${plainName},\n\nYour INYOU Water POS password reset code is ${code}.\n\nThis code expires in 10 minutes. If you did not request this, you can ignore this email.\n\nINYOU Water Supply Co.`,
        html: `<div style="font-family:Arial,sans-serif;color:#123;max-width:520px;margin:auto">
          <h2 style="color:#0874b8">INYOU Water POS</h2>
          <p>Hello ${safeName},</p>
          <p>Your password reset code is:</p>
          <div style="font-size:32px;font-weight:800;letter-spacing:8px;padding:18px 20px;background:#eef8fd;border-radius:14px;text-align:center;color:#075f98">${code}</div>
          <p style="margin-top:18px">This code expires in <strong>10 minutes</strong>.</p>
          <p>If you did not request this, you can ignore this email.</p>
          <p style="color:#688">INYOU Water Supply Co.</p>
        </div>`
      })
    });

    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.id) {
      const reason = String(result.message || result.name || "No details").slice(0, 250);
      const error = new Error(`Resend API error (${response.status}): ${reason}`);
      error.code = "RESEND_DELIVERY_FAILED";
      throw error;
    }
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("Resend API connection timed out after 10 seconds.");
      timeoutError.code = "RESEND_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function createPosSession(user) {
  // No automatic expiration: only a manual logout, password reset/change,
  // or admin account revocation invalidates the locally persisted session.
  const token = "wps_" + crypto.randomBytes(32).toString("hex");
  await pool.query(
    "INSERT INTO pos_sessions(user_id,token_hash,auth_version) VALUES($1,$2,$3)",
    [user.id, tokenHash(token), Number(user.auth_version || user.authVersion || 1)]
  );
  return token;
}

function tokenHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

async function posGuard(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  try {
    if (token.startsWith("wps_")) {
      const result = await pool.query(
        `SELECT u.id,u.name,u.email,u.active,u.auth_version,s.auth_version AS session_auth_version
         FROM pos_sessions s JOIN pos_users u ON u.id=s.user_id
         WHERE s.token_hash=$1 AND s.revoked_at IS NULL LIMIT 1`,
        [tokenHash(token)]
      );
      const row=result.rows[0];
      if (!row || !row.active || Number(row.auth_version)!==Number(row.session_auth_version)) throw new Error("revoked");
      req.posUser={role:"pos",id:row.id,name:row.name,email:row.email,authVersion:Number(row.auth_version)};
      req.posSessionToken=token;
    } else {
      // Legacy 12-hour JWTs remain valid until they expire. Existing installed
      // clients can migrate to a permanent session via /api/pos/me.
      const user = jwt.verify(token, secret);
      if (user.role !== "pos" || !user.id) throw new Error("role");
      const result = await pool.query("SELECT active,auth_version FROM pos_users WHERE id=$1 LIMIT 1",[user.id]);
      if (!result.rows.length || !result.rows[0].active) throw new Error("inactive");
      const currentVersion = Number(result.rows[0].auth_version || 1);
      if (Number(user.authVersion || 1) !== currentVersion) throw new Error("revoked");
      req.posUser = { ...user, authVersion: currentVersion };
      req.posLegacySession=true;
    }
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
const guardedPost = new Set(["/api/sales", "/api/pos/queue/:id/complete", "/api/pos/unpaid/:id/settle", "/api/pos/unpaid/:id/cancel"]);

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
      last_login_at TIMESTAMPTZ,
      auth_version INTEGER NOT NULL DEFAULT 1
    );

    ALTER TABLE pos_users ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 1;

    CREATE TABLE IF NOT EXISTS pos_sessions (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES pos_users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      auth_version INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_pos_sessions_active_user ON pos_sessions(user_id) WHERE revoked_at IS NULL;

    CREATE TABLE IF NOT EXISTS pos_password_reset_codes (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES pos_users(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_pos_password_reset_user_created
      ON pos_password_reset_codes(user_id, created_at DESC);
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
    const token = await createPosSession({ ...user,auth_version:1 });
    res.status(201).json({ token, user });
  });

  originalPost.call(app, "/api/pos/login", async (req, res) => {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const result = await pool.query("SELECT id,name,email,password_hash,salt,auth_version FROM pos_users WHERE email=$1 AND active=TRUE LIMIT 1", [email]);
    if (!result.rows.length || !passwordMatches(password, result.rows[0].salt, result.rows[0].password_hash)) {
      return res.status(401).json({ error: "Invalid POS email or password." });
    }
    const row = result.rows[0];
    await pool.query("UPDATE pos_users SET last_login_at=NOW() WHERE id=$1", [row.id]);
    const token = await createPosSession(row);
    res.json({ token, user: { id: row.id, name: row.name, email: row.email } });
  });

  originalPost.call(app, "/api/pos/forgot-password/request", async (req, res) => {
    try {
      const email = String(req.body.email || "").trim().toLowerCase();
      if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid registered email." });

      const result = await pool.query(
        "SELECT id,name,email FROM pos_users WHERE email=$1 AND active=TRUE LIMIT 1",
        [email]
      );

      // Do not reveal whether an account exists.
      if (!result.rows.length) {
        return res.json({ ok: true, message: "If that email is registered, a reset code has been sent." });
      }

      const user = result.rows[0];
      const recent = await pool.query(
        `SELECT created_at
         FROM pos_password_reset_codes
         WHERE user_id=$1 AND created_at > NOW() - INTERVAL '60 seconds'
         ORDER BY created_at DESC LIMIT 1`,
        [user.id]
      );
      if (recent.rows.length) {
        return res.status(429).json({ error: "Please wait 60 seconds before requesting another code." });
      }

      const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
      const codeHash = resetCodeHash(user.id, code);

      await pool.query(
        "UPDATE pos_password_reset_codes SET consumed_at=NOW() WHERE user_id=$1 AND consumed_at IS NULL",
        [user.id]
      );
      const created = await pool.query(
        `INSERT INTO pos_password_reset_codes(user_id,code_hash,expires_at)
         VALUES($1,$2,NOW() + INTERVAL '10 minutes')
         RETURNING id`,
        [user.id, codeHash]
      );

      try {
        await sendPasswordOtp(user.email, user.name, code);
      } catch (mailError) {
        await pool.query("DELETE FROM pos_password_reset_codes WHERE id=$1", [created.rows[0].id]);
        console.error("POS reset OTP email failed:", mailError.message);
        return res.status(503).json({ error: mailError.code === "MAIL_NOT_CONFIGURED" ? "Email OTP setup is incomplete. Ask the administrator to configure Resend." : "Unable to send OTP email. Please try again or contact the administrator." });
      }

      res.json({ ok: true, expiresMinutes: 10, message: "A 6-digit OTP was sent to your registered email." });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Unable to send a password reset code." });
    }
  });

  originalPost.call(app, "/api/pos/forgot-password/reset", async (req, res) => {
    const client = await pool.connect();
    try {
      const email = String(req.body.email || "").trim().toLowerCase();
      const code = String(req.body.code || "").replace(/\D/g, "").slice(0, 6);
      const newPassword = String(req.body.newPassword || "");

      if (!validEmail(email)) return res.status(400).json({ error: "Enter a valid registered email." });
      if (code.length !== 6) return res.status(400).json({ error: "Enter the 6-digit OTP." });
      if (newPassword.length < 8) return res.status(400).json({ error: "Use at least 8 characters for the new password." });

      await client.query("BEGIN");
      const userResult = await client.query(
        "SELECT id,name,email,auth_version FROM pos_users WHERE email=$1 AND active=TRUE LIMIT 1 FOR UPDATE",
        [email]
      );
      if (!userResult.rows.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "The OTP is invalid or expired." });
      }

      const user = userResult.rows[0];
      const codeResult = await client.query(
        `SELECT id,code_hash,attempts
         FROM pos_password_reset_codes
         WHERE user_id=$1 AND consumed_at IS NULL AND expires_at > NOW()
         ORDER BY created_at DESC LIMIT 1
         FOR UPDATE`,
        [user.id]
      );
      if (!codeResult.rows.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "The OTP is invalid or expired. Request a new code." });
      }

      const reset = codeResult.rows[0];
      if (Number(reset.attempts || 0) >= 5) {
        await client.query(
          "UPDATE pos_password_reset_codes SET consumed_at=NOW() WHERE id=$1",
          [reset.id]
        );
        await client.query("COMMIT");
        return res.status(400).json({ error: "Too many incorrect attempts. Request a new OTP." });
      }

      const matches = safeHashEqual(resetCodeHash(user.id, code), reset.code_hash);
      if (!matches) {
        await client.query(
          "UPDATE pos_password_reset_codes SET attempts=attempts+1 WHERE id=$1",
          [reset.id]
        );
        await client.query("COMMIT");
        return res.status(400).json({ error: "The OTP is invalid or expired." });
      }

      const secure = passwordData(newPassword);
      const nextVersion = Number(user.auth_version || 1) + 1;
      await client.query(
        `UPDATE pos_users
         SET password_hash=$1,salt=$2,auth_version=$3
         WHERE id=$4`,
        [secure.hash, secure.salt, nextVersion, user.id]
      );
      await client.query(
        "UPDATE pos_password_reset_codes SET consumed_at=NOW() WHERE user_id=$1 AND consumed_at IS NULL",
        [user.id]
      );
      await client.query("COMMIT");
      res.json({ ok: true, message: "Password updated. You can now sign in with your new password." });
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      console.error(error);
      res.status(500).json({ error: "Unable to reset the POS password." });
    } finally {
      client.release();
    }
  });

  originalGet.call(app, "/api/pos/me", posGuard, async (req, res) => {
    try {
      const result = await pool.query(
        "SELECT id,name,email,auth_version FROM pos_users WHERE id=$1 AND active=TRUE LIMIT 1",
        [req.posUser.id]
      );
      if (!result.rows.length) return res.status(401).json({ error: "POS account is no longer active." });
      const row=result.rows[0];
      const response={id:row.id,name:row.name,email:row.email};
      // Upgrade unexpired legacy sessions so current installed apps can retain login.
      if(req.posLegacySession)response.sessionToken=await createPosSession(row);
      res.json(response);
    } catch {
      res.status(500).json({ error: "Unable to load POS account." });
    }
  });

  originalPost.call(app, "/api/pos/logout", posGuard, async (req,res) => {
    try {
      if(req.posSessionToken){
        await pool.query("UPDATE pos_sessions SET revoked_at=NOW() WHERE token_hash=$1 AND revoked_at IS NULL",[tokenHash(req.posSessionToken)]);
      }
      res.json({ok:true});
    }catch(error){
      console.error("POS session logout failed:",error);
      res.status(503).json({error:"Unable to revoke session while offline."});
    }
  });

  originalGet.call(app, "/api/pos/transactions/today", posGuard, async (req,res) => {
    try{
      // Restrict staff to their own transactions and the current Manila calendar day.
      const data=await pool.query(
        `SELECT s.id,s.transaction_ref,s.client_sale_key,s.created_at,s.total,
                s.payment_method,s.payment_provider,s.payment_status,s.delivery_room_unit,
                COALESCE((SELECT json_agg(json_build_object('label',i.label,'qty',i.qty,'unitPrice',i.unit_price) ORDER BY i.id)
                          FROM sale_items i WHERE i.sale_id=s.id),'[]'::json) AS items
         FROM sales s
         WHERE s.client_sale_user_id=$1
           AND (s.created_at AT TIME ZONE 'Asia/Manila')::date =
               (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Manila')::date
         ORDER BY s.created_at DESC,s.id DESC LIMIT 500`,
        [req.posUser.id]
      );
      res.setHeader("Cache-Control","no-store");
      res.json(data.rows.map(row=>({...row,total:Number(row.total)})));
    }catch(error){console.error("Today's POS transactions failed:",error);res.status(500).json({error:"Unable to load today's transactions."});}
  });

  originalPatch.call(app, "/api/pos/account", posGuard, async (req, res) => {
    try {
      const existing = await pool.query(
        "SELECT id,name,email,password_hash,salt,active,auth_version FROM pos_users WHERE id=$1 AND active=TRUE LIMIT 1",
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

      const authVersion = newPassword ? Number(row.auth_version || 1) + 1 : Number(row.auth_version || 1);
      const updated = await pool.query(
        `UPDATE pos_users
         SET email=$1,password_hash=$2,salt=$3,auth_version=$4
         WHERE id=$5
         RETURNING id,name,email,auth_version`,
        [email, passwordHash, salt, authVersion, row.id]
      );
      const user = updated.rows[0];
      const token = await createPosSession(user);
      if(req.posSessionToken){
        await pool.query("UPDATE pos_sessions SET revoked_at=NOW() WHERE token_hash=$1 AND revoked_at IS NULL",[tokenHash(req.posSessionToken)]);
      }
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
