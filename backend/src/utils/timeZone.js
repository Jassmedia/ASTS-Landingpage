// True for IANA time zone names such as "Asia/Kolkata" or "UTC"
function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return true;
  } catch {
    return false;
  }
}

module.exports = { isValidTimeZone };
