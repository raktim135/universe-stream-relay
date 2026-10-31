// Admin dashboard: one page, data from /admin/api (refreshes every 5s).

export function dashboardPage({ nonce, retentionDays }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>Relay admin</title>
  <style>
    :root { color-scheme: light dark; --bg: #f4f5f7; --card: #fff; --text: #1d2330; --muted: #667085; --line: #e3e6ec; --accent: #2f6fde; --good: #1f8a4c; --warn: #b26b00; --bad: #c4372d; --chip: #eef1f6; }
    @media (prefers-color-scheme: dark) { :root { --bg: #111418; --card: #1b2027; --text: #e6e9ef; --muted: #9aa3b2; --line: #2c333d; --accent: #5b8ff0; --good: #4cc27f; --warn: #e3a33b; --bad: #ef6b60; --chip: #252c35; } }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 system-ui, sans-serif; }
    header { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; padding: 12px 16px; background: var(--card); border-bottom: 1px solid var(--line); }
    header h1 { margin: 0; font-size: 16px; }
    nav { display: flex; gap: 4px; flex-wrap: wrap; padding: 10px 16px 0; }
    nav button { border: 0; background: none; color: var(--muted); padding: 8px 12px; border-radius: 6px 6px 0 0; font: inherit; cursor: pointer; }
    nav button.on { background: var(--card); color: var(--text); font-weight: 600; }
    main { padding: 0 16px 32px; }
    section { display: none; background: var(--card); border: 1px solid var(--line); border-radius: 0 8px 8px 8px; padding: 16px; }
    section.on { display: block; }
    h2 { font-size: 15px; margin: 18px 0 8px; } h2:first-child { margin-top: 0; }
    .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
    .tile { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
    .tile b { display: block; font-size: 22px; font-variant-numeric: tabular-nums; }
    .tile span { color: var(--muted); font-size: 12px; }
    .scroll { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
    th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; white-space: nowrap; }
    th { color: var(--muted); font-weight: 600; font-size: 12px; }
    td.wrap { white-space: normal; max-width: 360px; word-break: break-word; }
    .chip { display: inline-block; padding: 1px 8px; border-radius: 99px; background: var(--chip); font-size: 12px; margin: 1px 2px 1px 0; }
    .good { color: var(--good); } .warn { color: var(--warn); } .bad { color: var(--bad); } .muted { color: var(--muted); }
    button.small, .btn { border: 1px solid var(--line); background: transparent; color: inherit; border-radius: 6px; padding: 3px 9px; font: inherit; font-size: 12px; cursor: pointer; }
    button.danger { border-color: var(--bad); color: var(--bad); }
    button.primary { background: var(--accent); border-color: var(--accent); color: #fff; padding: 7px 14px; font-size: 14px; }
    input, select, textarea { padding: 6px 8px; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; font: inherit; }
    textarea { width: 100%; min-height: 60px; }
    .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 6px 0; }
    .switch { display: flex; gap: 10px; align-items: flex-start; padding: 8px 0; border-bottom: 1px solid var(--line); }
    .switch input { margin-top: 3px; width: 16px; height: 16px; }
    .switch small { display: block; color: var(--muted); }
    .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px 24px; }
    label.f { display: block; font-size: 12px; color: var(--muted); margin-bottom: 2px; }
    #toast { position: fixed; right: 16px; bottom: 16px; background: var(--text); color: var(--bg); padding: 8px 14px; border-radius: 6px; opacity: 0; transition: opacity .2s; pointer-events: none; }
    #toast.on { opacity: .92; }
    footer { color: var(--muted); font-size: 12px; padding: 0 16px 16px; }
  </style>
</head>
<body>
  <header>
    <h1>Stream relay admin</h1>
    <div class="row" id="status"></div>
    <form method="post" action="/admin/logout"><button class="small">Sign out</button></form>
  </header>
  <nav id="tabs"></nav>
  <main>
    <section id="overview"></section>
    <section id="live"></section>
    <section id="suspects"></section>
    <section id="blocks"></section>
    <section id="bandwidth"></section>
    <section id="settings"></section>
    <section id="activity"></section>
  </main>
  <footer>Data kept ${Number(retentionDays)} days. IP data by <a href="https://db-ip.com" rel="noopener">DB-IP</a> (CC BY 4.0).</footer>
  <div id="toast"></div>

  <script nonce="${nonce}">
  (() => {
    const TABS = [['overview', 'Overview'], ['live', 'Live'], ['suspects', 'Suspects'], ['blocks', 'Blocks'], ['bandwidth', 'Bandwidth'], ['settings', 'Settings'], ['activity', 'Activity']];
    const RULE_NAMES = {
      'too-many-connections': 'Too many connections', 'many-tables': 'Many tables at once', 'non-browser': 'Non-browser client',
      'long-session': 'Very long session', foreign: 'Outside allowed countries', datacenter: 'Hosting / datacenter IP',
      'blocked-ip': 'Blocked IP', manual: 'Manual', settings: 'Settings',
    };
    const ACTIONS = [
      ['limitConnections', 'Limit connections per IP', 'Over the limit, disconnect that IP\\'s oldest connections.'],
      ['blockManyEvents', 'Block IPs watching many tables', 'More tables at once than the limit, block the IP.'],
      ['blockNonBrowser', 'Block non-browser clients', 'ffmpeg, GStreamer, curl, scripts… block the IP.'],
      ['kickLongSessions', 'Disconnect very long sessions', 'Real players reconnect with a fresh token; leaked tokens stop working.'],
      ['blockForeign', 'Reject IPs outside allowed countries', 'Needs the IP database (DB-IP Lite).'],
      ['blockDatacenter', 'Reject hosting / datacenter IPs', 'Cloud servers are where restreams run. Needs the IP database.'],
    ];
    const LIMITS = [
      ['maxConnectionsPerIp', 'Max connections per IP'], ['maxEventsPerIp', 'Max tables per IP at once'],
      ['maxSessionHours', 'Max session length (hours)'], ['blockMinutes', 'Auto-block duration (minutes)'],
    ];

    let tab = 'overview';
    try { tab = localStorage.getItem('relay-admin-tab') || tab; } catch {}
    let settings = null;

    const $ = (id) => document.getElementById(id);
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const dur = (s) => s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
    const mb = (b) => b >= 1073741824 ? (b / 1073741824).toFixed(2) + ' GB' : (b / 1048576).toFixed(1) + ' MB';
    const time = (ms) => new Date(ms).toLocaleString();
    const where = (x) => [x.country, x.org].filter(Boolean).map(esc).join(' · ') || '<span class="muted">unknown</span>';
    const rule = (r) => esc(RULE_NAMES[r] || r);

    function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); setTimeout(() => t.classList.remove('on'), 2500); }

    async function api(path, opts = {}) {
      const res = await fetch('/admin/api' + path, {
        ...opts,
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'relay-admin', ...(opts.headers || {}) },
      });
      if (res.status === 401) { location.href = '/admin/login'; throw new Error('signed out'); }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || res.statusText);
      return body;
    }

    function table(headers, rows, empty) {
      if (!rows.length) return '<p class="muted">' + esc(empty) + '</p>';
      return '<div class="scroll"><table><thead><tr>' + headers.map((h) => '<th>' + esc(h) + '</th>').join('') +
        '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
    }

    // ---- tabs ----
    $('tabs').innerHTML = TABS.map(([id, name]) => '<button data-tab="' + id + '">' + name + '</button>').join('');
    $('tabs').addEventListener('click', (e) => { const id = e.target.dataset.tab; if (id) show(id); });
    function show(id) {
      tab = id;
      try { localStorage.setItem('relay-admin-tab', id); } catch {}
      for (const b of $('tabs').children) b.classList.toggle('on', b.dataset.tab === id);
      for (const [sid] of TABS) $(sid).classList.toggle('on', sid === id);
      refresh();
    }

    // ---- renderers ----
    async function renderStatus(o) {
      const s = o.services;
      const chip = (ok, text) => '<span class="chip ' + (ok ? 'good' : 'bad') + '">' + esc(text) + '</span>';
      $('status').innerHTML =
        chip(!s.mediamtx.apiDown, s.mediamtx.apiDown ? 'MediaMTX down' : 'MediaMTX ok') +
        chip(o.autoMode, o.autoMode ? 'Auto actions ON' : 'Auto actions OFF') +
        chip(s.viewerTokens, s.viewerTokens ? 'Viewer tokens on' : 'Viewer tokens OFF') +
        chip(!!s.geoip.month, s.geoip.month ? 'IP data ' + s.geoip.month : (s.geoip.enabled ? 'IP data loading' : 'IP data off')) +
        '<span class="chip">' + (s.telegram ? 'Telegram on' : 'Telegram off') + '</span>' +
        '<span class="chip">' + (s.production ? 'production' : 'dev') + '</span>';
    }

    async function renderOverview() {
      const o = await api('/overview');
      renderStatus(o);
      const t = o.today || { outGB: 0, inGB: 0, viewerHours: 0, peakViewers: 0, uniqueIps: 0 };
      $('overview').innerHTML =
        '<div class="tiles">' +
        [['Viewers now', o.viewers], ['Viewer IPs now', o.ips], ['Suspects now', o.suspects], ['Tables live', o.tables.length],
          ['Outbound today', t.outGB + ' GB'], ['Inbound today', t.inGB + ' GB'], ['Peak viewers today', t.peakViewers], ['Viewer hours today', t.viewerHours]]
          .map(([k, v]) => '<div class="tile"><b>' + esc(v) + '</b><span>' + esc(k) + '</span></div>').join('') +
        '</div><h2>Tables</h2>' +
        table(['Table', 'State', 'Viewers', 'For', 'Retries', 'Last error'], o.tables.map((x) =>
          '<tr><td>' + esc(x.eventId) + '</td><td class="' + (x.state === 'live' ? 'good' : 'warn') + '">' + esc(x.state) + '</td><td>' + x.viewers +
          '</td><td>' + dur(x.sinceSec) + '</td><td>' + x.failures + '</td><td class="wrap muted">' + esc(x.lastError || '') + '</td></tr>'), 'No table is open.');
    }

    async function renderLive() {
      const [ips, sessions] = await Promise.all([api('/ips'), api('/sessions')]);
      $('live').innerHTML = '<h2>Per IP (' + ips.length + ')</h2>' +
        table(['IP', 'Where', 'Connections', 'Tables', 'Longest', 'Sent', 'Now', ''], ips.map((g) =>
          '<tr><td>' + esc(g.ip) + (g.blocked ? ' <span class="chip bad">blocked</span>' : '') + (g.hosting ? ' <span class="chip warn">hosting</span>' : '') +
          '</td><td class="wrap">' + where(g) + '</td><td>' + g.connections + '</td><td>' + g.tables.map((t) => '<span class="chip">' + esc(t) + '</span>').join('') +
          '</td><td>' + dur(g.longestSec) + '</td><td>' + mb(g.bytesSent) + '</td><td>' + g.kbps + ' kbps</td><td>' +
          '<button class="small danger" data-block="' + esc(g.ip) + '">Block</button> <button class="small" data-history="' + esc(g.ip) + '">History</button></td></tr>'), 'Nobody is watching.') +
        '<h2>Connections (' + sessions.length + ')</h2>' +
        table(['IP', 'Table', 'Protocol', 'Connected', 'Duration', 'Sent', 'Now', 'Lost pkts', 'Client', ''], sessions.map((s) =>
          '<tr><td>' + esc(s.ip) + '</td><td>' + esc(s.eventId) + '</td><td>' + esc(s.protocol) + '/' + esc(s.transport) + '</td><td>' + esc(new Date(s.since).toLocaleTimeString()) +
          '</td><td>' + dur(s.durationSec) + '</td><td>' + mb(s.bytesSent) + '</td><td>' + s.kbps + ' kbps</td><td>' + s.packetsLost +
          '</td><td class="wrap muted">' + esc(s.userAgent) + '</td><td><button class="small" data-kick="' + esc(s.id) + '">Disconnect</button></td></tr>'), 'No connections.') +
        '<div id="historyBox"></div>';
    }

    async function renderSuspects() {
      const f = await api('/findings');
      $('suspects').innerHTML = '<p class="muted">IPs matching a rule right now. Rules marked "acted" were handled automatically.</p>' +
        table(['IP', 'Where', 'Connections', 'Tables', 'Rules', ''], f.map((x) =>
          '<tr><td>' + esc(x.ip) + '</td><td class="wrap">' + where(x) + '</td><td>' + x.connections + '</td><td>' + x.tables.map((t) => '<span class="chip">' + esc(t) + '</span>').join('') +
          '</td><td class="wrap">' + x.rules.map((r) => '<div><b>' + rule(r.rule) + '</b>' + (r.acted ? ' <span class="chip good">acted</span>' : '') + ' <span class="muted">' + esc(r.detail) + '</span></div>').join('') +
          '</td><td><button class="small danger" data-block="' + esc(x.ip) + '">Block</button></td></tr>'), 'No suspicious viewers right now.');
    }

    async function renderBlocks() {
      const b = await api('/blocks');
      $('blocks').innerHTML =
        '<h2>Block an IP</h2><form class="row" id="blockForm"><input name="ip" placeholder="IP address" required>' +
        '<input name="minutes" type="number" min="1" placeholder="Minutes (empty = permanent)">' +
        '<input name="reason" placeholder="Reason (optional)"><button class="small danger">Block</button></form>' +
        '<h2>Blocked (' + b.length + ')</h2>' +
        table(['IP', 'Reason', 'By', 'Since', 'Until', ''], b.map((x) =>
          '<tr><td>' + esc(x.ip) + '</td><td class="wrap">' + esc(x.reason) + '</td><td>' + esc(x.source) + '</td><td>' + esc(time(x.created_at)) +
          '</td><td>' + (x.expires_at ? esc(time(x.expires_at)) : '<b>permanent</b>') + '</td><td><button class="small" data-unblock="' + esc(x.ip) + '">Unblock</button></td></tr>'), 'No blocked IPs.');
    }

    async function renderBandwidth() {
      const r = await api('/bandwidth');
      const t = r.totals;
      $('bandwidth').innerHTML =
        '<div class="tiles">' + [['Outbound (' + r.days.length + ' days)', t.outGB + ' GB'], ['Inbound', t.inGB + ' GB'], ['Viewer hours', t.viewerHours],
          ['Network card out', t.nicOutGB ? t.nicOutGB + ' GB' : 'n/a']].map(([k, v]) => '<div class="tile"><b>' + esc(v) + '</b><span>' + esc(k) + '</span></div>').join('') + '</div>' +
        '<h2>Per day</h2>' +
        table(['Date', 'Out GB', 'In GB', 'NIC out GB', 'NIC in GB', 'Viewer h', 'Peak', 'Unique IPs', 'Per table (out GB / peak)'], r.days.map((d) =>
          '<tr><td>' + esc(d.date) + '</td><td><b>' + d.outGB + '</b></td><td>' + d.inGB + '</td><td>' + (d.nicOutGB ?? '–') + '</td><td>' + (d.nicInGB ?? '–') +
          '</td><td>' + d.viewerHours + '</td><td>' + d.peakViewers + '</td><td>' + d.uniqueIps + '</td><td class="wrap">' +
          d.tables.map((x) => '<span class="chip">' + esc(x.eventId) + ': ' + x.outGB + ' / ' + x.peakViewers + '</span>').join('') + '</td></tr>'), 'No traffic recorded yet.') +
        '<p class="muted">Out/In count media bytes. Network-card figures (Linux only) include encryption and network overhead and are closest to your host\\'s bill.</p>';
    }

    async function renderSettings() {
      settings = await api('/settings');
      const s = settings;
      $('settings').innerHTML =
        '<div class="switch"><input type="checkbox" id="autoMode"' + (s.autoMode ? ' checked' : '') + '><label for="autoMode"><b>Automatic actions (master switch)</b>' +
        '<small>Off = rules only detect and report. On = each action below runs if its own switch is on.</small></label></div>' +
        '<h2>Actions</h2>' + ACTIONS.map(([k, name, help]) =>
          '<div class="switch"><input type="checkbox" data-action="' + k + '" id="a_' + k + '"' + (s.actions[k] ? ' checked' : '') + '><label for="a_' + k + '"><b>' + esc(name) + '</b><small>' + esc(help) + '</small></label></div>').join('') +
        '<h2>Limits</h2><div class="grid2">' + LIMITS.map(([k, name]) =>
          '<div><label class="f" for="l_' + k + '">' + esc(name) + '</label><input type="number" min="1" id="l_' + k + '" data-limit="' + k + '" value="' + esc(s.limits[k]) + '"></div>').join('') + '</div>' +
        '<h2>Lists (one per line)</h2><div class="grid2">' +
        '<div><label class="f" for="embed">Sites allowed to embed the player (example.com also allows its subdomains; empty = any site in dev, own site only in production)</label><textarea id="embed">' + esc(s.allowedEmbedDomains.join('\\n')) + '</textarea></div>' +
        '<div><label class="f" for="countries">Allowed countries (2-letter codes)</label><textarea id="countries">' + esc(s.allowedCountries.join('\\n')) + '</textarea></div>' +
        '<div><label class="f" for="allow">IP allowlist (never flagged or blocked)</label><textarea id="allow">' + esc(s.ipAllowlist.join('\\n')) + '</textarea></div>' +
        '</div><p><button class="primary" id="save">Save settings</button></p>';
    }

    async function renderActivity() {
      const a = await api('/actions?limit=300');
      $('activity').innerHTML = table(['Time', 'Action', 'Rule', 'IP', 'Table', 'Detail'], a.map((x) =>
        '<tr><td>' + esc(time(x.ts)) + '</td><td class="' + (x.action === 'detected' ? 'warn' : x.action === 'blocked' || x.action === 'kicked' ? 'bad' : '') + '">' + esc(x.action) +
        '</td><td>' + rule(x.rule) + '</td><td>' + esc(x.ip || '') + '</td><td>' + esc(x.event_id || '') + '</td><td class="wrap muted">' + esc(x.detail || '') + '</td></tr>'), 'Nothing yet.');
    }

    const RENDER = { overview: renderOverview, live: renderLive, suspects: renderSuspects, blocks: renderBlocks, bandwidth: renderBandwidth, settings: renderSettings, activity: renderActivity };
    const AUTO = new Set(['overview', 'live', 'suspects']);
    let busy = false;
    async function refresh() {
      if (busy) return;
      busy = true;
      try {
        await RENDER[tab]();
        if (tab !== 'overview') renderStatus(await api('/overview'));
      } catch (e) { if (e.message !== 'signed out') toast(e.message); }
      busy = false;
    }
    setInterval(() => { if (AUTO.has(tab) && !document.hidden && !document.querySelector('#historyBox table')) refresh(); }, 5000);

    // ---- actions ----
    document.addEventListener('click', async (e) => {
      const d = e.target.dataset || {};
      try {
        if (d.kick) { await api('/sessions/' + encodeURIComponent(d.kick) + '/kick', { method: 'POST' }); toast('Disconnected'); refresh(); }
        if (d.block) {
          const minutes = prompt('Block ' + d.block + ' for how many minutes? Leave empty for permanent.', '60');
          if (minutes === null) return;
          await api('/blocks', { method: 'POST', body: JSON.stringify({ ip: d.block, minutes: minutes.trim() || null, reason: 'manual (dashboard)' }) });
          toast('Blocked ' + d.block); refresh();
        }
        if (d.unblock) { await api('/blocks/' + encodeURIComponent(d.unblock), { method: 'DELETE' }); toast('Unblocked'); refresh(); }
        if (d.history) {
          const h = await api('/history?ip=' + encodeURIComponent(d.history));
          $('historyBox').innerHTML = '<h2>History for ' + esc(d.history) + ' <button class="small" data-close="1">Close</button></h2>' +
            table(['Started', 'Ended', 'Table', 'Protocol', 'Sent', 'Ended because', 'Client'], h.map((x) =>
              '<tr><td>' + esc(time(x.started_at)) + '</td><td>' + (x.ended_at ? esc(time(x.ended_at)) : '<span class="good">live</span>') + '</td><td>' + esc(x.event_id) +
              '</td><td>' + esc(x.protocol) + '</td><td>' + mb(x.bytes_sent) + '</td><td>' + esc(x.end_reason || '') + '</td><td class="wrap muted">' + esc(x.user_agent) + '</td></tr>'), 'No history.');
        }
        if (d.close) $('historyBox').innerHTML = '';
        if (e.target.id === 'save') {
          const lines = (id) => $(id).value.split(/[\\n,]/).map((x) => x.trim()).filter(Boolean);
          const patch = { autoMode: $('autoMode').checked, actions: {}, limits: {}, allowedEmbedDomains: lines('embed'), allowedCountries: lines('countries'), ipAllowlist: lines('allow') };
          document.querySelectorAll('[data-action]').forEach((el) => { patch.actions[el.dataset.action] = el.checked; });
          document.querySelectorAll('[data-limit]').forEach((el) => { patch.limits[el.dataset.limit] = Number(el.value); });
          await api('/settings', { method: 'PUT', body: JSON.stringify(patch) });
          toast('Settings saved'); refresh();
        }
      } catch (err) { if (err.message !== 'signed out') toast(err.message); }
    });

    document.addEventListener('submit', async (e) => {
      if (e.target.id !== 'blockForm') return;
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api('/blocks', { method: 'POST', body: JSON.stringify({ ip: f.get('ip').trim(), minutes: f.get('minutes') || null, reason: f.get('reason') || 'manual (dashboard)' }) });
        toast('Blocked'); refresh();
      } catch (err) { toast(err.message); }
    });

    show(TABS.some(([id]) => id === tab) ? tab : 'overview');
  })();
  </script>
</body>
</html>`;
}
