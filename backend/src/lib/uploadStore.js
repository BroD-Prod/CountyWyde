const fs = require('node:fs/promises');
const path = require('node:path');

const DATA_FILE = path.join(__dirname, '../../data/uploads.json');

async function ensureDataFile() {
    const dataDir = path.dirname(DATA_FILE);
    await fs.mkdir(dataDir, { recursive: true });

    try {
        await fs.access(DATA_FILE);
    } catch {
        await fs.writeFile(DATA_FILE, '[]', 'utf8');
    }
}

async function readUploads() {
    await ensureDataFile();
    const raw = await fs.readFile(DATA_FILE, 'utf8');

    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

async function writeUploads(uploads) {
    await ensureDataFile();
    await fs.writeFile(DATA_FILE, JSON.stringify(uploads, null, 2), 'utf8');
}

module.exports = {
    readUploads,
    writeUploads,
};
