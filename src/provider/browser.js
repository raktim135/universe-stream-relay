// Makes our outbound requests to the brand look like ordinary browser traffic,
// so the brand doesn't flag the account/IP as a bot. One consistent Chrome
// fingerprint (UA + client hints + fetch metadata), reused everywhere.

export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

const CLIENT_HINTS = {
  'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
};

// Build headers for an XHR/fetch-style API call from `origin` (the brand site).
export function apiHeaders(origin, { json = true } = {}) {
  return {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    'User-Agent': USER_AGENT,
    ...CLIENT_HINTS,
    Origin: origin,
    Referer: `${origin}/`,
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
  };
}
