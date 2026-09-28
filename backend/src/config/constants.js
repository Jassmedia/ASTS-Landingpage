// Events the landing page may send. registration_submitted is only ever
// recorded by the server, after a registration is actually saved.
const CLIENT_EVENT_TYPES = Object.freeze(['page_view', 'demo_button_click', 'form_started']);

// A visitor's state is never set by hand. It is worked out from tracking:
//   REGISTERED - their session has a completed registration
//   CLICKED    - they clicked Book Free Demo but haven't registered
const LEAD_STATES = Object.freeze({ REGISTERED: 'REGISTERED', CLICKED: 'CLICKED' });

module.exports = { CLIENT_EVENT_TYPES, LEAD_STATES };
