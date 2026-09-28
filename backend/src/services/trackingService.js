// Records anonymous visitor activity from the landing page.
function createTrackingService(repository, events) {
  const emit = (name, payload) => {
    try {
      events?.emit(name, payload);
    } catch (err) {
      console.error(`[events] ${name} listener failed:`, err.message);
    }
  };

  return {
    /**
     * @param {{ sessionId, eventType, page, source, device }} input
     * @returns {{ recorded: boolean }} recorded is false for a repeated form_started
     */
    async track(input) {
      const result = await repository.recordEvent(input);
      if (result.newVisitor) emit('visitor.created', { visitor: result.visitor });
      if (result.recorded) emit('event.recorded', { event: result.event, visitor: result.visitor });
      return { recorded: result.recorded };
    }
  };
}

module.exports = { createTrackingService };
