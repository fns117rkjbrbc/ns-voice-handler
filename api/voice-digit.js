// Digit handler for the ALB Gather flow.
// SignalWire POSTs Digits + To when the caller presses a key.
// If Digits=="1" → dial the brand's forward (lookup by To in phones.json).
// Anything else → hang up. (If timeout expired and no digit was pressed,
// SignalWire skips the action URL and falls through to the next verb in
// the original Response — so this handler only fires on actual key press.)

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

function dialXml({ forward, action }) {
  const dialAttrs =
    `record="record-from-answer-dual" action="${xmlEscape(action)}" method="POST"`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial ${dialAttrs}>${xmlEscape(forward)}</Dial>
</Response>`;
}

const HANGUP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`;

export default async function handler(req, res) {
  const body = await readBody(req).catch(() => ({}));
  const query = req.query || {};
  const digits = String(body.Digits || body.digits || query.Digits || "").trim();
  const to = normalizeE164(body.To || body.to || body.Called || query.To || "");
  const key = to.replace(/^\+/, "");

  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("X-NS-Digit", digits || "(none)");
  res.setHeader("X-NS-Phone-Key", key || "unknown");

  if (digits !== "1") {
    res.status(200).send(HANGUP_XML);
    return;
  }
  const entry = phones[key];
  const forward = entry?.forward || FALLBACK_FORWARD;
  const action = entry?.action || DEFAULT_ACTION;
  res.status(200).send(dialXml({ forward, action }));
}
