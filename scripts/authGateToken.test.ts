/**
 * AUTH_MODE=token login gate, driven through the real React component.
 *
 * Renders <AuthGate> under jsdom against a stubbed server (config says token
 * mode; /api/auth/me demands the right bearer) and proves: the app is gated
 * behind the prompt, a wrong token is rejected in place, the right token
 * verifies, persists, and lets the app render.
 *
 * Run: npx tsx scripts/authGateToken.test.ts
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
});
(globalThis as any).window = dom.window;
(globalThis as any).document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
(globalThis as any).localStorage = dom.window.localStorage;
(globalThis as any).sessionStorage = dom.window.sessionStorage;
(globalThis as any).HTMLElement = dom.window.HTMLElement;
(globalThis as any).Event = dom.window.Event;
// authFetch dispatches CustomEvent on 401 — it must be the jsdom realm's, or
// window.dispatchEvent rejects it as "not a valid instance of Event".
(globalThis as any).CustomEvent = dom.window.CustomEvent;

const GOOD_TOKEN = 'correct-horse-battery-staple';

// The whole server, stubbed: token-mode config, bearer-checked identity.
(globalThis as any).fetch = async (input: any, init: any = {}) => {
  const url = String(input);
  if (url.endsWith('/api/auth/config')) {
    return new Response(JSON.stringify({ mode: 'token', requiresToken: true }), { status: 200 });
  }
  if (url.endsWith('/api/auth/me')) {
    const auth = new Headers(init.headers).get('Authorization');
    return auth === `Bearer ${GOOD_TOKEN}`
      ? new Response(JSON.stringify({ id: 'local' }), { status: 200 })
      : new Response(JSON.stringify({ error: 'Invalid or missing token' }), { status: 401 });
  }
  return new Response('not found', { status: 404 });
};

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const settle = () => new Promise((r) => setTimeout(r, 80));

async function main() {
  const React = (await import('react')).default;
  const { createRoot } = await import('react-dom/client');
  const { AuthGate } = await import('../src/components/AuthGate');

  const root = createRoot(document.getElementById('root')!);
  root.render(React.createElement(AuthGate, null, React.createElement('div', { id: 'the-app' }, 'APP')));
  await settle();

  const body = () => document.body.textContent ?? '';
  check('app is gated behind the token prompt', document.getElementById('the-app') === null);
  check('prompt explains itself', body().includes('Access token required'));

  const input = document.querySelector('input');
  const form = document.querySelector('form');
  if (!input || !form) {
    console.error('FAIL  prompt form never rendered — cannot continue');
    process.exit(1);
  }
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
  const type = async (text: string) => {
    setValue.call(input, text);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await settle();
  };
  const submit = async () => {
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
  };

  await type('wrong-token');
  await submit();
  check('wrong token is rejected in place', body().includes('not accepted'));
  check('wrong token is not kept', localStorage.getItem('chronicle_token') === null);
  check('still gated after rejection', document.getElementById('the-app') === null);

  await type(GOOD_TOKEN);
  await submit();
  check('right token unlocks the app', document.getElementById('the-app') !== null, body().slice(0, 120));
  check('token persisted for authFetch', localStorage.getItem('chronicle_token') === GOOD_TOKEN);
  check('verified user scope recorded', sessionStorage.getItem('chronicle_user_id') === 'local');

  root.unmount();
  if (failures > 0) {
    console.error(`\n${failures} token-gate check(s) failed`);
    process.exit(1);
  }
  console.log('\nAll token-gate checks passed.');
}

void main();
