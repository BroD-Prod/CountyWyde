const db = require("./db");

function normalizeCounty(value) {
  return String(value || "").trim();
}

function normalizeState(value) {
  return String(value || "").trim();
}

function isCountyFormatValid(value) {
  const county = normalizeCounty(value);
  return /^[A-Za-z][A-Za-z\s'\-]{1,58}[A-Za-z]$/.test(county);
}

async function getRegisteredCounties(state) {
  const selectedState = normalizeState(state);
  const rows = selectedState
    ? await db
      .prepare(
        `SELECT DISTINCT a.county
             FROM accounts a
             JOIN states st ON st.id = a.state_id
             WHERE a.county IS NOT NULL
               AND TRIM(a.county) <> ''
               AND (LOWER(st.name) = LOWER(?) OR UPPER(st.abbreviation) = UPPER(?))
             ORDER BY a.county ASC`,
      )
      .all(selectedState, selectedState)
    : await db
      .prepare(
        "SELECT DISTINCT county FROM accounts WHERE county IS NOT NULL AND TRIM(county) <> '' ORDER BY county ASC",
      )
      .all();

  return rows.map((row) => row.county);
}

async function getRegisteredStates() {
  const rows = await db
    .prepare("SELECT id, name, abbreviation FROM states ORDER BY name ASC")
    .all();

  return rows;
}

async function isRegisteredCounty(value) {
  const county = normalizeCounty(value);
  if (!county) {
    return false;
  }

  const row = await db
    .prepare("SELECT 1 FROM accounts WHERE county = ? LIMIT 1")
    .get(county);

  return Boolean(row);
}

async function isRegisteredState(value) {
  const state = String(value || "").trim();
  if (!state) {
    return false;
  }

  const row = await db
    .prepare(
      "SELECT 1 FROM states WHERE LOWER(name) = LOWER(?) OR UPPER(abbreviation) = UPPER(?) LIMIT 1",
    )
    .get(state, state);

  return Boolean(row);
}

module.exports = {
  normalizeCounty,
  normalizeState,
  isCountyFormatValid,
  getRegisteredCounties,
  getRegisteredStates,
  isRegisteredCounty,
  isRegisteredState,
};
