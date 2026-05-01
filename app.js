const express = require('express');
const fs = require('fs');
const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = '/data/visits.txt';

app.get('/', (req, res) => {
  let visits = 0;
  if (fs.existsSync(DATA_FILE)) {
    visits = parseInt(fs.readFileSync(DATA_FILE, 'utf8')) || 0;
  }
  visits++;
  fs.writeFileSync(DATA_FILE, String(visits));
  res.send(`<h1>Hello from Kubernetes!</h1><p>Visits: ${visits}</p>`);
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`Server on port ${PORT}`));