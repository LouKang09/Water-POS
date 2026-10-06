const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

let schemaPromise = null;

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
        actual NUMERIC(12,2) CHECK (actual >= 0),
        credit_to_bank NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (credit_to_bank >= 0),
        debit_from_bank NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (debit_from_bank >= 0),
        note TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
  const allowed = new Set(["Delivery", "Pick-Up", "New", "Used", "Other"]);
  const fixed = {
    Delivery: new Set([25, 35, 45]),
    "Pick-Up": new Set([20, 30, 40]),
    New: new Set([200]),
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
    if (!label) {
      label = category === "New" ? "New Gallon" : category + " ₱" + price;
    }

    return { category, label, unitPrice: price, qty, lineTotal: price * qty };
  });
}

function paymentFields(body) {
  const paymentMethod = String(body.paymentMethod || "Cash");
  if (!["Cash", "GCash", "Other"].includes(paymentMethod)) throw new Error("Choose a valid payment method.");
  const allowedOtherProviders = ["Maya", "MariBank", "GoTyme", "VYBE by BPI"];
  const paymentProvider = paymentMethod === "GCash"
    ? "GCash"
    : paymentMethod === "Other"
      ? String(body.paymentProvider || "").trim()
      : null;
  if (paymentMethod === "Other" && !allowedOtherProviders.includes(paymentProvider)) {
    throw new Error("Choose the payment provider.");
  }
  const paymentReference = paymentMethod === "Cash" ? null : cleanReference(body.paymentReference, paymentProvider);
  return {
    paymentMethod,
    paymentProvider,
    paymentReference,
    referenceStatus: paymentMethod === "Cash" ? null : "manual",
  };
}

function formatSeries(value) {
  return String(Number(value || 0)).padStart(7, "0");
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
        SELECT id,series_no
        FROM sales
        WHERE (created_at AT TIME ZONE 'Asia/Manila')::date BETWEEN $1::date AND $2::date
        ORDER BY created_at DESC,id DESC
        LIMIT 500
      `, [from, to]);
      res.json(rows.map(row => ({ id: row.id, seriesNo: Number(row.series_no), series: formatSeries(row.series_no) })));
    } catch (error) { next(error); }
  });

  app.get("/api/admin/ledger/sales/:id", async (req, res, next) => {
    try {
      await ensureSchema();
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid transaction." });
      const { rows } = await pool.query(`
        SELECT s.id,s.series_no,s.transaction_ref,s.payment_method,
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
      res.json({ ...row, series: formatSeries(row.series_no), total: Number(row.total) });
    } catch (error) { next(error); }
  });

  app.patch("/api/admin/ledger/sales/:id", async (req, res, next) => {
    const client = await pool.connect();
    try {
      await ensureSchema();
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "Invalid transaction." });
      const existing = await client.query("SELECT id,series_no FROM sales WHERE id=$1 LIMIT 1", [id]);
      if (!existing.rows.length) return res.status(404).json({ error: "Transaction not found." });

      const parsedDate = parseDateTime(req.body.dateTime);
      if (!parsedDate) return res.status(400).json({ error: "Choose a valid transaction date and time." });
      if (parsedDate.instant.getTime() > Date.now() + 5 * 60 * 1000) {
        return res.status(400).json({ error: "Transaction date cannot be in the future." });
      }

      const items = normalizeItems(req.body.items);
      const total = items.reduce((sum, item) => sum + item.lineTotal, 0);
      const payment = paymentFields(req.body);
      const roomUnit = String(req.body.roomUnit || "").trim().slice(0, 100) || null;

      await client.query("BEGIN");
      await client.query(`
        UPDATE sales
        SET payment_method=$1,payment_provider=$2,payment_reference=$3,payment_reference_status=$4,
            gcash_reference=$5,delivery_room_unit=$6,total=$7,created_at=$8::timestamptz
        WHERE id=$9
      `, [
        payment.paymentMethod,
        payment.paymentProvider,
        payment.paymentReference,
        payment.referenceStatus,
        payment.paymentMethod === "GCash" ? payment.paymentReference : null,
        roomUnit,
        total,
        parsedDate.text + ":00+08:00",
        id,
      ]);
      await client.query("DELETE FROM sale_items WHERE sale_id=$1", [id]);
      for (const item of items) {
        await client.query(`
          INSERT INTO sale_items(sale_id,category,label,unit_price,qty,line_total)
          VALUES($1,$2,$3,$4,$5,$6)
        `, [id, item.category, item.label, item.unitPrice, item.qty, item.lineTotal]);
      }
      await client.query("COMMIT");
      res.json({ id, series: formatSeries(existing.rows[0].series_no), total });
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
      const roomUnit = String(req.body.roomUnit || "").trim().slice(0, 100) || null;
      const reference = manualReference(parsedDate.text);

      await client.query("BEGIN");
      const created = await client.query(`
        INSERT INTO sales(
          transaction_ref,payment_method,payment_provider,payment_reference,payment_reference_status,
          gcash_reference,delivery_room_unit,total,receipt_mime,receipt_image,created_at
        )
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL,NULL,$9::timestamptz)
        RETURNING id,series_no,transaction_ref,total,created_at
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
      ]);
      for (const item of items) {
        await client.query(`
          INSERT INTO sale_items(sale_id,category,label,unit_price,qty,line_total)
          VALUES($1,$2,$3,$4,$5,$6)
        `, [created.rows[0].id, item.category, item.label, item.unitPrice, item.qty, item.lineTotal]);
      }
      await client.query("COMMIT");
      res.status(201).json({
        ...created.rows[0],
        series: formatSeries(created.rows[0].series_no),
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

      const settingResult = await pool.query("SELECT default_petty_cash FROM cash_flow_settings WHERE id=1");
      const defaultPettyCash = Number(settingResult.rows[0]?.default_petty_cash || 0);

      const { rows } = await pool.query(`
        WITH days AS (
          SELECT generate_series($1::date,$2::date,interval '1 day')::date AS day
        ),
        sales_daily AS (
          SELECT (created_at AT TIME ZONE 'Asia/Manila')::date AS day,
                 COALESCE(SUM(total),0)::numeric AS daily_income,
                 COALESCE(SUM(total) FILTER (WHERE payment_method='Cash'),0)::numeric AS cash,
                 COALESCE(SUM(total) FILTER (WHERE payment_method='GCash'),0)::numeric AS gcash,
                 COALESCE(SUM(total) FILTER (WHERE payment_method='Other'),0)::numeric AS other,
                 COUNT(*)::int AS transaction_count,
                 COUNT(*) FILTER (WHERE payment_method='Cash')::int AS cash_txns,
                 COUNT(*) FILTER (WHERE payment_method='GCash')::int AS gcash_txns,
                 COUNT(*) FILTER (WHERE payment_method='Other')::int AS other_txns
          FROM sales
          WHERE (created_at AT TIME ZONE 'Asia/Manila')::date BETWEEN $1::date AND $2::date
          GROUP BY 1
        ),
        expense_daily AS (
          SELECT expense_date AS day,COALESCE(SUM(amount),0)::numeric AS expenses
          FROM expenses
          WHERE expense_date BETWEEN $1::date AND $2::date
          GROUP BY 1
        ),
        base AS (
          SELECT d.day,
                 COALESCE(e.petty_cash_override,$3::numeric)::numeric AS petty_cash,
                 COALESCE(s.daily_income,0)::numeric AS daily_income,
                 COALESCE(x.expenses,0)::numeric AS expenses,
                 e.actual,
                 COALESCE(s.cash,0)::numeric AS cash,
                 COALESCE(s.gcash,0)::numeric AS gcash,
                 COALESCE(s.other,0)::numeric AS other,
                 COALESCE(s.cash_txns,0)::int AS cash_txns,
                 COALESCE(s.gcash_txns,0)::int AS gcash_txns,
                 COALESCE(s.other_txns,0)::int AS other_txns,
                 COALESCE(s.transaction_count,0)::int AS transaction_count,
                 COALESCE(e.credit_to_bank,0)::numeric AS credit_to_bank,
                 COALESCE(e.debit_from_bank,0)::numeric AS debit_from_bank,
                 COALESCE(e.note,'') AS note
          FROM days d
          LEFT JOIN sales_daily s ON s.day=d.day
          LEFT JOIN expense_daily x ON x.day=d.day
          LEFT JOIN cash_flow_entries e ON e.entry_date=d.day
        )
        SELECT to_char(day,'YYYY-MM-DD') AS date,
               petty_cash,daily_income,expenses,
               (petty_cash + daily_income - expenses)::numeric AS expected_total,
               actual,
               CASE WHEN actual IS NULL THEN NULL ELSE (actual-(petty_cash+daily_income-expenses))::numeric END AS variance,
               cash,gcash,other,cash_txns,gcash_txns,other_txns,
               (cash+gcash)::numeric AS cash_plus_gcash,
               transaction_count,credit_to_bank,debit_from_bank,note,
               SUM(credit_to_bank-debit_from_bank) OVER (ORDER BY day)::numeric AS running_bank_total
        FROM base
        ORDER BY day ASC
      `, [from, to, defaultPettyCash]);

      res.json({
        from,
        to,
        defaultPettyCash,
        rows: rows.map(row => ({
          date: row.date,
          pettyCash: numberOrZero(row.petty_cash),
          dailyIncome: numberOrZero(row.daily_income),
          expenses: numberOrZero(row.expenses),
          expectedTotal: numberOrZero(row.expected_total),
          actual: row.actual == null ? null : Number(row.actual),
          variance: row.variance == null ? null : Number(row.variance),
          cash: numberOrZero(row.cash),
          gcash: numberOrZero(row.gcash),
          other: numberOrZero(row.other),
          cashTxns: Number(row.cash_txns || 0),
          gcashTxns: Number(row.gcash_txns || 0),
          otherTxns: Number(row.other_txns || 0),
          cashPlusGcash: numberOrZero(row.cash_plus_gcash),
          transactionCount: Number(row.transaction_count || 0),
          creditToBank: numberOrZero(row.credit_to_bank),
          debitFromBank: numberOrZero(row.debit_from_bank),
          runningBankTotal: numberOrZero(row.running_bank_total),
          note: row.note || "",
        })),
      });
    } catch (error) { next(error); }
  });

  app.patch("/api/admin/cash-flow/settings", async (req, res, next) => {
    try {
      await ensureSchema();
      const amount = Number(req.body.defaultPettyCash);
      if (!Number.isFinite(amount) || amount < 0 || amount > 10000000) {
        return res.status(400).json({ error: "Enter a valid default petty cash amount." });
      }
      const { rows } = await pool.query(`
        UPDATE cash_flow_settings
        SET default_petty_cash=$1,updated_at=NOW()
        WHERE id=1
        RETURNING default_petty_cash,updated_at
      `, [amount]);
      res.json({ defaultPettyCash: Number(rows[0].default_petty_cash), updatedAt: rows[0].updated_at });
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
        if (!Number.isFinite(n) || n < 0 || n > 10000000) throw new Error("Enter valid cash-flow amounts.");
        return n;
      };
      const pettyCashOverride = nullableMoney(req.body.pettyCashOverride);
      const actual = nullableMoney(req.body.actual);
      const creditToBank = nullableMoney(req.body.creditToBank) ?? 0;
      const debitFromBank = nullableMoney(req.body.debitFromBank) ?? 0;
      const note = String(req.body.note || "").trim().slice(0, 500);

      const { rows } = await pool.query(`
        INSERT INTO cash_flow_entries(entry_date,petty_cash_override,actual,credit_to_bank,debit_from_bank,note,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,NOW())
        ON CONFLICT(entry_date) DO UPDATE SET
          petty_cash_override=EXCLUDED.petty_cash_override,
          actual=EXCLUDED.actual,
          credit_to_bank=EXCLUDED.credit_to_bank,
          debit_from_bank=EXCLUDED.debit_from_bank,
          note=EXCLUDED.note,
          updated_at=NOW()
        RETURNING *
      `, [date, pettyCashOverride, actual, creditToBank, debitFromBank, note]);
      res.json(rows[0]);
    } catch (error) {
      if (/valid cash-flow amounts/.test(error.message)) return res.status(400).json({ error: error.message });
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
