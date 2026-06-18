import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-token",
  "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
};

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

function isValidTime(t: unknown): t is string {
  return typeof t === "string" && /^\d{2}:\d{2}(:\d{2})?$/.test(t);
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

  const url = new URL(req.url);

  if (req.method === "GET") {
    const [{ data: windows, error: winErr }, { data: blocked, error: blockErr }] = await Promise.all([
      supabase.from("availability_windows").select("*").order("day_of_week", { ascending: true }),
      supabase.from("blocked_dates").select("*").order("blocked_date", { ascending: true }),
    ]);
    if (winErr || blockErr) return json({ error: "Failed to load availability" }, 500);
    return json({ windows, blocked });
  }

  if (req.method === "PUT") {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    const windows = body.windows;
    if (!Array.isArray(windows)) return json({ error: "windows must be an array" }, 400);

    for (const w of windows) {
      if (
        typeof w !== "object" ||
        w === null ||
        typeof (w as Record<string, unknown>).day_of_week !== "number" ||
        !isValidTime((w as Record<string, unknown>).start_time) ||
        !isValidTime((w as Record<string, unknown>).end_time) ||
        typeof (w as Record<string, unknown>).slot_minutes !== "number"
      ) {
        return json({ error: "Invalid window entry" }, 400);
      }
    }

    const { error: deleteErr } = await supabase.from("availability_windows").delete().neq("id", "00000000-0000-0000-0000-000000000000");
    if (deleteErr) return json({ error: "Failed to clear existing windows" }, 500);

    if (windows.length > 0) {
      const rows = windows.map((w: Record<string, unknown>) => ({
        day_of_week: w.day_of_week,
        start_time: w.start_time,
        end_time: w.end_time,
        slot_minutes: w.slot_minutes,
        active: w.active !== false,
      }));
      const { error: insertErr } = await supabase.from("availability_windows").insert(rows);
      if (insertErr) return json({ error: "Failed to save windows" }, 500);
    }

    return json({ success: true });
  }

  if (req.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    const blockedDate = String(body.blocked_date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(blockedDate)) return json({ error: "Invalid blocked_date" }, 400);
    const reason = body.reason ? String(body.reason) : null;
    const { error } = await supabase.from("blocked_dates").insert({ blocked_date: blockedDate, reason });
    if (error) {
      if (error.code === "23505") return json({ error: "Date already blocked" }, 409);
      return json({ error: "Failed to block date" }, 500);
    }
    return json({ success: true });
  }

  if (req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "Missing id" }, 400);
    const { error } = await supabase.from("blocked_dates").delete().eq("id", id);
    if (error) return json({ error: "Failed to delete" }, 500);
    return json({ success: true });
  }

  return json({ error: "Method not allowed" }, 405);
});
