// SignalWire LaML voice webhook.
// SignalWire POSTs application/x-www-form-urlencoded with To/From/CallSid/...
// We look up the dialed number in data/phones.json and respond with LaML
// that plays the per-phone MP3 then dials the forward number.

import phones from "../data/phones.json" with { type: "json" };

const FALLBACK_FORWARD = "+14302263095";
const DEFAULT_ACTION = "https://your-n8n-webhook-url.com/call-complete";

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

function buildResponse({ play, forward, action }) {
  const dialAttrs =
    `record="record-from-answer-dual" action="${xmlEscape(action)}" method="POST"`;
  const playTag = play ? `<Play>${xmlEscape(play)}</Play>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${playTag}
  <Dial ${dialAttrs}>${xmlEscape(forward)}</Dial>
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

  const xml = buildResponse({ play, forward, action });
  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("X-NS-Phone-Key", key || "unknown");
  res.setHeader("X-NS-Has-Greeting", play ? "1" : "0");
  res.status(200).send(xml);
}
