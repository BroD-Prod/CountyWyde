const COUNTIES = [
    'Alameda',
    'Contra Costa',
    'Fresno',
    'Los Angeles',
    'Marin',
    'Orange',
    'Riverside',
    'Sacramento',
    'San Bernardino',
    'San Diego',
    'San Francisco',
    'San Joaquin',
    'San Mateo',
    'Santa Clara',
    'Sonoma',
];

function normalizeCounty(value) {
    return String(value || '').trim();
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
