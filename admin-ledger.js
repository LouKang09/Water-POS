const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");
const { deleteReceipt } = require("./receipt-storage");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

let schemaPromise = null;

// Series is a flexible display label, not the immutable sale id or payment reference.
// Rank *all* active sales before applying date filters so every screen agrees.
const activeSalesSeriesSql = `
  SELECT id,
         ROW_NUMBER() OVER (ORDER BY series_no ASC NULLS LAST, id ASC)::bigint AS display_series_no
  FROM sales
  WHERE payment_status <> 'cancelled'
`;

async function getDisplaySeries(db, id) {
  const { rows } = await db.query(`
    SELECT display_series_no
    FROM (${activeSalesSeriesSql}) AS numbered
    WHERE numbered.id=$1
  `, [id]);
  return rows.length ? Number(rows[0].display_series_no) : null;
}

async function ensureSchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
    await pool.query(`CREATE SEQUENCE IF NOT EXISTS sales_series_seq START 1`);
    await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS series_no BIGINT`);

    const stats = await pool.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(series_no)::int AS assigned,
             COALESCE(MAX(series_no),0)::bigint AS max_series
      FROM sales
    `);
    const row = stats.rows[0];

    if (Number(row.total) > 0 && Number(row.assigned) === 0) {
      await pool.query(`
        WITH ranked AS (
          SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC)::bigint AS rn
          FROM sales
        )
        UPDATE sales s
        SET series_no = ranked.rn
        FROM ranked
        WHERE s.id = ranked.id
      `);
    }

    const maxResult = await pool.query(`SELECT COALESCE(MAX(series_no),0)::bigint AS max_series FROM sales`);
    const maxSeries = Number(maxResult.rows[0].max_series || 0);
    await pool.query(`SELECT setval('sales_series_seq', $1, $2)`, [maxSeries > 0 ? maxSeries : 1, maxSeries > 0]);
    await pool.query(`UPDATE sales SET series_no=nextval('sales_series_seq') WHERE series_no IS NULL`);
    await pool.query(`ALTER TABLE sales ALTER COLUMN series_no SET DEFAULT nextval('sales_series_seq')`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS sales_series_no_unique_idx ON sales(series_no)`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS cash_flow_settings (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        default_petty_cash NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (default_petty_cash >= 0),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      INSERT INTO cash_flow_settings(id,default_petty_cash)
      VALUES(1,0)
      ON CONFLICT (id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS cash_flow_entries (
        entry_date DATE PRIMARY KEY,
        petty_cash_override NUMERIC(12,2) CHECK (petty_cash_override >= 0),
        bank_petty_override NUMERIC(12,2) CHECK (bank_petty_override >= 0),
        actual NUMERIC(12,2) CHECK (actual >= 0),
        credit_to_bank NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (credit_to_bank >= 0),
        debit_from_bank NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (debit_from_bank >= 0),
        note TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      ALTER TABLE cash_flow_settings
        ADD COLUMN IF NOT EXISTS default_bank_petty NUMERIC(12,2) NOT NULL DEFAULT 0;
      ALTER TABLE cash_flow_entries
        ADD COLUMN IF NOT EXISTS bank_petty_override NUMERIC(12,2);

      ALTER TABLE cash_flow_settings DROP CONSTRAINT IF EXISTS cash_flow_settings_default_bank_petty_check;
      ALTER TABLE cash_flow_settings
        ADD CONSTRAINT cash_flow_settings_default_bank_petty_check
        CHECK (default_bank_petty >= 0);
      ALTER TABLE cash_flow_entries DROP CONSTRAINT IF EXISTS cash_flow_entries_bank_petty_override_check;
      ALTER TABLE cash_flow_entries
        ADD CONSTRAINT cash_flow_entries_bank_petty_override_check
        CHECK (bank_petty_override IS NULL OR bank_petty_override >= 0);

      CREATE TABLE IF NOT EXISTS sale_change_history (
        id BIGSERIAL PRIMARY KEY,
        sale_id INTEGER NOT NULL,
        series_no BIGINT,
        transaction_ref TEXT,
        action TEXT NOT NULL CHECK (action IN ('edit','delete')),
        before_snapshot JSONB NOT NULL,
        after_snapshot JSONB,
        changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS sale_change_history_sale_idx
        ON sale_change_history(sale_id, changed_at ASC, id ASC);

      ALTER TABLE sales ADD COLUMN IF NOT EXISTS admin_edit_count INTEGER NOT NULL DEFAULT 0;

      UPDATE sales s
      SET admin_edit_count = GREATEST(s.admin_edit_count, h.edit_count)
      FROM (
        SELECT sale_id, COUNT(*) FILTER (WHERE action='edit')::int AS edit_count
        FROM sale_change_history
        GROUP BY sale_id
      ) h
      WHERE h.sale_id=s.id AND h.edit_count > s.admin_edit_count;

      -- Older edits made before transaction-history tracking cannot be reconstructed
      -- fully. A changed reference date is a reliable signal for historical date
      -- corrections such as Oct 11 -> Oct 9, so preserve at least a 1-edit marker.
      UPDATE sales
      SET admin_edit_count=1
      WHERE admin_edit_count=0
        AND (
          (
            transaction_ref ~ '^WP-[0-9]{8}-'
            AND substring(transaction_ref,4,8) <> to_char(created_at AT TIME ZONE 'Asia/Manila','YYYYMMDD')
          )
          OR
          (
            transaction_ref ~ '^MAN-[0-9]{8}'
            AND substring(transaction_ref,5,8) <> to_char(created_at AT TIME ZONE 'Asia/Manila','YYYYMMDD')
          )
        );
    `);
  })().catch(error => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
}

function cleanDate(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function parseDateTime(value) {
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) return null;
  const instant = new Date(text + ":00+08:00");
  if (!Number.isFinite(instant.getTime())) return null;
  return { text, instant };
}

function manualReference(dateTime) {
  const compact = String(dateTime || "").replace(/[^0-9]/g, "").slice(0, 14).padEnd(14, "0");
  return "MAN-" + compact + "-" + crypto.randomBytes(2).toString("hex").toUpperCase();
}

function cleanReference(value, provider) {
  const raw = String(value || "").trim().toUpperCase();
  if (!raw) return null;
  const cleaned = raw
    .split("")
    .filter(ch => (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "-")
    .join("")
    .slice(0, 60);
  return provider === "GCash" ? cleaned.replace(/\D/g, "").slice(0, 18) : cleaned;
}

function normalizeItems(value) {
  if (!Array.isArray(value) || !value.length) throw new Error("Add at least one transaction item.");
  if (value.length > 50) throw new Error("A transaction can contain up to 50 item rows.");
  const allowed = new Set(["Delivery", "Pick-Up", "New", "Used", "Retail", "Other"]);
  const fixed = {
    Delivery: new Set([25, 35, 45]),
    "Pick-Up": new Set([20, 30, 40]),
    New: new Set([200]),
    Retail: new Set([9, 15]),
  };

  return value.map((raw, index) => {
    const category = String(raw.category || "").trim();
    const qty = Number.parseInt(raw.qty, 10);
    const price = Number(raw.unitPrice);
    let label = String(raw.label || "").trim().slice(0, 120);

    if (!allowed.has(category)) throw new Error("Choose a valid category for item " + (index + 1) + ".");
    if (!Number.isInteger(qty) || qty < 1 || qty > 1000) throw new Error("Enter a valid quantity for item " + (index + 1) + ".");
    if (!(price > 0) || price > 1000000) throw new Error("Enter a valid unit price for item " + (index + 1) + ".");

    if (fixed[category] && !fixed[category].has(price)) {
      throw new Error("Choose a standard POS price for " + category + " item " + (index + 1) + ".");
    }
    if (category === "Other" && !label) {
      throw new Error("Enter what the Other item is for item " + (index + 1) + ".");
    }
    if (category === "Retail") label = price === 9 ? "Reseller" : "Retail direct to consumer";
    if (!label) {
      label = category === "New" ? "New Gallon" : category + " ₱" + price;
    }

    return { category, label, unitPrice: price, qty, lineTotal: price * qty };
  });
}

function paymentFields(body) {
  const paymentMethod = String(body.paymentMethod || "Cash");
  if (!["Cash", "GCash", "Other", "Pay Later"].includes(paymentMethod)) throw new Error("Choose a valid payment method.");
  const allowedOtherProviders = ["Maya", "MariBank", "GoTyme", "VYBE by BPI"];
  const paymentProvider = paymentMethod === "GCash"
    ? "GCash"
    : paymentMethod === "Other"
      ? String(body.paymentProvider || "").trim()
      : null;
  if (paymentMethod === "Other" && !allowedOtherProviders.includes(paymentProvider)) {
    throw new Error("Choose the payment provider.");
  }
  const noReference = paymentMethod === "Cash" || paymentMethod === "Pay Later";
  const paymentReference = noReference ? null : cleanReference(body.paymentReference, paymentProvider);
  return {
    paymentMethod,
    paymentProvider,
    paymentReference,
    referenceStatus: noReference ? null : "manual",
    paymentStatus: paymentMethod === "Pay Later" ? "unpaid" : "paid",
    wasPayLater: paymentMethod === "Pay Later",
  };
}

async function loadSaleSnapshot(db, id) {
  const { rows } = await db.query(`
    SELECT
      s.id,s.series_no,s.transaction_ref,s.payment_method,s.payment_provider,
      COALESCE(s.payment_reference,s.gcash_reference) AS payment_reference,
      s.payment_reference_status,s.payment_status,s.was_pay_later,s.paid_at,
      s.delivery_room_unit,s.total,s.created_at,s.cancelled_at,s.receipt_key,
      COALESCE(
        json_agg(
          json_build_object(
            'id',i.id,
            'category',i.category,
            'label',i.label,
            'unitPrice',i.unit_price,
            'qty',i.qty,
            'lineTotal',i.line_total
          )
          ORDER BY i.id
        ) FILTER (WHERE i.id IS NOT NULL),
        '[]'
      ) AS items
    FROM sales s
    LEFT JOIN sale_items i ON i.sale_id=s.id
    WHERE s.id=$1
    GROUP BY s.id
  `, [id]);
  return rows[0] || null;
}

async function recordSaleChange(db, action, beforeSnapshot, afterSnapshot = null) {
  await db.query(`
    INSERT INTO sale_change_history(
      sale_id,series_no,transaction_ref,action,before_snapshot,after_snapshot,changed_at
    )
    VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,NOW())
  `, [
    beforeSnapshot.id,
    beforeSnapshot.series_no,
    beforeSnapshot.transaction_ref,
    action,
    JSON.stringify(beforeSnapshot),
    afterSnapshot ? JSON.stringify(afterSnapshot) : null,
  ]);
}

function formatSeries(value) {
  return String(Number(value || 0)).padStart(6, "0");
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function addRoutes(app) {
  app.get("/api/admin/ledger/series", async (req, res, next) => {
    try {
      await ensureSchema();
      const from = cleanDate(req.query.from) || "2000-01-01";
      const to = cleanDate(req.query.to) || "2999-12-31";
      const { rows } = await pool.query(`
        SELECT s.id,numbered.display_series_no AS series_no,s.admin_edit_count
        FROM (${activeSalesSeriesSql}) AS numbered
        JOIN sales s ON s.id=numbered.id
        WHERE (s.created_at AT TIME ZONE 'Asia/Manila')::date BETWEEN $1::date AND $2::date
        ORDER BY s.created_at DESC,s.id DESC
        LIMIT 500
      `, [from, to]);
      res.json(rows.map(row => ({
        id: row.id,
        seriesNo: Number(row.series_no),
        series: formatSeries(row.series_no),
        editCount: Number(row.admin_edit_count || 0),
      })));
    } catch (error) { next(error); }
  });

  app.get("/api/admin/ledger/sales/:id", async (req, res, next) => {
    try {
      await ensureSchema();
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid transaction." });
      const { rows } = await pool.query(`
        SELECT s.id,s.series_no,s.transaction_ref,s.payment_status,s.cancelled_at,s.cancellation_reason,s.payment_method,
               COALESCE(s.payment_provider,CASE WHEN s.payment_method='GCash' THEN 'GCash' ELSE NULL END) AS payment_provider,
               COALESCE(s.payment_reference,s.gcash_reference) AS payment_reference,
               s.payment_reference_status,s.delivery_room_unit,s.total,s.created_at,
               COALESCE(json_agg(json_build_object(
                 'id',i.id,'category',i.category,'label',i.label,'unitPrice',i.unit_price,'qty',i.qty,'lineTotal',i.line_total
               ) ORDER BY i.id) FILTER (WHERE i.id IS NOT NULL),'[]') AS items
        FROM sales s
        LEFT JOIN sale_items i ON i.sale_id=s.id
        WHERE s.id=$1
        GROUP BY s.id
      `, [id]);
      if (!rows.length) return res.status(404).json({ error: "Transaction not found." });
      const row = rows[0];
      const displaySeries = await getDisplaySeries(pool, id);
      const seriesNo = displaySeries ?? Number(row.series_no);
      res.json({ ...row, series_no: seriesNo, series: formatSeries(seriesNo), total: Number(row.total) });
    } catch (error) { next(error); }
  });

  app.get("/api/admin/ledger/sales/:id/history", async (req, res, next) => {
    try {
      await ensureSchema();
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid transaction." });
      }
      const historyResult = await pool.query(`
        SELECT id,sale_id,series_no,transaction_ref,action,before_snapshot,after_snapshot,changed_at
        FROM sale_change_history
        WHERE sale_id=$1
        ORDER BY changed_at ASC,id ASC
      `, [id]);
      const current = await loadSaleSnapshot(pool, id);
      const countResult = current
        ? await pool.query("SELECT admin_edit_count FROM sales WHERE id=$1", [id])
        : { rows: [] };
      const editCount = Number(countResult.rows[0]?.admin_edit_count || historyResult.rows.filter(row => row.action === "edit").length || 0);
      const currentDisplaySeries = current ? await getDisplaySeries(pool, id) : null;
      res.json({
        saleId: id,
        series: current ? formatSeries(currentDisplaySeries ?? current.series_no) : (historyResult.rows[0] ? formatSeries(historyResult.rows[0].series_no) : null),
        transactionRef: current?.transaction_ref || historyResult.rows[0]?.transaction_ref || null,
        editCount,
        legacyEditCount: Math.max(0, editCount - historyResult.rows.filter(row => row.action === "edit").length),
        history: historyResult.rows,
        current,
      });
    } catch (error) { next(error); }
  });

  app.post("/api/admin/ledger/sales/bulk-delete", async (req, res, next) => {
    const client = await pool.connect();
    const receiptKeys = [];
    try {
      await ensureSchema();
      const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
      const ids = [...new Set(rawIds.map(Number).filter(id => Number.isInteger(id) && id > 0))];
      if (!ids.length) return res.status(400).json({ error: "Select at least one transaction." });
      if (ids.length > 100) return res.status(400).json({ error: "You can delete up to 100 transactions at once." });

      await client.query("BEGIN");
      // Capture the original labels once; they must not shift midway through a bulk deletion.
      const initialSeriesRows = await client.query(`
        SELECT id,display_series_no
        FROM (${activeSalesSeriesSql}) AS numbered
        WHERE numbered.id=ANY($1::int[])
      `, [ids]);
      const initialSeries = new Map(initialSeriesRows.rows.map(row => [Number(row.id), Number(row.display_series_no)]));
      const deleted = [];
      for (const id of ids) {
        const beforeSnapshot = await loadSaleSnapshot(client, id);
        if (!beforeSnapshot) continue;
        await recordSaleChange(client, "delete", beforeSnapshot, null);
        if (beforeSnapshot.receipt_key) receiptKeys.push(beforeSnapshot.receipt_key);
        await client.query("DELETE FROM sales WHERE id=$1", [id]);
        deleted.push({ id, series: formatSeries(initialSeries.get(id) ?? beforeSnapshot.series_no), transactionRef: beforeSnapshot.transaction_ref });
      }
      await client.query("COMMIT");

      for (const key of receiptKeys) {
        deleteReceipt(key).catch(error => console.warn("Unable to delete receipt object", key, error.message));
      }

      res.json({ deletedCount: deleted.length, requestedCount: ids.length, deleted });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      next(error);
    } finally {
      client.release();
    }
  });

  app.delete("/api/admin/ledger/sales/:id", async (req, res, next) => {
    const client = await pool.connect();
    let receiptKey = null;
    try {
      await ensureSchema();
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid transaction." });
      }

      await client.query("BEGIN");
      const beforeSnapshot = await loadSaleSnapshot(client, id);
      if (!beforeSnapshot) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Transaction not found." });
      }

      const oldDisplaySeries = await getDisplaySeries(client, id);
      receiptKey = beforeSnapshot.receipt_key || null;
      await recordSaleChange(client, "delete", beforeSnapshot, null);
      await client.query("DELETE FROM sales WHERE id=$1", [id]);
      await client.query("COMMIT");

      if (receiptKey) {
        deleteReceipt(receiptKey).catch(error => {
          console.warn("Unable to delete receipt object for sale", id, error.message);
        });
      }

      res.json({
        deleted: true,
        id,
        series: formatSeries(oldDisplaySeries ?? beforeSnapshot.series_no),
        transactionRef: beforeSnapshot.transaction_ref,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      next(error);
    } finally {
      client.release();
    }
  });

  app.patch("/api/admin/ledger/sales/:id", async (req, res, next) => {
    const client = await pool.connect();
    try {
      await ensureSchema();
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid transaction." });
      const existing = await client.query(
        `SELECT id,series_no,transaction_ref,payment_status,was_pay_later,paid_at,created_at,admin_edit_count
         FROM sales WHERE id=$1 LIMIT 1`,
        [id]
      );
      if (!existing.rows.length) return res.status(404).json({ error: "Transaction not found." });

      const parsedDate = parseDateTime(req.body.dateTime);
      if (!parsedDate) return res.status(400).json({ error: "Choose a valid transaction date and time." });
      if (parsedDate.instant.getTime() > Date.now() + 5 * 60 * 1000) {
        return res.status(400).json({ error: "Transaction date cannot be in the future." });
      }

      const items = normalizeItems(req.body.items);
      const total = items.reduce((sum, item) => sum + item.lineTotal, 0);
      const payment = paymentFields(req.body);
      const roomUnit = String(req.body.roomUnit || "").trim().replace(/\s+/g, " ").replace(/\bUnit(?:\s+Unit)+\b/gi, "Unit").replace(/\bRoom(?:\s+Room)+\b/gi, "Room").replace(/^(?:unit\b[\s:#-]*)+/i, "").trim().slice(0, 100) || null;
      const original = existing.rows[0];
      const correctedDate = parsedDate.text + ":00+08:00";
      const preserveRealSettlement =
        Boolean(original.was_pay_later) &&
        original.payment_status === "paid" &&
        Boolean(original.paid_at) &&
        payment.paymentStatus === "paid";
      const nextPaidAt =
        payment.paymentStatus === "unpaid"
          ? null
          : preserveRealSettlement
            ? original.paid_at
            : correctedDate;
      const nextWasPayLater = Boolean(original.was_pay_later) || payment.wasPayLater;

      await client.query("BEGIN");
      const beforeSnapshot = await loadSaleSnapshot(client, id);
      await client.query(`
        UPDATE sales
        SET payment_method=$1,payment_provider=$2,payment_reference=$3,payment_reference_status=$4,
            gcash_reference=$5,delivery_room_unit=$6,total=$7,created_at=$8::timestamptz,
            payment_status=$9,was_pay_later=$10,paid_at=$11,
            admin_edit_count=admin_edit_count+1
        WHERE id=$12
      `, [
        payment.paymentMethod,
        payment.paymentProvider,
        payment.paymentReference,
        payment.referenceStatus,
        payment.paymentMethod === "GCash" ? payment.paymentReference : null,
        roomUnit,
        total,
        correctedDate,
        payment.paymentStatus,
        nextWasPayLater,
        nextPaidAt,
        id,
      ]);
      await client.query("DELETE FROM sale_items WHERE sale_id=$1", [id]);
      for (const item of items) {
        await client.query(`
          INSERT INTO sale_items(sale_id,category,label,unit_price,qty,line_total)
          VALUES($1,$2,$3,$4,$5,$6)
        `, [id, item.category, item.label, item.unitPrice, item.qty, item.lineTotal]);
      }
      const afterSnapshot = await loadSaleSnapshot(client, id);
      await recordSaleChange(client, "edit", beforeSnapshot, afterSnapshot);
      const currentDisplaySeries = await getDisplaySeries(client, id);
      await client.query("COMMIT");
      res.json({
        id,
        series: formatSeries(currentDisplaySeries ?? existing.rows[0].series_no),
        total,
        cashFlowDate: nextPaidAt || correctedDate,
        settlementDatePreserved: preserveRealSettlement,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (/transaction item|valid category|valid quantity|valid unit price|standard POS price|Other item|payment method|payment provider/.test(error.message)) {
        return res.status(400).json({ error: error.message });
      }
      next(error);
    } finally {
      client.release();
    }
  });

  // Registered before the legacy Admin Control route, so this enhanced handler owns manual sales.
  app.post("/api/admin/manual-sales", async (req, res, next) => {
    const client = await pool.connect();
    try {
      await ensureSchema();
      const parsedDate = parseDateTime(req.body.dateTime);
      if (!parsedDate) return res.status(400).json({ error: "Choose a valid transaction date and time." });
      if (parsedDate.instant.getTime() > Date.now() + 5 * 60 * 1000) {
        return res.status(400).json({ error: "Manual transactions cannot be dated in the future." });
      }
      const items = normalizeItems(req.body.items);
      const total = items.reduce((sum, item) => sum + item.lineTotal, 0);
      const payment = paymentFields(req.body);
      const roomUnit = String(req.body.roomUnit || "").trim().replace(/\s+/g, " ").replace(/\bUnit(?:\s+Unit)+\b/gi, "Unit").replace(/\bRoom(?:\s+Room)+\b/gi, "Room").replace(/^(?:unit\b[\s:#-]*)+/i, "").trim().slice(0, 100) || null;
      const reference = manualReference(parsedDate.text);

      await client.query("BEGIN");
      const created = await client.query(`
        INSERT INTO sales(
          transaction_ref,payment_method,payment_provider,payment_reference,payment_reference_status,
          gcash_reference,delivery_room_unit,total,receipt_mime,receipt_image,created_at,
          payment_status,was_pay_later,paid_at
        )
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL,NULL,$9::timestamptz,$10,$11,
               CASE WHEN $10='unpaid' THEN NULL ELSE $9::timestamptz END)
        RETURNING id,series_no,transaction_ref,total,created_at,payment_status
      `, [
        reference,
        payment.paymentMethod,
        payment.paymentProvider,
        payment.paymentReference,
        payment.referenceStatus,
        payment.paymentMethod === "GCash" ? payment.paymentReference : null,
        roomUnit,
        total,
        parsedDate.text + ":00+08:00",
        payment.paymentStatus,
        payment.wasPayLater,
      ]);
      for (const item of items) {
        await client.query(`
          INSERT INTO sale_items(sale_id,category,label,unit_price,qty,line_total)
          VALUES($1,$2,$3,$4,$5,$6)
        `, [created.rows[0].id, item.category, item.label, item.unitPrice, item.qty, item.lineTotal]);
      }
      const displaySeries = await getDisplaySeries(client, created.rows[0].id);
      await client.query("COMMIT");
      res.status(201).json({
        ...created.rows[0],
        series_no: displaySeries ?? Number(created.rows[0].series_no),
        series: formatSeries(displaySeries ?? created.rows[0].series_no),
        total: Number(created.rows[0].total),
        itemCount: items.length,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (/transaction item|valid category|valid quantity|valid unit price|standard POS price|Other item|payment method|payment provider/.test(error.message)) {
        return res.status(400).json({ error: error.message });
      }
      next(error);
    } finally {
      client.release();
    }
  });

  app.get("/api/admin/cash-flow", async (req, res, next) => {
    try {
      await ensureSchema();
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
      const from = cleanDate(req.query.from) || today.slice(0, 8) + "01";
      const to = cleanDate(req.query.to) || today;
      if (from > to) return res.status(400).json({ error: "From date cannot be after To date." });

      const daysBetween = Math.floor((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400000);
      if (daysBetween > 3660) return res.status(400).json({ error: "Choose a range of 10 years or less." });

      const [settingResult, salesResult, expenseResult, entryResult] = await Promise.all([
        pool.query("SELECT default_petty_cash,default_bank_petty FROM cash_flow_settings WHERE id=1"),
        pool.query(`
          SELECT to_char((COALESCE(paid_at,created_at) AT TIME ZONE 'Asia/Manila')::date,'YYYY-MM-DD') AS date,
                 COALESCE(SUM(total),0)::numeric AS daily_income,
                 COALESCE(SUM(total) FILTER (WHERE payment_method='Cash'),0)::numeric AS cash,
                 COUNT(*) FILTER (WHERE payment_method='Cash')::int AS cash_txns,
                 COALESCE(SUM(total) FILTER (WHERE payment_method='GCash'),0)::numeric AS gcash,
                 COALESCE(SUM(total) FILTER (WHERE payment_method='Other'),0)::numeric AS other,
                 COUNT(*) FILTER (WHERE payment_method='GCash')::int AS gcash_txns,
                 COUNT(*)::int AS transaction_count
          FROM sales
          WHERE payment_status='paid'
            AND (COALESCE(paid_at,created_at) AT TIME ZONE 'Asia/Manila')::date BETWEEN $1::date AND $2::date
          GROUP BY 1
        `, [from, to]),
        pool.query(`
          SELECT to_char(expense_date,'YYYY-MM-DD') AS date,COALESCE(SUM(amount),0)::numeric AS expenses
          FROM expenses
          WHERE expense_date BETWEEN $1::date AND $2::date
          GROUP BY expense_date
        `, [from, to]),
        pool.query(`
          SELECT to_char(entry_date,'YYYY-MM-DD') AS date,
                 petty_cash_override,bank_petty_override,actual,
                 COALESCE(credit_to_bank,0)::numeric AS credit_to_bank,
                 COALESCE(debit_from_bank,0)::numeric AS debit_from_bank,
                 COALESCE(note,'') AS note
          FROM cash_flow_entries
          WHERE entry_date <= $1::date
          ORDER BY entry_date ASC
        `, [to]),
      ]);

      const defaultPettyCash = Number(settingResult.rows[0]?.default_petty_cash || 0);
      const defaultBankPetty = Number(settingResult.rows[0]?.default_bank_petty || 0);
      const salesByDate = new Map(salesResult.rows.map(row => [row.date, row]));
      const expensesByDate = new Map(expenseResult.rows.map(row => [row.date, Number(row.expenses || 0)]));
      const entriesByDate = new Map(entryResult.rows.map(row => [row.date, row]));

      let runningBank = defaultBankPetty;
      for (const entry of entryResult.rows) {
        if (entry.date >= from) break;
        if (entry.bank_petty_override != null) runningBank = Number(entry.bank_petty_override);
        runningBank += Number(entry.credit_to_bank || 0) - Number(entry.debit_from_bank || 0);
      }

      const rows = [];
      const start = Date.parse(from + "T00:00:00Z");
      const end = Date.parse(to + "T00:00:00Z");
      for (let time = start; time <= end; time += 86400000) {
        const date = new Date(time).toISOString().slice(0, 10);
        const sale = salesByDate.get(date) || {};
        const entry = entriesByDate.get(date) || null;

        // The previous calendar day's counted cash becomes today's opening petty cash.
        // Saved petty cash overrides still take precedence; the configured default
        // remains the fallback when yesterday has no actual count.
        const pettyCashOverride = entry?.petty_cash_override == null ? null : Number(entry.petty_cash_override);
        const previousDate = new Date(time - 86400000).toISOString().slice(0, 10);
        const previousActual = entriesByDate.get(previousDate)?.actual;
        const pettyCashSource = pettyCashOverride != null ? "override"
          : previousActual != null ? "previous_actual" : "default";
        const pettyCash = pettyCashOverride != null ? pettyCashOverride
          : previousActual != null ? Number(previousActual) : defaultPettyCash;
        const dailyIncome = Number(sale.daily_income || 0);
        const cash = Number(sale.cash || 0);
        const expenses = Number(expensesByDate.get(date) || 0);
        const expectedTotal = pettyCash + cash - expenses;
        const actual = entry?.actual == null ? null : Number(entry.actual);

        const bankPettyOverride = entry?.bank_petty_override == null ? null : Number(entry.bank_petty_override);
        const bankPetty = bankPettyOverride == null ? runningBank : bankPettyOverride;
        const creditToBank = Number(entry?.credit_to_bank || 0);
        const debitFromBank = Number(entry?.debit_from_bank || 0);
        runningBank = bankPetty + creditToBank - debitFromBank;

        const gcash = Number(sale.gcash || 0);
        const other = Number(sale.other || 0);

        rows.push({
          date,
          pettyCash,
          pettyCashSource,
          pettyCashPreviousDate: pettyCashSource === "previous_actual" ? previousDate : null,
          pettyCashOverride,
          dailyIncome,
          cash,
          cashTxns: Number(sale.cash_txns || 0),
          gcash,
          gcashTxns: Number(sale.gcash_txns || 0),
          other,
          transactionCount: Number(sale.transaction_count || 0),
          expenses,
          expectedTotal,
          actual,
          variance: actual == null ? null : actual - expectedTotal,
          bankPetty,
          bankPettyOverride,
          creditToBank,
          debitFromBank,
          runningBankTotal: runningBank,
          note: entry?.note || "",
        });
      }

      res.json({ from, to, defaultPettyCash, defaultBankPetty, rows });
    } catch (error) { next(error); }
  });

  app.get("/api/admin/cash-flow/entry/:date", async (req, res, next) => {
    try {
      await ensureSchema();
      const date = cleanDate(req.params.date);
      if (!date) return res.status(400).json({ error: "Choose a valid cash-flow date." });
      const { rows } = await pool.query(`
        SELECT to_char(entry_date,'YYYY-MM-DD') AS date,
               petty_cash_override,bank_petty_override,actual,
               COALESCE(credit_to_bank,0)::numeric AS credit_to_bank,
               COALESCE(debit_from_bank,0)::numeric AS debit_from_bank,
               COALESCE(note,'') AS note
        FROM cash_flow_entries
        WHERE entry_date=$1::date
        LIMIT 1
      `, [date]);
      const row = rows[0] || {};
      res.json({
        date,
        pettyCashOverride: row.petty_cash_override == null ? null : Number(row.petty_cash_override),
        bankPettyOverride: row.bank_petty_override == null ? null : Number(row.bank_petty_override),
        actual: row.actual == null ? null : Number(row.actual),
        creditToBank: Number(row.credit_to_bank || 0),
        debitFromBank: Number(row.debit_from_bank || 0),
        note: row.note || "",
      });
    } catch (error) { next(error); }
  });

  app.patch("/api/admin/cash-flow/settings", async (req, res, next) => {
    try {
      await ensureSchema();
      const defaultPettyCash = Number(req.body.defaultPettyCash);
      const defaultBankPetty = Number(req.body.defaultBankPetty);
      if (!Number.isFinite(defaultPettyCash) || defaultPettyCash < 0 || defaultPettyCash > 1000000000 ||
          !Number.isFinite(defaultBankPetty) || defaultBankPetty < 0 || defaultBankPetty > 1000000000) {
        return res.status(400).json({ error: "Enter valid opening balances." });
      }
      const { rows } = await pool.query(`
        UPDATE cash_flow_settings
        SET default_petty_cash=$1,default_bank_petty=$2,updated_at=NOW()
        WHERE id=1
        RETURNING default_petty_cash,default_bank_petty,updated_at
      `, [defaultPettyCash, defaultBankPetty]);
      res.json({
        defaultPettyCash: Number(rows[0].default_petty_cash),
        defaultBankPetty: Number(rows[0].default_bank_petty),
        updatedAt: rows[0].updated_at,
      });
    } catch (error) { next(error); }
  });

  app.put("/api/admin/cash-flow/:date", async (req, res, next) => {
    try {
      await ensureSchema();
      const date = cleanDate(req.params.date);
      if (!date) return res.status(400).json({ error: "Choose a valid cash-flow date." });

      const nullableMoney = value => {
        if (value === "" || value == null) return null;
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0 || n > 1000000000 || Math.round(n * 100) / 100 !== n) {
          throw new Error("Enter non-negative amounts with at most two decimal places.");
        }
        return n;
      };
      const pettyCashOverride = nullableMoney(req.body.pettyCashOverride);
      const bankPettyOverride = nullableMoney(req.body.bankPettyOverride);
      const actual = nullableMoney(req.body.actual);
      const creditToBank = nullableMoney(req.body.creditToBank) ?? 0;
      const debitFromBank = nullableMoney(req.body.debitFromBank) ?? 0;
      const note = String(req.body.note || "").trim();
      if (note.length > 500) return res.status(400).json({ error: "Note must be 500 characters or fewer." });

      const { rows } = await pool.query(`
        INSERT INTO cash_flow_entries(
          entry_date,petty_cash_override,bank_petty_override,actual,
          credit_to_bank,debit_from_bank,note,updated_at
        )
        VALUES($1,$2,$3,$4,$5,$6,$7,NOW())
        ON CONFLICT(entry_date) DO UPDATE SET
          petty_cash_override=EXCLUDED.petty_cash_override,
          bank_petty_override=EXCLUDED.bank_petty_override,
          actual=EXCLUDED.actual,
          credit_to_bank=EXCLUDED.credit_to_bank,
          debit_from_bank=EXCLUDED.debit_from_bank,
          note=EXCLUDED.note,
          updated_at=NOW()
        RETURNING to_char(entry_date,'YYYY-MM-DD') AS date,
                  petty_cash_override,bank_petty_override,actual,
                  credit_to_bank,debit_from_bank,note,updated_at
      `, [date, pettyCashOverride, bankPettyOverride, actual, creditToBank, debitFromBank, note]);

      const row = rows[0];
      res.json({
        date: row.date,
        pettyCashOverride: row.petty_cash_override == null ? null : Number(row.petty_cash_override),
        bankPettyOverride: row.bank_petty_override == null ? null : Number(row.bank_petty_override),
        actual: row.actual == null ? null : Number(row.actual),
        creditToBank: Number(row.credit_to_bank || 0),
        debitFromBank: Number(row.debit_from_bank || 0),
        note: row.note || "",
        updatedAt: row.updated_at,
      });
    } catch (error) {
      if (/non-negative amounts/.test(error.message)) return res.status(400).json({ error: error.message });
      next(error);
    }
  });
}

const currentListen = express.application.listen;
express.application.listen = function(...args) {
  addRoutes(this);
  ensureSchema().catch(error => console.error("Admin ledger schema error:", error));
  return currentListen.apply(this, args);
};
