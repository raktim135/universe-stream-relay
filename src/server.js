// Re-broadcast server: exposes the scraped Universe feed to our own clients.
//
//   Socket.IO (real-time):
//     - on connect, we send the current snapshot of every table
//     - "state" events are pushed whenever a table updates
//   REST (fallback / debugging):
//     - GET /health
//     - GET /api/tables            -> configured tables + connection status
//     - GET /api/state/:eventId    -> latest normalized state for a table
//     - GET /api/video/:eventId    -> { iframeUrl, creds } for the live video

import './dnsPin.js'; // MUST be first: pins the provider host before any connection
import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { Server as IOServer } from 'socket.io';
import { config } from './config.js';
import { universe } from './universeClient.js';
import { normalize } from './normalize.js';
import { getVideo } from './streaming.js';

const app = express();
app.use(cors({ origin: config.corsOrigin }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, connected: universe.connected, tables: config.tables });
});

app.get('/api/tables', (_req, res) => {
  res.json({
    connected: universe.connected,
    tables: config.tables.map((eventId) => ({
      eventId,
      hasData: !!universe.latest(eventId),
    })),
  });
});

app.get('/api/state/:eventId', (req, res) => {
  const data = universe.latest(req.params.eventId);
  if (!data) return res.status(404).json({ error: 'no data yet' });
  res.json(normalize(data));
});

app.get('/api/video/:eventId', async (req, res) => {
  try {
    const video = await getVideo(req.params.eventId);
    res.json(video);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

const server = http.createServer(app);
const ioServer = new IOServer(server, { cors: { origin: config.corsOrigin } });

ioServer.on('connection', (socket) => {
  // Send a snapshot of all tables on connect.
  for (const eventId of config.tables) {
    const data = universe.latest(eventId);
    if (data) socket.emit('state', normalize(data));
  }
  socket.emit('status', { connected: universe.connected });
});

// Forward every provider update to our clients.
universe.on('update', ({ data }) => {
  ioServer.emit('state', normalize(data));
});
universe.on('status', (s) => ioServer.emit('status', s));

universe.start();

server.listen(config.port, () => {
  console.log(`[server] universe re-broadcast on http://localhost:${config.port}`);
  console.log(`[server] tables: ${config.tables.join(', ')}`);
});
