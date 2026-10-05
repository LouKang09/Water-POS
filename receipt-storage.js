const crypto = require("crypto");
const pg = require("pg");
const sharp = require("sharp");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");

const endpoint = process.env.RECEIPT_S3_ENDPOINT || "";
const bucket = process.env.RECEIPT_S3_BUCKET || "";
const region = process.env.RECEIPT_S3_REGION || "auto";
const accessKeyId = process.env.RECEIPT_S3_ACCESS_KEY_ID || "";
const secretAccessKey = process.env.RECEIPT_S3_SECRET_ACCESS_KEY || "";
const enabled = Boolean(endpoint && bucket && accessKeyId && secretAccessKey);

const s3 = enabled ? new S3Client({
  endpoint,
  region,
  forcePathStyle: false,
  credentials: { accessKeyId, secretAccessKey }
}) : null;

const nativeQuery = pg.Client.prototype.query;
const MIGRATION_LOCK = 92610061;
let migrationStarted = false;

function rawQuery(client, ...args) {
  return nativeQuery.apply(client, args);
}

function isBuffer(value) {
  return Buffer.isBuffer(value) && value.length > 0;
}

function safeMime(value) {
  const mime = String(value || "").toLowerCase();
  return mime.startsWith("image/") ? mime : "image/jpeg";
}

async function optimizeImage(buffer, mime) {
  const originalSize = buffer.length;
  try {
    const optimized = await sharp(buffer, { failOn: "none" })
      .rotate()
      .resize({ width: 1800, height: 2400, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 78, effort: 4, smartSubsample: true })
      .toBuffer();

    // Keep the original when it is already smaller than the optimized copy.
    if (optimized.length >= originalSize * 0.95) {
      return { buffer, mime: safeMime(mime), originalSize };
    }
    return { buffer: optimized, mime: "image/webp", originalSize };
  } catch (error) {
    console.warn("Receipt image optimization skipped:", error.message);
    return { buffer, mime: safeMime(mime), originalSize };
  }
}

function extForMime(mime) {
  if (mime === "image/webp") return "webp";
  if (mime === "image/png") return "png";
  if (mime === "image/heic" || mime === "image/heif") return "heic";
  return "jpg";
}

async function storeReceipt(buffer, mime, folder) {
  if (!enabled || !isBuffer(buffer)) return null;
  const optimized = await optimizeImage(buffer, mime);
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const key = `${folder}/${yyyy}/${mm}/${crypto.randomUUID()}.${extForMime(optimized.mime)}`;
  const sha256 = crypto.createHash("sha256").update(optimized.buffer).digest("hex");

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: optimized.buffer,
    ContentType: optimized.mime,
    Metadata: {
      sha256,
      originalbytes: String(optimized.originalSize),
      storedbytes: String(optimized.buffer.length)
    }
  }));

  return {
    key,
    mime: optimized.mime,
    size: optimized.buffer.length,
    originalSize: optimized.originalSize,
    sha256
  };
}

async function readBody(body) {
  if (!body) return null;
  if (typeof body.transformToByteArray === "function") {
    return Buffer.from(await body.transformToByteArray());
  }
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function fetchReceipt(key) {
  if (!enabled || !key) return null;
  const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return {
    buffer: await readBody(result.Body),
    mime: result.ContentType || "image/webp"
  };
}

function appendReceiptSchema(sql) {
  if (!/CREATE TABLE IF NOT EXISTS (?:admin_users|tenant_accounts)/i.test(sql)) return sql;
  return `${sql}\n
    ALTER TABLE IF EXISTS sales ADD COLUMN IF NOT EXISTS receipt_key TEXT;
    ALTER TABLE IF EXISTS sales ADD COLUMN IF NOT EXISTS receipt_size INTEGER;
    ALTER TABLE IF EXISTS sales ADD COLUMN IF NOT EXISTS receipt_original_size INTEGER;
    ALTER TABLE IF EXISTS sales ADD COLUMN IF NOT EXISTS receipt_sha256 TEXT;
    ALTER TABLE IF EXISTS delivery_queue ADD COLUMN IF NOT EXISTS receipt_key TEXT;
    ALTER TABLE IF EXISTS delivery_queue ADD COLUMN IF NOT EXISTS receipt_size INTEGER;
    ALTER TABLE IF EXISTS delivery_queue ADD COLUMN IF NOT EXISTS receipt_original_size INTEGER;
    ALTER TABLE IF EXISTS delivery_queue ADD COLUMN IF NOT EXISTS receipt_sha256 TEXT;
  `;
}

function expandHasReceipt(sql) {
  return sql.replace(/([A-Za-z_][A-Za-z0-9_]*\.)?receipt_image\s+IS\s+NOT\s+NULL/gi, (_m, prefix = "") =>
    `(${prefix}receipt_image IS NOT NULL OR ${prefix}receipt_key IS NOT NULL)`
  );
}

function addSelectReceiptKey(sql) {
  if (!/^\s*SELECT/i.test(sql)) return sql;
  if (!/receipt_image/i.test(sql) || /receipt_key/i.test(sql)) return sql;
  if (!/FROM\s+(?:sales|delivery_queue)\b/i.test(sql)) return sql;
  return sql.replace(/receipt_image/i, "receipt_image,receipt_key");
}

function parseInsert(sql) {
  const match = sql.match(/INSERT\s+INTO\s+(sales|delivery_queue)\s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)/i);
  if (!match) return null;
  const table = match[1].toLowerCase();
  const columns = match[2].split(",").map(x => x.trim().replace(/\"/g, ""));
  const placeholders = match[3].split(",").map(x => x.trim());
  const imageColumn = columns.findIndex(x => x.toLowerCase() === "receipt_image");
  if (imageColumn < 0) return null;
  const imagePlaceholder = placeholders[imageColumn];
  const imageMatch = imagePlaceholder && imagePlaceholder.match(/^\$(\d+)$/);
  if (!imageMatch) return null;
  const mimeColumn = columns.findIndex(x => x.toLowerCase() === "receipt_mime");
  const mimeMatch = mimeColumn >= 0 ? placeholders[mimeColumn].match(/^\$(\d+)$/) : null;
  return {
    table,
    full: match[0],
    columnsText: match[2],
    valuesText: match[3],
    imageValueIndex: Number(imageMatch[1]) - 1,
    mimeValueIndex: mimeMatch ? Number(mimeMatch[1]) - 1 : -1
  };
}

async function externalizeInsert(sql, values) {
  if (!enabled || !Array.isArray(values)) return { sql, values };
  const parsed = parseInsert(sql);
  if (!parsed) return { sql, values };
  const image = values[parsed.imageValueIndex];
  if (!isBuffer(image)) return { sql, values };

  const currentMime = parsed.mimeValueIndex >= 0 ? values[parsed.mimeValueIndex] : "image/jpeg";
  const stored = await storeReceipt(image, currentMime, parsed.table === "sales" ? "sales" : "queue");
  if (!stored) return { sql, values };

  const nextValues = values.slice();
  nextValues[parsed.imageValueIndex] = null;
  if (parsed.mimeValueIndex >= 0) nextValues[parsed.mimeValueIndex] = stored.mime;

  const keyPos = nextValues.push(stored.key);
  const sizePos = nextValues.push(stored.size);
  const originalSizePos = nextValues.push(stored.originalSize);
  const hashPos = nextValues.push(stored.sha256);

  const replacement = `INSERT INTO ${parsed.table} (${parsed.columnsText},receipt_key,receipt_size,receipt_original_size,receipt_sha256) VALUES (${parsed.valuesText},$${keyPos},$${sizePos},$${originalSizePos},$${hashPos})`;
  return { sql: sql.replace(parsed.full, replacement), values: nextValues };
}

async function hydrateReceiptRows(result, sql) {
  if (!enabled || !result || !Array.isArray(result.rows) || !result.rows.length) return result;
  const shouldHydrate = /SELECT[\s\S]*(?:receipt_image|q\.\*)[\s\S]*FROM\s+(?:sales|delivery_queue|delivery_queue\s+q)/i.test(sql);
  if (!shouldHydrate) return result;

  for (const row of result.rows) {
    if (!row || row.receipt_image || !row.receipt_key) continue;
    try {
      const stored = await fetchReceipt(row.receipt_key);
      if (stored && stored.buffer) {
        row.receipt_image = stored.buffer;
        row.receipt_mime = row.receipt_mime || stored.mime;
      }
    } catch (error) {
      console.error("Unable to read receipt object", row.receipt_key, error.message);
    }
  }
  return result;
}

async function migrateTable(client, table, folder) {
  for (;;) {
    const selected = await rawQuery(client,
      `SELECT id,receipt_mime,receipt_image FROM ${table} WHERE receipt_image IS NOT NULL AND receipt_key IS NULL ORDER BY id LIMIT 10`
    );
    if (!selected.rows.length) break;

    for (const row of selected.rows) {
      if (!isBuffer(row.receipt_image)) continue;
      const stored = await storeReceipt(row.receipt_image, row.receipt_mime, folder);
      if (!stored) return;
      await rawQuery(client,
        `UPDATE ${table}
         SET receipt_key=$1,receipt_mime=$2,receipt_size=$3,receipt_original_size=$4,receipt_sha256=$5,receipt_image=NULL
         WHERE id=$6 AND receipt_key IS NULL`,
        [stored.key, stored.mime, stored.size, stored.originalSize, stored.sha256, row.id]
      );
      console.log(`Migrated ${table} receipt #${row.id}: ${stored.originalSize} -> ${stored.size} bytes`);
    }
  }
}

async function migrateLegacyReceipts(client) {
  if (!enabled || migrationStarted) return;
  migrationStarted = true;
  try {
    const lock = await rawQuery(client, "SELECT pg_try_advisory_lock($1) AS locked", [MIGRATION_LOCK]);
    if (!lock.rows[0]?.locked) return;
    try {
      await migrateTable(client, "sales", "sales");
      await migrateTable(client, "delivery_queue", "queue");
    } finally {
      await rawQuery(client, "SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK]).catch(() => {});
    }
  } catch (error) {
    console.error("Legacy receipt migration skipped:", error.message);
  }
}

pg.Client.prototype.query = function receiptStorageQuery(config, values, callback) {
  let text = typeof config === "string" ? config : config && config.text;
  const inputValues = typeof config === "string" ? values : config && config.values;
  const cb = typeof callback === "function" ? callback : (typeof values === "function" ? values : null);

  if (!text || typeof text !== "string") {
    return nativeQuery.apply(this, arguments);
  }

  const client = this;
  const run = async () => {
    const isInit = /CREATE TABLE IF NOT EXISTS (?:admin_users|tenant_accounts)/i.test(text);
    let sql = appendReceiptSchema(text);
    sql = expandHasReceipt(sql);
    sql = addSelectReceiptKey(sql);

    const transformed = await externalizeInsert(sql, inputValues);
    let result;
    if (typeof config === "string") {
      result = await rawQuery(client, transformed.sql, transformed.values);
    } else {
      result = await rawQuery(client, { ...config, text: transformed.sql, values: transformed.values });
    }
    result = await hydrateReceiptRows(result, transformed.sql);

    if (isInit) await migrateLegacyReceipts(client);
    return result;
  };

  if (cb) {
    run().then(result => cb(null, result), error => cb(error));
    return;
  }
  return run();
};

if (enabled) {
  console.log("Receipt storage enabled: private object storage + image compression");
} else {
  console.warn("Receipt storage disabled: S3 environment variables are not configured");
}
