// Derives coarse, non-identifying details about a visit. Only the results
// ("mobile", "google") are stored, never the raw user agent, IP or referrer.

// Automated browsers that run JavaScript and would otherwise inflate counts
const BOT_PATTERN = /bot\b|crawler|spider|slurp|headlesschrome|lighthouse|pagespeed|prerender|phantomjs/i;

const REFERRER_SOURCES = [
  [/(^|\.)google\./, 'google'],
  [/(^|\.)bing\.com$/, 'bing'],
  [/(^|\.)yahoo\./, 'yahoo'],
  [/(^|\.)duckduckgo\.com$/, 'duckduckgo'],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, 'facebook'],
  [/(^|\.)instagram\.com$/, 'instagram'],
  [/(^|\.)(linkedin\.com|lnkd\.in)$/, 'linkedin'],
  [/(^|\.)(youtube\.com|youtu\.be)$/, 'youtube'],
  [/(^|\.)(twitter\.com|x\.com|t\.co)$/, 'twitter'],
  [/(^|\.)(whatsapp\.com|wa\.me)$/, 'whatsapp']
];

function isBot(userAgent = '') {
  return BOT_PATTERN.test(userAgent);
}

function detectDevice(userAgent = '') {
  if (!userAgent) return 'unknown';
  if (/iPad|Tablet|PlayBook|Silk|Kindle|Android(?!.*Mobile)/i.test(userAgent)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android|Windows Phone|BlackBerry|Opera Mini/i.test(userAgent)) return 'mobile';
  return 'desktop';
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Where the visitor came from, in priority order:
 * utm_source -> Google Ads click (gclid) -> referring site -> "direct"
 */
function detectSource({ utmSource, gclid, referrer, siteHost } = {}) {
  if (utmSource) return utmSource;
  if (gclid) return 'google_ads';
  const host = hostOf(referrer);
  if (!host || host === siteHost) return 'direct';
  const match = REFERRER_SOURCES.find(([pattern]) => pattern.test(host));
  return match ? match[1] : host.replace(/^www\./, '').slice(0, 50);
}

module.exports = { isBot, detectDevice, detectSource, hostOf };
