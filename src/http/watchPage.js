// The viewer player served at /watch/:eventId (embed it in an <iframe>).
//
//   - WebRTC (WHEP) from MediaMTX: sub-second latency, original quality, Opus audio.
//   - While the table is still opening MediaMTX answers 404; we retry.
//   - After repeated WebRTC failures (UDP blocked etc.) falls back to LL-HLS.
//   - Stops streaming when the tab is hidden or the player is off screen for
//     a while, and resumes when it is back, so idle viewers cost no bandwidth.
//   - Starts muted so the browser allows autoplay. No mute control is shown.

const HLS_JS = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';

function inlineJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

const DENIED = 'You are not authorize!';

export function watchPage({ eventId, whepUrl, hlsUrl, token, mode, denied = false, blockDevtools = false, embedReturn = '' }) {
  const cfg = inlineJson({ whepUrl, hlsUrl, token, mode, hlsJs: HLS_JS, denied, blockDevtools, embedReturn });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Live ${String(eventId).replace(/[^\w.-]/g, '')}</title>
  <style>
    html, body { margin: 0; height: 100%; background: #000; color: #eee; font: 16px/1.4 system-ui, sans-serif; overflow: hidden; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
    video { width: 100%; height: 100%; background: #000; object-fit: contain; pointer-events: none; }
    #shield { position: absolute; inset: 0; z-index: 5; background: transparent; }
    #loader, #denied { position: absolute; inset: 0; display: grid; place-items: center; }
    #loader { background: #000; }
    #loader[hidden], #denied[hidden] { display: none; }
    #loader img { width: min(280px, 70vw); height: auto; background: #000; }
    #denied {
      background:
        radial-gradient(900px 480px at 50% 0%, rgba(176, 62, 92, .42), transparent 58%),
        radial-gradient(720px 420px at 100% 100%, rgba(196, 150, 72, .28), transparent 52%),
        linear-gradient(165deg, #241018 0%, #100c12 46%, #141820 100%);
    }
    #denied .card {
      width: min(440px, calc(100% - 48px));
      margin: 24px;
      padding: 40px 36px 34px;
      text-align: center;
      border: 1px solid rgba(230, 198, 138, .72);
      border-radius: 22px;
      background:
        linear-gradient(180deg, rgba(255,255,255,.07), rgba(255,255,255,.02)),
        rgba(22, 14, 18, .9);
      box-shadow:
        0 0 0 6px rgba(230, 198, 138, .08),
        0 0 0 1px rgba(0,0,0,.55),
        inset 0 1px 0 rgba(255,255,255,.16),
        0 28px 60px rgba(0,0,0,.5);
    }
    #denied .rule {
      display: block;
      width: 64px;
      height: 2px;
      margin: 0 auto 20px;
      border: 0;
      border-radius: 2px;
      background: linear-gradient(90deg, transparent, #f0d7a2, transparent);
    }
    #denied p { margin: 0; font-size: 22px; font-weight: 650; letter-spacing: .01em; color: #f7f1e8; }
  </style>
</head>
<body>
  <video id="v" autoplay muted playsinline disablepictureinpicture disableremoteplayback controlsList="nodownload nofullscreen noremoteplayback"></video>
  <div id="loader"${denied ? ' hidden' : ''}><img src="/img/loader.gif" alt="" draggable="false"></div>
  <div id="denied"${denied ? '' : ' hidden'}><div class="card"><span class="rule"></span><p>${DENIED}</p></div></div>
  <div id="shield"></div>
  <script>
  (() => {
    const CFG = ${cfg};
    const blockPointer = (event) => { event.preventDefault(); event.stopPropagation(); };
    for (const type of ['click', 'dblclick', 'contextmenu', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend']) {
      document.addEventListener(type, blockPointer, { capture: true, passive: false });
    }
    if (CFG.blockDevtools) {
      let gone = false;
      const leave = () => {
        if (gone) return;
        gone = true;
        const target = CFG.embedReturn || 'https://www.google.com';
        try { window.top.location.replace(target); } catch { location.replace(target); }
      };
      const docked = () => Math.abs(window.outerWidth - window.innerWidth) > 200
        || Math.abs(window.outerHeight - window.innerHeight) > 200;
      const check = () => {
        if (docked()) leave();
        const mark = new Image();
        Object.defineProperty(mark, 'id', { get() { leave(); } });
        console.debug(mark);
      };
      check();
      setInterval(check, 200);
      window.addEventListener('resize', check);
    }
    const OPEN_TIMEOUT_MS = 120000;
    const PAUSE_AFTER_MS = 10000;
    const MAX_WEBRTC_FAILURES = 3;

    const video = document.getElementById('v');
    const loader = document.getElementById('loader');
    const denied = document.getElementById('denied');
    const auth = CFG.token ? { Authorization: 'Bearer ' + CFG.token } : {};

    let pc = null;
    let sessionUrl = null;
    let hls = null;
    let running = false;
    let paused = false;
    let retryTimer = null;
    let pauseTimer = null;
    let webrtcFailures = 0;
    let openingSince = Date.now();
    let onScreen = true;

    const showLoader = () => { denied.hidden = true; loader.hidden = false; };
    const refuse = () => {
      teardown();
      running = false;
      clearTimeout(retryTimer);
      loader.hidden = true;
      denied.hidden = false;
    };
    video.addEventListener('playing', () => { loader.hidden = true; });

    function useHls() {
      return CFG.mode === 'hls' || webrtcFailures >= MAX_WEBRTC_FAILURES || !window.RTCPeerConnection;
    }

    function teardown() {
      if (pc) { pc.close(); pc = null; }
      if (sessionUrl) {
        fetch(sessionUrl, { method: 'DELETE', headers: auth, keepalive: true }).catch(() => {});
        sessionUrl = null;
      }
      if (hls) { hls.destroy(); hls = null; }
    }

    function retry(delay) {
      teardown();
      running = false;
      showLoader();
      clearTimeout(retryTimer);
      retryTimer = setTimeout(start, delay);
    }

    function gathered(conn) {
      if (conn.iceGatheringState === 'complete') return Promise.resolve();
      return new Promise((resolve) => {
        const t = setTimeout(resolve, 1500);
        conn.addEventListener('icegatheringstatechange', () => {
          if (conn.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
        });
      });
    }

    async function playWebRTC() {
      const conn = new RTCPeerConnection({ bundlePolicy: 'max-bundle' });
      pc = conn;
      conn.addTransceiver('video', { direction: 'recvonly' });
      conn.addTransceiver('audio', { direction: 'recvonly' });
      const stream = new MediaStream();
      conn.ontrack = (e) => {
        stream.addTrack(e.track);
        if (video.srcObject !== stream) video.srcObject = stream;
      };
      conn.onconnectionstatechange = () => {
        if (pc !== conn) return;
        const s = conn.connectionState;
        if (s === 'connected') webrtcFailures = 0;
        if (s === 'failed') { webrtcFailures += 1; retry(1000); }
        if (s === 'disconnected') {
          setTimeout(() => {
            if (pc === conn && conn.connectionState === 'disconnected') retry(500);
          }, 4000);
        }
      };

      await conn.setLocalDescription(await conn.createOffer());
      await gathered(conn);
      const res = await fetch(CFG.whepUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp', ...auth },
        body: conn.localDescription.sdp,
      });
      if (res.status === 401 || res.status === 403) throw Object.assign(new Error('denied'), { denied: true });
      if (res.status === 404 || res.status === 400) throw Object.assign(new Error('opening'), { opening: true });
      if (res.status !== 201) throw new Error('server answered ' + res.status);
      const location = res.headers.get('Location');
      sessionUrl = location ? new URL(location, CFG.whepUrl).toString() : null;
      await conn.setRemoteDescription({ type: 'answer', sdp: await res.text() });
    }

    function loadHlsJs() {
      if (window.Hls) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = CFG.hlsJs;
        s.onload = resolve;
        s.onerror = () => reject(new Error('could not load the HLS player'));
        document.head.appendChild(s);
      });
    }

    async function playHls() {
      if (!window.MediaSource && video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = CFG.hlsUrl + (CFG.token ? '?token=' + encodeURIComponent(CFG.token) : '');
        return;
      }
      await loadHlsJs();
      if (!window.Hls || !Hls.isSupported()) throw Object.assign(new Error('This browser cannot play the stream.'), { fatal: true });
      hls = new Hls({
        lowLatencyMode: true,
        backBufferLength: 10,
        xhrSetup: (xhr) => {
          if (CFG.token) xhr.setRequestHeader('Authorization', 'Bearer ' + CFG.token);
          xhr.addEventListener('load', () => { if (xhr.status === 401 || xhr.status === 403) refuse(); });
        },
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { hls.recoverMediaError(); return; }
        retry(2000);
      });
      hls.loadSource(CFG.hlsUrl);
      hls.attachMedia(video);
    }

    async function start() {
      if (running || paused) return;
      running = true;
      try {
        if (useHls()) await playHls();
        else await playWebRTC();
      } catch (err) {
        if (err.denied) { refuse(); return; }
        if (err.fatal) { teardown(); running = false; loader.hidden = true; denied.hidden = false; return; }
        if (err.opening) {
          if (Date.now() - openingSince > OPEN_TIMEOUT_MS) { teardown(); running = false; return; }
          retry(1000);
          return;
        }
        webrtcFailures += 1;
        retry(2000);
      }
    }

    // Pause when nobody can see the player; resume when they can.
    function updateVisibility() {
      const visible = !document.hidden && onScreen;
      if (!visible) {
        if (!pauseTimer && !paused) {
          pauseTimer = setTimeout(() => {
            pauseTimer = null;
            paused = true;
            clearTimeout(retryTimer);
            teardown();
            running = false;
          }, PAUSE_AFTER_MS);
        }
        return;
      }
      clearTimeout(pauseTimer);
      pauseTimer = null;
      if (paused) {
        paused = false;
        openingSince = Date.now();
        showLoader();
        start();
      }
    }
    document.addEventListener('visibilitychange', updateVisibility);
    if (window.IntersectionObserver) {
      new IntersectionObserver((entries) => {
        onScreen = entries.some((e) => e.isIntersecting);
        updateVisibility();
      }).observe(video);
    }
    window.addEventListener('pagehide', teardown);

    if (!CFG.denied) start();
  })();
  </script>
</body>
</html>`;
}
