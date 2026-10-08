const express = require("express");
const multer = require("multer");
const { Pool } = require("pg");
const receiptStorage = require("./receipt-storage");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

let schemaPromise = null;
function ensureSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = pool.query(`
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS payment_status TEXT;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS was_pay_later BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;

    UPDATE sales
    SET payment_status = CASE WHEN payment_method='Pay Later' THEN 'unpaid' ELSE 'paid' END
    WHERE payment_status IS NULL;

    UPDATE sales
    SET paid_at = created_at
    WHERE payment_status='paid' AND paid_at IS NULL;

    ALTER TABLE sales ALTER COLUMN payment_status SET DEFAULT 'paid';
    ALTER TABLE sales ALTER COLUMN payment_status SET NOT NULL;

    ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_payment_status_check;
    ALTER TABLE sales ADD CONSTRAINT sales_payment_status_check
      CHECK (payment_status IN ('paid','unpaid'));

    ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_payment_method_check;
    ALTER TABLE sales ADD CONSTRAINT sales_payment_method_check
      CHECK (payment_method IN ('Cash','GCash','Other','Pay Later'));

    ALTER TABLE sales ADD COLUMN IF NOT EXISTS receipt_key TEXT;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS receipt_size INTEGER;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS receipt_original_size INTEGER;
    ALTER TABLE sales ADD COLUMN IF NOT EXISTS receipt_sha256 TEXT;
  `).catch(error => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
}

function digitsOnly(value) {
  return String(value || "").split("").filter(ch => ch >= "0" && ch <= "9").join("");
}

function normalizeReference(value, provider = "") {
  const cleaned = String(value || "")
    .toUpperCase()
    .split("")
    .filter(ch => (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "-")
    .join("")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return provider === "GCash" ? digitsOnly(cleaned) : cleaned;
}

function validReference(value, provider = "") {
  const ref = normalizeReference(value, provider);
  if (provider === "GCash") return ref.length >= 6 && ref.length <= 18;
  const digitCount = ref.split("").filter(ch => ch >= "0" && ch <= "9").length;
  return ref.length >= 6 && ref.length <= 40 && digitCount >= 4;
}

function oneCharacterCorrection(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) diff++;
      if (diff > 1) return false;
    }
    return true;
  }
  const short = a.length < b.length ? a : b;
  const long = a.length < b.length ? b : a;
  let i = 0, j = 0, skipped = 0;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) { i++; j++; }
    else { skipped++; j++; if (skipped > 1) return false; }
  }
  return true;
}

async function addRoutes(app) {
  app.get("/api/pos/unpaid", async (req, res, next) => {
    try {
      await ensureSchema();
      const { rows } = await pool.query(`
        SELECT s.id,s.transaction_ref,s.delivery_room_unit,s.total,s.created_at,s.series_no,
               COALESCE(json_agg(json_build_object(
                 'category',i.category,'label',i.label,'unitPrice',i.unit_price,'qty',i.qty,'lineTotal',i.line_total
               ) ORDER BY i.id) FILTER (WHERE i.id IS NOT NULL),'[]') AS items
        FROM sales s
        LEFT JOIN sale_items i ON i.sale_id=s.id
        WHERE s.payment_status='unpaid'
        GROUP BY s.id
        ORDER BY s.created_at ASC,s.id ASC
      `);
      res.json(rows.map(row => ({
        ...row,
        total: Number(row.total),
        series: row.series_no == null ? null : String(Number(row.series_no)).padStart(7,"0")
      })));
    } catch (error) { next(error); }
  });

  app.post("/api/pos/unpaid/:id/settle", upload.single("receipt"), async (req, res, next) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid unpaid transaction." });

    try {
      await ensureSchema();

      const existing = await pool.query(
        "SELECT id,transaction_ref,total,payment_status FROM sales WHERE id=$1 LIMIT 1",
        [id]
      );
      if (!existing.rows.length) return res.status(404).json({ error: "Unpaid transaction not found." });
      if (existing.rows[0].payment_status !== "unpaid") {
        return res.status(409).json({ error: "This transaction has already been paid." });
      }

      const paymentMethod = String(req.body.paymentMethod || "");
      if (!["Cash","GCash","Other"].includes(paymentMethod)) {
        return res.status(400).json({ error: "Choose Cash, GCash, or Other to settle this transaction." });
      }

      const providers = ["Maya","MariBank","GoTyme","VYBE by BPI"];
      const provider = paymentMethod === "GCash"
        ? "GCash"
        : paymentMethod === "Other"
          ? String(req.body.paymentProvider || "").trim()
          : null;

      if (paymentMethod === "Other" && !providers.includes(provider)) {
        return res.status(400).json({ error: "Choose Maya, MariBank, GoTyme, or VYBE by BPI." });
      }

      const digital = paymentMethod !== "Cash";
      if (digital && !req.file) return res.status(400).json({ error: provider + " receipt image is required." });
      if (digital && !String(req.file.mimetype || "").startsWith("image/")) {
        return res.status(400).json({ error: "The payment receipt must be an image." });
      }

      let reference = null;
      let referenceStatus = digital ? "unreadable" : null;
      if (digital && String(req.body.ocrVerified) === "true") {
        const detected = normalizeReference(req.body.detectedReference, provider);
        const submitted = normalizeReference(req.body.paymentReference, provider);
        if (!validReference(detected, provider) || !validReference(submitted, provider)) {
          return res.status(400).json({ error: "The payment reference is incomplete or invalid." });
        }
        if (!oneCharacterCorrection(detected, submitted)) {
          return res.status(400).json({ error: "The edited reference differs too much from the scanned receipt." });
        }
        reference = submitted;
        referenceStatus = "verified";
      }

      let stored = null;
      if (digital && req.file?.buffer && receiptStorage.enabled) {
        stored = await receiptStorage.storeReceipt(req.file.buffer, req.file.mimetype, "sales");
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const locked = await client.query(
          "SELECT payment_status FROM sales WHERE id=$1 FOR UPDATE",
          [id]
        );
        if (!locked.rows.length || locked.rows[0].payment_status !== "unpaid") {
          await client.query("ROLLBACK");
          return res.status(409).json({ error: "This transaction has already been paid." });
        }

        const mime = stored?.mime || req.file?.mimetype || null;
        const bytea = stored ? null : (req.file?.buffer || null);
        await client.query(`
          UPDATE sales
          SET payment_method=$1,
              payment_provider=$2,
              payment_reference=$3,
              payment_reference_status=$4,
              gcash_reference=CASE WHEN $1='GCash' THEN $3 ELSE NULL END,
              payment_status='paid',
              paid_at=NOW(),
              receipt_mime=$5,
              receipt_image=$6,
              receipt_key=$7,
              receipt_size=$8,
              receipt_original_size=$9,
              receipt_sha256=$10
          WHERE id=$11
        `, [
          paymentMethod, provider, reference, referenceStatus,
          mime, bytea, stored?.key || null, stored?.size || null,
          stored?.originalSize || null, stored?.sha256 || null, id
        ]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }

      res.json({
        id,
        transactionRef: existing.rows[0].transaction_ref,
        total: Number(existing.rows[0].total),
        paymentMethod,
        paymentProvider: provider,
        status: "paid"
      });
    } catch (error) { next(error); }
  });
}

const currentListen = express.application.listen;
express.application.listen = function(...args) {
  const app = this;
  return ensureSchema().then(() => {
    addRoutes(app);
    return currentListen.apply(app, args);
  });
};
