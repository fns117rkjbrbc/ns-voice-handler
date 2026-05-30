// SignalWire LaML voice webhook.
// SignalWire POSTs application/x-www-form-urlencoded with To/From/CallSid/...
// We look up the dialed number in data/phones.json and respond with LaML.
//
// Brand routing:
//   ALB → Greeting + "Press 1 to be connected" IVR (filters spam),
//         retries the prompt once, then hangs up if no input.
//   SMSSC → Greeting only, then hangup (no forwarding; buyer not yet wired).
//   Other brands → Greeting + immediate Dial to the brand forward.

import phones from "../data/phones.json" with { type: "json" };

const FALLBACK_FORWARD = "+14302263095";
const DEFAULT_ACTION = "https://your-n8n-webhook-url.com/call-complete";

const PRESS_1_MP3 = "https://pub-ea83f771b0e5402ab21e46c842f82083.r2.dev/greetings/_alb_press1.mp3";
const DIGIT_HANDLER_URL = "https://ns-voice-handler.vercel.app/api/voice-digit";
const GATHER_TIMEOUT_SEC = 5;

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeE164(raw) {
  if (!raw) return "";
  const digits = String(raw).replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.length === 10) return "+1" + digits;
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  return digits.startsWith("+") ? digits : "+" + digits;
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return Object.fromEntries(new URLSearchParams(req.body));
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return Object.fromEntries(new URLSearchParams(raw));
}

function greetingOnlyResponse({ play }) {
  const playTag = play ? `<Play>${xmlEscape(play)}</Play>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${playTag}
  <Hangup/>
</Response>`;
}

function dialResponse({ play, forward, action }) {
  const dialAttrs =
    `record="record-from-answer-dual" action="${xmlEscape(action)}" method="POST"`;
  const playTag = play ? `<Play>${xmlEscape(play)}</Play>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${playTag}
  <Dial ${dialAttrs}>${xmlEscape(forward)}</Dial>
</Response>`;
}

// ALB IVR: greeting → press-1 → retry press-1 → hangup if no input.
// SignalWire passes To/Called through to the Gather action URL so the
// digit handler can resolve the brand's forward number from phones.json.
function ivrResponse({ play }) {
  const gatherAttrs =
    `numDigits="1" timeout="${GATHER_TIMEOUT_SEC}" ` +
    `action="${xmlEscape(DIGIT_HANDLER_URL)}" method="POST"`;
  const greetingTag = play ? `<Play>${xmlEscape(play)}</Play>` : "";
  const promptTag = `<Play>${xmlEscape(PRESS_1_MP3)}</Play>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${greetingTag}
  <Gather ${gatherAttrs}>
    ${promptTag}
  </Gather>
  <Gather ${gatherAttrs}>
    ${promptTag}
  </Gather>
  <Hangup/>
</Response>`;
}

export default async function handler(req, res) {
  const body = await readBody(req).catch(() => ({}));
  const query = req.query || {};
  const to = normalizeE164(body.To || body.to || query.To || query.to || "");
  const key = to.replace(/^\+/, "");

  const entry = phones[key];
  const play = entry?.mp3_url || "";
  const forward = entry?.forward || FALLBACK_FORWARD;
  const action = entry?.action || DEFAULT_ACTION;
  const brand = entry?.brand || "";

  const ivrBrands = new Set(["ALB"]);
  const greetingOnlyBrands = new Set(["SMSSC"]);
  let xml;
  if (greetingOnlyBrands.has(brand)) {
    xml = greetingOnlyResponse({ play });
  } else if (ivrBrands.has(brand)) {
    xml = ivrResponse({ play });
  } else {
    xml = dialResponse({ play, forward, action });
  }

  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("X-NS-Phone-Key", key || "unknown");
  res.setHeader("X-NS-Brand", brand || "unknown");
  res.setHeader("X-NS-Has-Greeting", play ? "1" : "0");
  res.status(200).send(xml);
}
