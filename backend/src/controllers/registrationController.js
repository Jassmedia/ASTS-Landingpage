const { detectDevice, detectSource } = require('../utils/requestInfo');

// HTTP layer only: read the request, call the service, send the response.
// Express 5 forwards errors from async handlers to the error handler.
function createRegistrationController(registrationService) {
  return {
    async create(req, res) {
      const { utmSource, gclid, ...input } = req.body;
      // With no campaign info, the database uses the visitor's recorded source
      const source = utmSource || gclid ? detectSource({ utmSource, gclid }) : null;

      const { created, registration } = await registrationService.createRegistration({
        ...input,
        source,
        device: detectDevice(req.get('user-agent'))
      });

      const body = { success: true, message: 'Registration submitted successfully', data: registration };
      if (!created) body.duplicate = true; // same submission sent twice; nothing new was saved
      res.status(created ? 201 : 200).json(body);
    },

    async list(req, res) {
      const registrations = await registrationService.listRegistrations(res.locals.query);
      res.json({ success: true, data: registrations });
    },

    async getById(req, res) {
      const registration = await registrationService.getRegistration(req.params.id);
      res.json({ success: true, data: registration });
    },

    async remove(req, res) {
      await registrationService.deleteRegistration(req.params.id);
      res.json({ success: true, message: 'Registration deleted successfully' });
    }
  };
}

module.exports = { createRegistrationController };
