const { JWT } = require('google-auth-library');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

/**
 * Minimal Google Sheets API v4 client, authenticated as a service account.
 * Credentials come from environment variables (or a key file path) and are
 * never logged or sent anywhere except Google's token endpoint.
 */
function createGoogleSheetsClient({ spreadsheetId, clientEmail, privateKey, keyFile }) {
  const auth = keyFile
    ? new JWT({ keyFile, scopes: SCOPES })
    : new JWT({ email: clientEmail, key: privateKey, scopes: SCOPES });

  const base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;

  async function call(method, path, data) {
    const res = await auth.request({ url: base + path, method, data });
    return res.data;
  }

  return {
    getSpreadsheet: () =>
      call('GET', '?fields=sheets(properties(sheetId,title),conditionalFormats)'),
    batchUpdate: requests => call('POST', ':batchUpdate', { requests }),
    clearRanges: ranges => call('POST', '/values:batchClear', { ranges }),
    // RAW: values are stored exactly as sent, so text like "=SUM()" or a
    // phone number is never turned into a formula or a number
    writeRanges: data => call('POST', '/values:batchUpdate', { valueInputOption: 'RAW', data }),
    appendRows: (range, values) =>
      call('POST', `/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, { values })
  };
}

/** Returns a client when Google Sheets is configured, otherwise null. */
function createGoogleSheetsClientFromConfig(sheetsConfig, logger = console) {
  const { spreadsheetId, clientEmail, privateKey, keyFile } = sheetsConfig;
  if (!spreadsheetId) return null;
  if (!keyFile && !(clientEmail && privateKey)) {
    logger.warn('[sheets] GOOGLE_SHEETS_SPREADSHEET_ID is set but service-account credentials are missing. Google Sheets sync is off.');
    return null;
  }
  return createGoogleSheetsClient(sheetsConfig);
}

module.exports = { createGoogleSheetsClient, createGoogleSheetsClientFromConfig };
