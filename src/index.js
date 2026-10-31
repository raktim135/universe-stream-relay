// Entry point: checks the Node version, then boots the service (server.js).
// Node 22.13+ is required for the built-in SQLite store (node:sqlite).

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`[server] Node ${process.versions.node} is too old: this service needs Node 22.13 or newer (built-in SQLite).`);
  process.exit(1);
}

await import('./server.js');
