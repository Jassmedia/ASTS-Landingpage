function getHealth(req, res) {
  res.json({ success: true, message: 'ASTS backend is running' });
}

module.exports = { getHealth };
