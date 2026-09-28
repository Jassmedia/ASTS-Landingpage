/**
 * Conversion rate = registrations / unique visitors x 100, rounded to 2 decimals.
 * Never uses button clicks as the denominator. null when there are no visitors.
 */
function conversionRate(registrations, uniqueVisitors) {
  if (!uniqueVisitors) return null;
  return Math.round((registrations / uniqueVisitors) * 10000) / 100;
}

function createAnalyticsService(trackingRepository) {
  async function getMetrics(filters = {}) {
    const stats = await trackingRepository.getStats(filters);
    return {
      stats,
      metrics: {
        uniqueVisitors: stats.uniqueVisitors,
        pageViews: stats.pageViews,
        uniqueDemoClickers: stats.uniqueDemoClickers,
        totalDemoClicks: stats.totalDemoClicks,
        formStarts: stats.formStarts,
        registrations: stats.registrations,
        conversionRate: conversionRate(stats.registrations, stats.uniqueVisitors)
      }
    };
  }

  return {
    async getDashboard(filters = {}) {
      const [{ stats, metrics }, options] = await Promise.all([
        getMetrics(filters),
        trackingRepository.getFilterOptions()
      ]);

      return {
        metrics,
        // Unique people at each step (a person is counted once per step)
        funnel: [
          { key: 'visited', label: 'Visited the page', people: stats.uniqueVisitors },
          { key: 'clicked', label: 'Clicked Book Free Demo', people: stats.uniqueDemoClickers },
          { key: 'form_started', label: 'Started the form', people: stats.formStarts },
          { key: 'registered', label: 'Registered', people: stats.registeredPeople }
        ],
        // Automatic lead states, each person counted once.
        // Clicked and later registered = registered only.
        leads: { registered: stats.people.registered, clicked: stats.people.clicked },
        daily: stats.daily,
        options
      };
    },

    /** All-time numbers, used for the Google Sheets Summary tab */
    async getSummary() {
      const { stats, metrics } = await getMetrics();
      return { ...metrics, clickedNotRegistered: stats.people.clicked };
    },

    getClickedNotRegistered(filters = {}) {
      return trackingRepository.getClickedNotRegistered(filters);
    }
  };
}

module.exports = { createAnalyticsService, conversionRate };
