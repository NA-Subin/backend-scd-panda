require('dotenv').config();
const express = require('express');
const cors = require('cors');

const basicDataRoute = require('./routes/basicData');
const tablesRoute = require('./routes/tables');
const authRoute = require('./routes/auth');

const app = express();

app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api/basic-data', basicDataRoute);
app.use('/api/auth', authRoute);
app.use('/api', tablesRoute);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
});
