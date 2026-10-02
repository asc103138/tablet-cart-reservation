/**
 * LINE Webhook relay for Cloudflare Workers.
 *
 * Required Worker bindings:
 *   LINE_CHANNEL_SECRET  Secret from LINE Developers
 *   GAS_RELAY_SECRET     Shared secret also stored in Apps Script Properties
 *   GAS_WEBHOOK_URL      Deployed GAS /exec URL
 */

function base64FromBytes_(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function timingSafeEqual_(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return difference === 0;
}

async function verifyLineSignature_(body, signature, channelSecret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(channelSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return timingSafeEqual_(base64FromBytes_(digest), signature);
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'GET') return new Response('LINE relay ready');
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    const body = await request.text();
    const signature = request.headers.get('x-line-signature');
    if (!signature || !env.LINE_CHANNEL_SECRET ||
        !(await verifyLineSignature_(body, signature, env.LINE_CHANNEL_SECRET))) {
      return new Response('Invalid signature', { status: 401 });
    }
    if (!env.GAS_WEBHOOK_URL || !env.GAS_RELAY_SECRET) {
      return new Response('Relay is not configured', { status: 500 });
    }

    let payload;
    try {
      payload = JSON.parse(body);
    } catch (err) {
      return new Response('Invalid JSON', { status: 400 });
    }

    const relayRequest = fetch(env.GAS_WEBHOOK_URL, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ relaySecret: env.GAS_RELAY_SECRET, payload: payload })
    }).then(async (response) => {
      if (!response.ok) console.error('GAS webhook failed:', response.status, await response.text());
    }).catch((error) => console.error('GAS webhook error:', error));

    // LINE receives 200 quickly; duplicate webhook IDs are guarded in Code.gs.
    ctx.waitUntil(relayRequest);
    return new Response('OK');
  }
};
