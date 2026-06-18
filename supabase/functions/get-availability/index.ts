import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function chicagoNow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  return { dateStr: `${map.year}-${map.month}-${map.day}`, hhmm: `${map.hour}:${map.minute}` };
}

function addDays(dateStr: string, days: number) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayOfWeek(dateStr: string) {
  return new Date(`${dateStr}T12:00:00Z`).getUTCDay();
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const url = new URL(req.url);
  const days = Math.min(Math.max(parseInt(url.searchParams.get("days") || "21", 10) || 21, 1), 60);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { db: { schema: "portfolio" } },
  );

  const { dateStr: today, hhmm: nowHHMM } = chicagoNow();
  const rangeEnd = addDays(today, days - 1);

  const [{ data: windows, error: winErr }, { data: blocked, error: blockErr }, { data: bookings, error: bookErr }] =
    await Promise.all([
      supabase.from("availability_windows").select("*").eq("active", true),
      supabase.from("blocked_dates").select("blocked_date").gte("blocked_date", today).lte("blocked_date", rangeEnd),
      supabase
        .from("bookings")
        .select("booking_date, booking_time")
        .gte("booking_date", today)
        .lte("booking_date", rangeEnd)
        .in("status", ["pending", "confirmed"]),
    ]);

  if (winErr || blockErr || bookErr) {
    return json({ error: "Failed to load availability" }, 500);
  }

  const blockedSet = new Set((blocked || []).map((b) => b.blocked_date));
  const takenSet = new Set((bookings || []).map((b) => `${b.booking_date}|${b.booking_time.slice(0, 5)}`));
  const windowsByDay = new Map<number, typeof windows>();
  for (const w of windows || []) {
    const list = windowsByDay.get(w.day_of_week) || [];
    list.push(w);
    windowsByDay.set(w.day_of_week, list);
  }

  const slotsByDate: Record<string, string[]> = {};
  for (let i = 0; i < days; i++) {
    const dateStr = addDays(today, i);
    if (blockedSet.has(dateStr)) continue;
    const dow = dayOfWeek(dateStr);
    const dayWindows = windowsByDay.get(dow) || [];
    if (dayWindows.length === 0) continue;

    const times: string[] = [];
    for (const w of dayWindows) {
      const startMin = timeToMinutes(w.start_time);
      const endMin = timeToMinutes(w.end_time);
      for (let m = startMin; m + w.slot_minutes <= endMin; m += w.slot_minutes) {
        const t = minutesToTime(m);
        if (dateStr === today && t <= nowHHMM) continue;
        if (takenSet.has(`${dateStr}|${t}`)) continue;
        times.push(t);
      }
    }
    if (times.length > 0) slotsByDate[dateStr] = times;
  }

  return json({ timezone: "America/Chicago", slotsByDate });
});
