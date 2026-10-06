const express = require("express");
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

let schemaPromise = null;

async function ensureBankPettySchema() {
  if (schemaPromise) return schemaPromise;
  schemaPromise = (async () => {
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

      ALTER TABLE cash_flow_settings
        ADD COLUMN IF NOT EXISTS default_bank_petty NUMERIC(12,2) NOT NULL DEFAULT 0;
      ALTER TABLE cash_flow_entries
        ADD COLUMN IF NOT EXISTS bank_petty_override NUMERIC(12,2);
    `);

    await pool.query(`
      ALTER TABLE cash_flow_settings DROP CONSTRAINT IF EXISTS cash_flow_settings_default_bank_petty_check;
      ALTER TABLE cash_flow_settings
        ADD CONSTRAINT cash_flow_settings_default_bank_petty_check
        CHECK (default_bank_petty >= 0);
      ALTER TABLE cash_flow_entries DROP CONSTRAINT IF EXISTS cash_flow_entries_bank_petty_override_check;
      ALTER TABLE cash_flow_entries
        ADD CONSTRAINT cash_flow_entries_bank_petty_override_check
        CHECK (bank_petty_override IS NULL OR bank_petty_override >= 0);
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

function moneyValue(value, nullable = false) {
  if (nullable && (value === "" || value == null)) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1000000000) {
    throw new Error("Enter a valid bank petty amount.");
  }
  return number;
}

function dateList(from, to) {
  const list = [];
  const start = new Date(from + "T00:00:00Z");
  const end = new Date(to + "T00:00:00Z");
  for (let cursor = start; cursor <= end; cursor = new Date(cursor.getTime() + 86400000)) {
    list.push(cursor.toISOString().slice(0, 10));
  }
  return list;
}

function addRoutes(app) {
  app.get("/api/admin/cash-flow-bank", async (req, res, next) => {
    try {
      await ensureBankPettySchema();
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
      const from = cleanDate(req.query.from) || today.slice(0, 8) + "01";
      const to = cleanDate(req.query.to) || today;
      if (from > to) return res.status(400).json({ error: "From date cannot be after To date." });

      const settings = await pool.query(
        "SELECT default_bank_petty FROM cash_flow_settings WHERE id=1"
      );
      const defaultBankPetty = Number(settings.rows[0]?.default_bank_petty || 0);

      // Read every bank movement up to the requested end date so the running balance
      // is stable even when the user prints/views a range that starts mid-month.
      const entries = await pool.query(`
        SELECT entry_date::text AS date,
               bank_petty_override,
               COALESCE(credit_to_bank,0)::numeric AS credit_to_bank,
               COALESCE(debit_from_bank,0)::numeric AS debit_from_bank
        FROM cash_flow_entries
        WHERE entry_date <= $1::date
        ORDER BY entry_date ASC
      `, [to]);

      const byDate = new Map(entries.rows.map(row => [String(row.date).slice(0, 10), row]));
      const earliest = entries.rows.length
        ? String(entries.rows[0].date).slice(0, 10)
        : from;
      const calculationStart = earliest < from ? earliest : from;

      let running = defaultBankPetty;
      const output = [];
      for (const date of dateList(calculationStart, to)) {
        const entry = byDate.get(date) || null;
        const override = entry?.bank_petty_override == null ? null : Number(entry.bank_petty_override);
        const opening = override == null ? running : override;
        const credit = Number(entry?.credit_to_bank || 0);
        const debit = Number(entry?.debit_from_bank || 0);
        running = opening + credit - debit;

        if (date >= from) {
          output.push({
            date,
            bankPetty: opening,
            bankPettyOverride: override,
            creditToBank: credit,
            debitFromBank: debit,
            runningBankTotal: running,
          });
        }
      }

      res.json({ from, to, defaultBankPetty, rows: output });
    } catch (error) {
      next(error);
    }
  });

  app.patch("/api/admin/cash-flow-bank/settings", async (req, res, next) => {
    try {
      await ensureBankPettySchema();
      const defaultBankPetty = moneyValue(req.body.defaultBankPetty);
      const { rows } = await pool.query(`
        UPDATE cash_flow_settings
        SET default_bank_petty=$1,updated_at=NOW()
        WHERE id=1
        RETURNING default_bank_petty,updated_at
      `, [defaultBankPetty]);
      res.json({
        defaultBankPetty: Number(rows[0].default_bank_petty),
        updatedAt: rows[0].updated_at,
      });
    } catch (error) {
      if (/valid bank petty amount/.test(error.message)) {
        return res.status(400).json({ error: error.message });
      }
      next(error);
    }
  });

  app.put("/api/admin/cash-flow-bank/:date", async (req, res, next) => {
    try {
      await ensureBankPettySchema();
      const date = cleanDate(req.params.date);
      if (!date) return res.status(400).json({ error: "Choose a valid cash-flow date." });
      const bankPettyOverride = moneyValue(req.body.bankPettyOverride, true);

      const { rows } = await pool.query(`
        INSERT INTO cash_flow_entries(entry_date,bank_petty_override,updated_at)
        VALUES($1,$2,NOW())
        ON CONFLICT (entry_date) DO UPDATE SET
          bank_petty_override=EXCLUDED.bank_petty_override,
          updated_at=NOW()
        RETURNING entry_date::text AS date,bank_petty_override,updated_at
      `, [date, bankPettyOverride]);

      res.json({
        date: String(rows[0].date).slice(0, 10),
        bankPettyOverride: rows[0].bank_petty_override == null ? null : Number(rows[0].bank_petty_override),
        updatedAt: rows[0].updated_at,
      });
    } catch (error) {
      if (/valid bank petty amount/.test(error.message)) {
        return res.status(400).json({ error: error.message });
      }
      next(error);
    }
  });
}

const currentListen = express.application.listen;
express.application.listen = function(...args) {
  addRoutes(this);
  ensureBankPettySchema().catch(error => console.error("Bank petty schema error:", error));
  return currentListen.apply(this, args);
};
