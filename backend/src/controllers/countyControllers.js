const db = require('../lib/db');

function getCounties(req, res) {
    try {
        const counties = db.prepare('SELECT name FROM counties ORDER BY name ASC').all();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ counties: counties.map((row) => row.name) }));
    } catch {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Failed to fetch counties' }));
    }
}

function countyExists(name) {
    const county = String(name || '').trim();
    if (!county) return false;

    const row = db.prepare('SELECT name FROM counties WHERE name = ?').get(county);
    return Boolean(row);
}

module.exports = {
    getCounties,
    countyExists,
};
