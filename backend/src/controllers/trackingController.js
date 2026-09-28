const { isBot, detectDevice, detectSource, hostOf } = require('../utils/requestInfo');

function createTrackingController(trackingService) {
  return {
    // POST /api/track: sent by the landing page with navigator.sendBeacon
    async track(req, res) {
      const userAgent = req.get('user-agent') || '';
      if (isBot(userAgent)) {
        return res.status(202).json({ success: true, recorded: false });
      }

      const { sessionId, eventType, page, utmSource, gclid, referrer } = req.body;
      const { recorded } = await trackingService.track({
        sessionId,
        eventType,
        page,
        // A referrer from the landing page's own site is not a traffic source
        source: detectSource({ utmSource, gclid, referrer, siteHost: hostOf(req.get('origin')) }),
        device: detectDevice(userAgent)
      });
      res.status(202).json({ success: true, recorded });
    }
  };
}

module.exports = { createTrackingController };
