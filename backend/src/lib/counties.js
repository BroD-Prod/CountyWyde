function normalizeCounty(value) {
  return String(value || "").trim();
}

function isValidCounty(value) {
  const county = normalizeCounty(value);
  return COUNTIES.includes(county);
}

module.exports = {
  COUNTIES,
  normalizeCounty,
  isValidCounty,
};
