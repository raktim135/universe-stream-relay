// The viewer player served at /watch/:eventId (embed it in an <iframe>).
//
//   - WebRTC (WHEP) from MediaMTX: sub-second latency, original quality, Opus audio.
//   - While the table is still opening MediaMTX answers 404; we retry.
//   - After repeated WebRTC failures (UDP blocked etc.) falls back to LL-HLS.
//   - Stops streaming when the tab is hidden or the player is off screen for
//     a while, and resumes when it is back, so idle viewers cost no bandwidth.
//   - Starts muted (browser autoplay rules); shows a tap-for-sound button
//     when the table has audio.

const HLS_JS = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';

function inlineJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

const DENIED = 'You are not authorize!';

export function watchPage({ eventId, whepUrl, hlsUrl, token, mode, denied = false }) {
  const cfg = inlineJson({ whepUrl, hlsUrl, token, mode, hlsJs: HLS_JS, denied });
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Live ${String(eventId).replace(/[^\w.-]/g, '')}</title>
  <style>
    html, body { margin: 0; height: 100%; background: #000; color: #eee; font: 16px/1.4 system-ui, sans-serif; overflow: hidden; }
    video { width: 100%; height: 100%; background: #000; object-fit: contain; }
    #loader, #denied { position: absolute; inset: 0; display: grid; place-items: center; background: #000; }
    #loader[hidden], #denied[hidden], #sound[hidden] { display: none; }
    #loader img { width: min(280px, 70vw); height: auto; background: #000; }
    #denied .card { max-width: 420px; margin: 24px; padding: 28px 32px; text-align: center; border: 1px solid rgba(255,255,255,.14); border-radius: 16px; background: #141414; box-shadow: 0 16px 40px rgba(0,0,0,.45); }
    #denied p { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: .01em; }
    #sound { position: absolute; z-index: 3; right: 12px; bottom: 12px; width: 44px; height: 44px; padding: 0; border: 0; border-radius: 22px; background: rgba(0,0,0,.72); color: #fff; cursor: pointer; display: grid; place-items: center; }
    #sound svg { width: 22px; height: 22px; display: block; }
  </style>
</head>
<body>
  <video id="v" autoplay muted playsinline></video>
  <div id="loader"${denied ? ' hidden' : ''}><img src="/img/loader.gif" alt=""></div>
  <div id="denied"${denied ? '' : ' hidden'}><div class="card"><p>${DENIED}</p></div></div>
  <button id="sound" type="button" hidden aria-label="Unmute"></button>
  <script>
  (() => {
    const CFG = ${cfg};
    const OPEN_TIMEOUT_MS = 120000;
    const PAUSE_AFTER_MS = 10000;
    const MAX_WEBRTC_FAILURES = 3;

    const video = document.getElementById('v');
    const loader = document.getElementById('loader');
    const denied = document.getElementById('denied');
    const sound = document.getElementById('sound');
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

    const showLoader = () => { denied.hidden = true; loader.hidden = false; sound.hidden = true; };
    const ICON_MUTED = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M22 9l-6 6M16 9l6 6"/></svg>';
    const ICON_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5L6 9H3v6h3l5 4V5z"/><path d="M16 9a5 5 0 010 6M19 7a8 8 0 010 10"/></svg>';
    const paintSound = () => {
      sound.innerHTML = video.muted ? ICON_MUTED : ICON_ON;
      sound.setAttribute('aria-label', video.muted ? 'Unmute' : 'Mute');
    };
    const refuse = () => {
      teardown();
      running = false;
      clearTimeout(retryTimer);
      loader.hidden = true;
      sound.hidden = true;
      denied.hidden = false;
    };
    video.addEventListener('playing', () => {
      loader.hidden = true;
      if (denied.hidden) { sound.hidden = false; paintSound(); }
    });

    sound.addEventListener('click', () => {
      video.muted = !video.muted;
      if (!video.muted) video.play().catch(() => {});
      paintSound();
    });

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
