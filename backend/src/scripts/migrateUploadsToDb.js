/**
 * migrateUploadsToDb.js
 *
 * One-time migration: reads existing uploads.json and inserts all records
 * into the upload_chunks SQLite table. Safe to re-run — uses INSERT OR IGNORE.
 *
 * Usage:
 *   node src/scripts/migrateUploadsToDb.js
 */

const fs = require("node:fs");
const path = require("node:path");

// Bootstrap db before uploadStore so the table is created first
require("../lib/db");
const { insertChunks } = require("../lib/uploadStore");

const DATA_FILE = path.join(__dirname, "../../data/uploads.json");
const BATCH_SIZE = 500;

function main() {
    if (!fs.existsSync(DATA_FILE)) {
        console.log("uploads.json not found — nothing to migrate.");
        return;
    }

    let raw;
    try {
        raw = fs.readFileSync(DATA_FILE, "utf8");
    } catch (err) {
        console.error("Failed to read uploads.json:", err.message);
        process.exitCode = 1;
        return;
    }

    let records;
    try {
        const parsed = JSON.parse(raw);
        records = Array.isArray(parsed) ? parsed : [];
    } catch {
        console.error("uploads.json contains invalid JSON.");
        process.exitCode = 1;
        return;
    }

    if (records.length === 0) {
        console.log("uploads.json is empty — nothing to migrate.");
        return;
    }

    console.log(`Migrating ${records.length} records from uploads.json…`);

    let total = 0;
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
        const batch = records.slice(i, i + BATCH_SIZE);
        insertChunks(batch);
        total += batch.length;
        console.log(`  [${Math.min(i + BATCH_SIZE, records.length)}/${records.length}] inserted`);
    }

    console.log(`\nMigration complete. ${total} records written to upload_chunks.`);
    console.log("You can now safely archive or delete uploads.json.");
}

main();
