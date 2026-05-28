const bcrypt = require('bcrypt');
const crypto = require('crypto');
const db = require('../lib/db');
const helperController = require('./helperController');
const {
    normalizeCounty,
    isCountyFormatValid,
    getRegisteredCounties,
    getRegisteredStates,
} = require('../lib/countyRegistry');

const SALT_ROUNDS = 12;
const MAX_JSON_BYTES = 1 * 1024 * 1024;
const SESSION_MAX_AGE_SECONDS = 86400;
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SECONDS * 1000;

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const LOGIN_RATE_LIMIT = 10;
const SIGNUP_RATE_LIMIT = 10;
const DELETE_RATE_LIMIT = 10;
const UPDATE_RATE_LIMIT = 30;
const rateWindow = new Map();

function getClientIp(req) {
    return req.socket?.remoteAddress || 'unknown';
}

function checkRateLimit(req, bucket, limit, res) {
    const now = Date.now();
    const key = `${bucket}:${getClientIp(req)}`;
    const state = rateWindow.get(key);

    if (!state || state.resetAt <= now) {
        rateWindow.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
        return false;
    }

    state.count += 1;
    if (state.count > limit) {
        res.statusCode = 429;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Too many requests, please retry shortly' }));
        return true;
    }

    return false;
}

function buildSessionCookie(token) {
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    return `session_token=${token}; HttpOnly; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; SameSite=Strict${secure}`;
}

function buildClearSessionCookie() {
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    return `session_token=; HttpOnly; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Strict${secure}`;
}

function normalizeState(value) {
    return String(value || '').trim();
}

function resolveState(input) {
    const stateInput = normalizeState(input);
    if (!stateInput) {
        return null;
    }

    return db.prepare(
        'SELECT id, name, abbreviation FROM states WHERE LOWER(name) = LOWER(?) OR UPPER(abbreviation) = UPPER(?) LIMIT 1'
    ).get(stateInput, stateInput);
}

async function createAccount(req, res) {
    if (checkRateLimit(req, 'signup', SIGNUP_RATE_LIMIT, res)) {
        return;
    }

    try {
        const { username, password, county, state } = await helperController.parseJsonBody(req, MAX_JSON_BYTES);
        const selectedCounty = normalizeCounty(county);
        const selectedState = resolveState(state);

        if (!username || !password || !selectedCounty || !state) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Username, password, county, and state are required' }));
            return;
        }

        if (!isCountyFormatValid(selectedCounty)) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Please enter a valid county name' }));
            return;
        }

        if (!selectedState) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Please select a valid state' }));
            return;
        }

        const existing = db.prepare('SELECT 1 FROM accounts WHERE username = ?').get(username);
        if (existing) {
            res.statusCode = 409;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Username already exists' }));
            return;
        }

        const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
        db.prepare('INSERT INTO accounts (username, password_hash, county, state_id, approved) VALUES (?, ?, ?, ?, 0)')
            .run(username, hashedPassword, selectedCounty, selectedState.id);

        res.statusCode = 201;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
            message: 'Signup received. Your account is pending approval.',
            approved: false,
            county: selectedCounty,
            state: {
                name: selectedState.name,
                abbreviation: selectedState.abbreviation,
            },
        }));
    } catch (error) {
        res.statusCode = error.message === 'Payload too large' ? 413 : 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error.message || 'Invalid JSON body' }));
    }
}

async function deleteAccount(req, res) {
    if (checkRateLimit(req, 'delete-account', DELETE_RATE_LIMIT, res)) {
        return;
    }

    const authUser = helperController.getAuthenticatedUser(req, { includeState: true, cleanupExpired: true });
    if (!authUser) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'You must be signed in' }));
        return;
    }

    try {
        const { username, password } = await helperController.parseJsonBody(req, MAX_JSON_BYTES);

        if (!password) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Password is required' }));
            return;
        }

        if (username && username !== authUser.username) {
            res.statusCode = 403;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Forbidden' }));
            return;
        }

        const existing = db.prepare('SELECT * FROM accounts WHERE id = ?').get(authUser.id);
        if (!existing) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Account not found' }));
            return;
        }

        const validPassword = await bcrypt.compare(password, existing.password_hash);
        if (!validPassword) {
            res.statusCode = 401;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Invalid password' }));
            return;
        }

        db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
        db.prepare('DELETE FROM accounts WHERE id = ?').run(existing.id);

        res.setHeader('Set-Cookie', buildClearSessionCookie());
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ message: `Account deleted for ${existing.username}` }));
    } catch (error) {
        res.statusCode = error.message === 'Payload too large' ? 413 : 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error.message || 'Invalid JSON body' }));
    }
}

async function login(req, res) {
    if (checkRateLimit(req, 'login', LOGIN_RATE_LIMIT, res)) {
        return;
    }

    try {
        const { username, password } = await helperController.parseJsonBody(req, MAX_JSON_BYTES);

        if (!username || !password) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Username and password are required' }));
            return;
        }

        const account = db.prepare('SELECT * FROM accounts WHERE username = ?').get(username);
        if (!account) {
            res.statusCode = 401;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Invalid credentials' }));
            return;
        }

        const validPassword = await bcrypt.compare(password, account.password_hash);
        if (!validPassword) {
            res.statusCode = 401;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Invalid credentials' }));
            return;
        }

        if (!account.approved) {
            res.statusCode = 403;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Your account is pending approval' }));
            return;
        }

        const sessionToken = crypto.randomBytes(64).toString('hex');
        const tokenHash = helperController.hashToken(sessionToken);
        const expiresAt = Date.now() + SESSION_MAX_AGE_MS;
        const createdAt = Date.now();

        db.prepare('INSERT INTO sessions (user_id, token, expires_at, created_at) VALUES (?, ?, ?, ?)')
            .run(account.id, tokenHash, expiresAt, createdAt);

        res.setHeader('Set-Cookie', buildSessionCookie(sessionToken));
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ message: `Login successful for ${username}` }));
    } catch (error) {
        res.statusCode = error.message === 'Payload too large' ? 413 : 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error.message || 'Invalid JSON body' }));
    }
}

function getSession(req, res) {
    const authUser = helperController.getAuthenticatedUser(req, { includeState: true, cleanupExpired: true });
    if (!authUser) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ authenticated: false }));
        return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
        authenticated: true,
        user: {
            id: authUser.id,
            username: authUser.username,
            county: authUser.county,
            state: {
                name: authUser.state_name,
                abbreviation: authUser.state_abbreviation,
            },
        },
    }));
}

function getAccount(req, res) {
    const authUser = helperController.getAuthenticatedUser(req, { includeState: true, cleanupExpired: true });
    if (!authUser) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'You must be signed in' }));
        return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
        account: authUser.username,
        county: authUser.county,
        state: {
            name: authUser.state_name,
            abbreviation: authUser.state_abbreviation,
        },
    }));
}

function getCounties(req, res) {
    try {
        const requestUrl = new URL(req.url, 'http://localhost');
        const counties = getRegisteredCounties(requestUrl.searchParams.get('state'));
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ counties }));
    } catch {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Failed to load counties' }));
    }
}

function getStates(req, res) {
    try {
        const states = getRegisteredStates();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ states }));
    } catch {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Failed to load states' }));
    }
}

async function updateAccount(req, res) {
    if (checkRateLimit(req, 'update-account', UPDATE_RATE_LIMIT, res)) {
        return;
    }

    const authUser = helperController.getAuthenticatedUser(req, { includeState: true, cleanupExpired: true });
    if (!authUser) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'You must be signed in' }));
        return;
    }

    try {
        const { county, state } = await helperController.parseJsonBody(req, MAX_JSON_BYTES);
        const selectedCounty = normalizeCounty(county);
        const resolvedState = resolveState(state);

        if (!selectedCounty || !state) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'County and state are required' }));
            return;
        }

        if (!isCountyFormatValid(selectedCounty)) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Please enter a valid county name' }));
            return;
        }

        if (!resolvedState) {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Please select a valid state' }));
            return;
        }

        db.prepare('UPDATE accounts SET county = ?, state_id = ? WHERE id = ?')
            .run(selectedCounty, resolvedState.id, authUser.id);

        db.prepare('UPDATE sessions SET expires_at = ? WHERE user_id = ?')
            .run(Date.now() + SESSION_MAX_AGE_MS, authUser.id);

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
            message: `Account updated for ${authUser.username}`,
            county: selectedCounty,
            state: {
                name: resolvedState.name,
                abbreviation: resolvedState.abbreviation,
            },
        }));
    } catch (error) {
        res.statusCode = error.message === 'Payload too large' ? 413 : 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error.message || 'Invalid JSON body' }));
    }
}

const ADMIN_KEY = String(process.env.ADMIN_KEY || '').trim();

function isAdminRequest(req) {
    if (!ADMIN_KEY) return false;
    return req.headers['x-admin-key'] === ADMIN_KEY;
}

function getPendingAccounts(req, res) {
    if (!isAdminRequest(req)) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
    }
    try {
        const rows = db.prepare(
            `SELECT a.id, a.username, a.county, st.name AS state_name, st.abbreviation AS state_abbreviation
             FROM accounts a
             JOIN states st ON st.id = a.state_id
             WHERE a.approved = 0
             ORDER BY a.id ASC`
        ).all();
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ pending: rows }));
    } catch {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Failed to load pending accounts' }));
    }
}

function approveAccount(req, res) {
    if (!isAdminRequest(req)) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', () => {
        try {
            const { id } = JSON.parse(body || '{}');
            if (!id) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Account id is required' }));
                return;
            }
            const account = db.prepare('SELECT id, username, approved FROM accounts WHERE id = ?').get(id);
            if (!account) {
                res.statusCode = 404;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Account not found' }));
                return;
            }
            db.prepare('UPDATE accounts SET approved = 1 WHERE id = ?').run(id);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ message: `Approved ${account.username}` }));
        } catch {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        }
    });
}

function rejectAccount(req, res) {
    if (!isAdminRequest(req)) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk.toString(); });
    req.on('end', () => {
        try {
            const { id } = JSON.parse(body || '{}');
            if (!id) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Account id is required' }));
                return;
            }
            const account = db.prepare('SELECT id, username FROM accounts WHERE id = ? AND approved = 0').get(id);
            if (!account) {
                res.statusCode = 404;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Pending account not found' }));
                return;
            }
            db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
            db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ message: `Rejected and removed ${account.username}` }));
        } catch {
            res.statusCode = 400;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        }
    });
}

module.exports = {
    login,
    createAccount,
    deleteAccount,
    getAccount,
    getSession,
    getCounties,
    getStates,
    updateAccount,
    getPendingAccounts,
    approveAccount,
    rejectAccount,
};
