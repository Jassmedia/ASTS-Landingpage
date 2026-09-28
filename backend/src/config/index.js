const path = require('path');
const { isValidTimeZone } = require('../utils/timeZone');

// Load backend/.env when it exists. Variables already set in the real
// environment (e.g. on a host like Vercel) take precedence over the file.
try {
  process.loadEnvFile(path.resolve(__dirname, '../../.env'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

const env = process.env;

const toList = value =>
  value.split(',').map(item => item.trim()).filter(Boolean);

function parseInteger(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = env[name];
  if (value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`Invalid ${name} "${value}". Use a whole number between ${min} and ${max}.`);
  }
  return number;
}

const reportTimeZone = env.REPORT_TIMEZONE || 'Asia/Kolkata';
if (!isValidTimeZone(reportTimeZone)) {
  throw new Error(`Invalid REPORT_TIMEZONE "${reportTimeZone}". Use an IANA name like Asia/Kolkata.`);
}

const config = Object.freeze({
  env: env.NODE_ENV || 'development',
  port: parseInteger('PORT', 5000, { min: 1, max: 65535 }),
  // Landing page + registration site. Locally 127.0.0.1:8080 stands in for register.aststraining.com.
  corsOrigins: toList(env.FRONTEND_URL || 'http://localhost:8080,http://127.0.0.1:8080,http://localhost:4173'),
  bodyLimit: env.BODY_LIMIT || '10kb',
  // Number of proxies in front of the app (1 on Vercel), so rate limits see the real client IP
  trustProxy: parseInteger('TRUST_PROXY', 0, { max: 10 }),

  // Server-side only. Never send these to the browser.
  supabase: Object.freeze({
    url: (env.SUPABASE_URL || '').trim(),
    serviceRoleKey: (env.SUPABASE_SERVICE_ROLE_KEY || '').trim()
  }),

  // Protects the dashboard and the registration admin endpoints
  adminApiKey: (env.ADMIN_API_KEY || '').trim(),

  googleSheets: Object.freeze({
    spreadsheetId: (env.GOOGLE_SHEETS_SPREADSHEET_ID || '').trim(),
    clientEmail: (env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '').trim(),
    // .env files store the key on one line with literal \n sequences
    privateKey: (env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim(),
    keyFile: (env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || '').trim()
  }),

  // Dates in Google Sheets are written in this time zone
  reportTimeZone,

  rateLimit: Object.freeze({
    trackPerMinute: parseInteger('RATE_LIMIT_TRACK_PER_MIN', 120, { min: 1 }),
    registrationsPer10Min: parseInteger('RATE_LIMIT_REGISTRATIONS_PER_10_MIN', 10, { min: 1 })
  })
});

module.exports = config;
