import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-token",
  "Access-Control-Allow-Methods": "GET, PATCH, OPTIONS",
};

const ALLOWED_STATUSES = ["pending", "confirmed", "declined", "cancelled"];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function fromBase64Url(input: string) {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4 === 0 ? "" : "=".repeat(4 - (base64.length % 4));
  return atob(base64 + pad);
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
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function verifyAdminToken(req: Request): Promise<boolean> {
  const secret = Deno.env.get("ADMIN_SECRET");
  if (!secret) return false;
  const token = req.headers.get("x-admin-token") || "";
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = await hmac(payload, secret);
  if (expected !== sig) return false;
  try {
    const { exp } = JSON.parse(fromBase64Url(payload));
    return typeof exp === "number" && exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  if (!(await verifyAdminToken(req))) {
    return json({ error: "Unauthorized" }, 401);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { db: { schema: "portfolio" } },
  );

  if (req.method === "GET") {
    const url = new URL(req.url);
    const status = url.searchParams.get("status");
    let query = supabase.from("bookings").select("*").order("booking_date", { ascending: true }).order("booking_time", { ascending: true });
    if (status && ALLOWED_STATUSES.includes(status)) query = query.eq("status", status);
    const { data, error } = await query;
    if (error) return json({ error: "Failed to load bookings" }, 500);
    return json({ bookings: data });
  }

  if (req.method === "PATCH") {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    const id = String(body.id || "");
    const status = String(body.status || "");
    if (!id || !ALLOWED_STATUSES.includes(status)) {
      return json({ error: "Invalid id or status" }, 400);
    }
    const { data, error } = await supabase.from("bookings").update({ status }).eq("id", id).select().single();
    if (error) return json({ error: "Failed to update booking" }, 500);
    return json({ booking: data });
  }

  return json({ error: "Method not allowed" }, 405);
});
