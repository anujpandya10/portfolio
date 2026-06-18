import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function toBase64Url(base64: string) {
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlFromString(str: string) {
  return toBase64Url(btoa(str));
}

function b64urlFromBytes(bytes: Uint8Array) {
  return toBase64Url(btoa(String.fromCharCode(...bytes)));
}

async function hmac(payload: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return b64urlFromBytes(new Uint8Array(sig));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const adminPasscode = Deno.env.get("ADMIN_PASSCODE");
  const adminSecret = Deno.env.get("ADMIN_SECRET");
  if (!adminPasscode || !adminSecret) {
    return json({ error: "Admin auth is not configured yet" }, 500);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const passcode = String(body.passcode || "");
  if (passcode !== adminPasscode) {
    return json({ error: "Incorrect passcode" }, 401);
  }

  const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 8; // 8 hour session
  const payload = b64urlFromString(JSON.stringify({ exp }));
  const sig = await hmac(payload, adminSecret);

  return json({ token: `${payload}.${sig}` });
});
