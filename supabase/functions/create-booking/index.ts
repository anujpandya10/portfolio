import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const NOTIFY_EMAIL = "iam@iamtalentco.com";

const REASON_LABELS: Record<string, string> = {
  "i-am": "I AM (Venture Studio)",
  "fresh-dabba": "Fresh Dabba",
  "villageconnect": "VillageConnect",
  "pawsconnect": "PawsConnect",
  "general": "General / Something Else",
};

const METHOD_LABELS: Record<string, string> = {
  "video": "Video Call",
  "phone": "Phone Call",
  "in-person": "In-Person (Houston, TX)",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function timeToMinutes(t: string) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTime(m: number) {
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function dayOfWeek(dateStr: string) {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay();
}

function formatDateLabel(dateStr: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${dateStr}T12:00:00Z`));
}

function formatTimeLabel(time: string) {
  const [h, m] = time.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period} Central`;
}

async function sendEmail(to: string[], subject: string, html: string) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    console.error("RESEND_API_KEY not set; skipping email send");
    return;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Anuj Pandya — Booking <onboarding@resend.dev>",
        to,
        subject,
        html,
      }),
    });
    if (!res.ok) console.error("Resend error", res.status, await res.text());
  } catch (e) {
    console.error("Resend request failed", e);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim();
  const company = String(body.company || "").trim();
  const phone = String(body.phone || "").trim();
  const reason = String(body.reason || "").trim();
  const connectionMethod = String(body.connectionMethod || "").trim();
  const message = String(body.message || "").trim();
  const date = String(body.date || "").trim();
  const time = String(body.time || "").trim();

  if (!name || !email || !reason || !connectionMethod || !date || !time) {
    return json({ error: "Missing required fields" }, 400);
  }
  if (!isValidEmail(email)) return json({ error: "Invalid email address" }, 400);
  if (!REASON_LABELS[reason]) return json({ error: "Invalid reason" }, 400);
  if (!METHOD_LABELS[connectionMethod]) return json({ error: "Invalid connection method" }, 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    return json({ error: "Invalid date/time" }, 400);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { db: { schema: "portfolio" } },
  );

  const [{ data: blocked }, { data: windows }] = await Promise.all([
    supabase.from("blocked_dates").select("blocked_date").eq("blocked_date", date),
    supabase.from("availability_windows").select("*").eq("active", true).eq("day_of_week", dayOfWeek(date)),
  ]);

  if (blocked && blocked.length > 0) {
    return json({ error: "That date is no longer available. Please pick another." }, 409);
  }

  const slotMin = timeToMinutes(time);
  const fitsWindow = (windows || []).some((w) => {
    const startMin = timeToMinutes(w.start_time);
    const endMin = timeToMinutes(w.end_time);
    return slotMin >= startMin && slotMin + w.slot_minutes <= endMin && (slotMin - startMin) % w.slot_minutes === 0;
  });
  if (!fitsWindow) {
    return json({ error: "That time is no longer available. Please pick another." }, 409);
  }

  const { data: inserted, error: insertErr } = await supabase
    .from("bookings")
    .insert({
      name,
      email,
      company: company || null,
      phone: phone || null,
      reason,
      connection_method: connectionMethod,
      message: message || null,
      booking_date: date,
      booking_time: minutesToTime(slotMin),
      status: "pending",
    })
    .select()
    .single();

  if (insertErr) {
    if (insertErr.code === "23505") {
      return json({ error: "That time was just booked by someone else. Please pick another." }, 409);
    }
    console.error("Insert booking failed", insertErr);
    return json({ error: "Failed to create booking" }, 500);
  }

  const dateLabel = formatDateLabel(date);
  const timeLabel = formatTimeLabel(time);
  const reasonLabel = REASON_LABELS[reason];
  const methodLabel = METHOD_LABELS[connectionMethod];

  const ownerHtml = `
    <h2>New booking request</h2>
    <p><strong>${escapeHtml(name)}</strong> (${escapeHtml(email)}) wants to talk about <strong>${escapeHtml(reasonLabel)}</strong>.</p>
    <ul>
      <li><strong>When:</strong> ${escapeHtml(dateLabel)} at ${escapeHtml(timeLabel)}</li>
      <li><strong>Format:</strong> ${escapeHtml(methodLabel)}</li>
      <li><strong>Company:</strong> ${escapeHtml(company || "—")}</li>
      <li><strong>Phone:</strong> ${escapeHtml(phone || "—")}</li>
    </ul>
    <p><strong>Message:</strong><br>${escapeHtml(message || "—").replace(/\n/g, "<br>")}</p>
    <p>Status: pending — review and confirm from your admin dashboard.</p>
  `;

  const visitorHtml = `
    <h2>Thanks, ${escapeHtml(name)} — request received</h2>
    <p>You requested a ${escapeHtml(methodLabel.toLowerCase())} about <strong>${escapeHtml(reasonLabel)}</strong> on:</p>
    <p style="font-size:1.1em"><strong>${escapeHtml(dateLabel)} at ${escapeHtml(timeLabel)}</strong></p>
    <p>This is a request, not a confirmed meeting yet — Anuj will confirm shortly by email. If anything changes on his end, you'll hear directly from him at ${escapeHtml(email)}.</p>
    <p>If you need to reach him sooner, reply to this email or contact iam@iamtalentco.com.</p>
  `;

  await Promise.all([
    sendEmail([NOTIFY_EMAIL], `New booking request — ${reasonLabel} — ${name}`, ownerHtml),
    sendEmail([email], "Got it — your booking request was received", visitorHtml),
  ]);

  return json({ success: true, booking: { id: inserted.id, date, time, status: "pending" } });
});
