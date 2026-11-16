// Local preview: `node dev-server.js`, then open http://localhost:4280
// Serves src/index.html and generates status.json live, like the GitHub workflow does.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { collect } = require('./collector/collect');

const PORT = process.env.PORT || 4280;
http.createServer(async (req, res) => {
  if (req.url.startsWith('/status.json')) {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(await collect()));
  }
  fs.readFile(path.join(__dirname, 'src', 'index.html'), (err, html) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(err ? 'index.html not found' : html);
  });
}).listen(PORT, () => console.log(`Status page preview on http://localhost:${PORT}`));
