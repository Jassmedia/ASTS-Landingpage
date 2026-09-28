// Postgres timestamps -> "2026-09-28T06:34:57.923Z"
const toIso = value => (value ? new Date(value).toISOString() : null);

// { from: x, city: undefined } -> { p_from: x } (only the allowed keys, no undefined values)
function filterArgs(filters, allowed) {
  const args = {};
  for (const key of allowed) {
    if (filters[key] !== undefined && filters[key] !== null && filters[key] !== '') {
      args[`p_${key}`] = filters[key];
    }
  }
  return args;
}

module.exports = { toIso, filterArgs };
