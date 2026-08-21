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

// Per-brand press-1 spam-filter prompt. A brand only runs the press-1 IVR when
// it has a prompt here (or a press1_url on its phones.json entry); otherwise it
// falls through to greeting + immediate Dial to the brand forward.
const BRAND_PRESS1 = {
  ALB: "https://pub-ea83f771b0e5402ab21e46c842f82083.r2.dev/greetings/_alb_press1.mp3",
  // SMSSC: greeting -> press-1 spam filter -> Dial the Genex line (+18886651257).
  // Prompt is Jamie (fleet voice), matching the city greetings.
  SMSSC: "https://pub-ea83f771b0e5402ab21e46c842f82083.r2.dev/greetings/_smssc_press1.mp3",
  // GX: Genex-branded PPC site (sellmystructuredsettlement.org). Same flow and
  // audio as SMSSC (the recorded brand name matches); brand=GX in the action
  // query keeps call attribution deterministic.
  GX: "https://pub-ea83f771b0e5402ab21e46c842f82083.r2.dev/greetings/_smssc_press1.mp3",
  // HB brands (added when PropertyLeads dropped their intake IVR): press-1 gate
  // before the Dial. Per-entry press1_url (CHB DMV 32) wins over these.
  CHB: "https://pub-ea83f771b0e5402ab21e46c842f82083.r2.dev/greetings/_chb_press1.mp3",
  DHB: "https://pub-ea83f771b0e5402ab21e46c842f82083.r2.dev/greetings/_dhb_press1.mp3",
  FHB: "https://pub-ea83f771b0e5402ab21e46c842f82083.r2.dev/greetings/_fhb_press1.mp3",
  HHB: "https://pub-ea83f771b0e5402ab21e46c842f82083.r2.dev/greetings/_hhb_press1.mp3",
  SS:  "https://pub-ea83f771b0e5402ab21e46c842f82083.r2.dev/greetings/_ss_press1.mp3",
};

const HB_RETRY = "https://pub-ea83f771b0e5402ab21e46c842f82083.r2.dev/greetings/_hb_press1_retry.mp3";
const BRAND_PRESS1_RETRY = { CHB: HB_RETRY, DHB: HB_RETRY, FHB: HB_RETRY, HHB: HB_RETRY, SS: HB_RETRY };
// Brands past Google GBP verification: skip the city greeting, forward on ring.
// Greeting mp3s stay in phones.json - re-enable by removing the brand here.
const NO_GREETING_BRANDS = new Set(["DHB", "CHB"]);

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
function ivrResponse({ play, prompt, retryPrompt }) {
  const gatherAttrs =
    `numDigits="1" timeout="${GATHER_TIMEOUT_SEC}" ` +
    `action="${xmlEscape(DIGIT_HANDLER_URL)}" method="POST"`;
  const greetingTag = play ? `<Play>${xmlEscape(play)}</Play>` : "";
  const promptTag = `<Play>${xmlEscape(prompt)}</Play>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  ${greetingTag}
  <Gather ${gatherAttrs}>
    ${promptTag}
  </Gather>
  <Gather ${gatherAttrs}>
    ${retryPrompt ? `<Play>${xmlEscape(retryPrompt)}</Play>` : promptTag}
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

  const greetingOnlyBrands = new Set([]);
  const press1 = entry?.press1_url || BRAND_PRESS1[brand] || "";
  let xml;
  if (greetingOnlyBrands.has(brand)) {
    xml = greetingOnlyResponse({ play });
  } else if (press1) {
    // Press-1 spam filter in front of the Dial (ALB, and any brand once it has a prompt).
    xml = ivrResponse({ play: NO_GREETING_BRANDS.has(brand) ? "" : play, prompt: press1, retryPrompt: entry?.press1_retry_url || BRAND_PRESS1_RETRY[brand] || "" });
  } else {
    // Greeting then immediate Dial to the brand forward (SMSSC -> Genex line).
    // Verified brands (NO_GREETING_BRANDS) forward on ring with no greeting.
    // entry.play_override (e.g. a consent bumper for partner-forwarded numbers) beats the brand skip.
    xml = dialResponse({ play: entry?.play_override || (NO_GREETING_BRANDS.has(brand) ? "" : play), forward, action });
  }

  res.setHeader("Content-Type", "application/xml; charset=utf-8");
  res.setHeader("X-NS-Phone-Key", key || "unknown");
  res.setHeader("X-NS-Brand", brand || "unknown");
  res.setHeader("X-NS-Has-Greeting", play ? "1" : "0");
  res.status(200).send(xml);
}
