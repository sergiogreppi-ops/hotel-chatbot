export const config = { runtime: "edge" };

const SUPABASE_URL = "https://ozjqqgwcztuummvwpgfu.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im96anFxZ3djenR1dW1tdndwZ2Z1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTA5MTA3NzIsImV4cCI6MjA2NjQ4Njc3Mn0.7L7TliaKQllfY4nF5J8Kh3D0TkeVFoPLjbt2nQ0Er0o";

async function fetchSupabase(table, select = "*", params = "") {
  const url = `${SUPABASE_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}${params}`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  return res.json();
}

async function insertSupabase(table, data) {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(data),
  });
}

function fmt(n) {
  return n && n > 0 ? "$" + Math.round(n).toLocaleString("es-AR") : null;
}

const SERVICE_LABELS = {
  wifi: "WiFi gratuito", parking: "Estacionamiento", pool: "Pileta/piscina",
  breakfast: "Desayuno incluido", restaurant: "Restaurante", gym: "Gimnasio",
  spa: "Spa", bar: "Bar", laundry: "Lavandería", transfer: "Transfer al aeropuerto",
  roomservice: "Room service", bbq: "Parrilla/BBQ",
};
const POLICY_LABELS = {
  pets: "Se aceptan mascotas", nosmoking: "No se permite fumar",
  smoking: "Hay área de fumadores", kids: "Apto para niños",
  adults: "Solo adultos (+18)", events: "Se permiten eventos",
  noevents: "No se permiten eventos ni fiestas",
};
const PERSONALITY_PROMPTS = {
  formal: "Usá un tono formal, profesional y elegante. Tratá al cliente de 'usted'.",
  friendly: "Usá un tono amigable y cálido. Tratá al cliente de 'vos'.",
  casual: "Usá un tono casual y descontracturado. Podés usar emojis ocasionalmente.",
};

function buildSystemPrompt(settings, rooms, prices) {
  const today = new Date().toISOString().split("T")[0];
  const hotelName    = settings["hotel_name"]        || "el hotel";
  const hotelPhone   = settings["hotel_phone"]        || "";
  const hotelAddress = settings["hotel_address"]      || "";
  const hotelEmail   = settings["hotel_email"]        || "";
  const checkin      = settings["checkin_time"]       || "";
  const checkout     = settings["checkout_time"]      || "";
  const reception    = settings["reception_hours"]    || "";
  const description  = settings["hotel_description"]  || "";
  const personality  = settings["bot_personality"]    || "friendly";
  const customTone   = settings["bot_custom_tone"]    || "";
  const fallback     = settings["bot_fallback_msg"]   || "Esa consulta está fuera de mis posibilidades. Podés contactarnos directamente.";
  const forbidden    = JSON.parse(settings["bot_forbidden"]   || "[]");
  const services     = JSON.parse(settings["hotel_services"]  || "[]");
  const policies     = JSON.parse(settings["hotel_policies"]  || "[]");
  const languages    = JSON.parse(settings["bot_languages"]   || '["es"]');

  const servicesList = services.map(s => SERVICE_LABELS[s] || s).join(", ") || "consultar al hotel";
  const policiesList = policies.map(p => POLICY_LABELS[p] || p).join(". ");
  const langNote     = languages.includes("en") ? " Si el cliente escribe en inglés, respondé en inglés." : "";
  const langNoteP    = languages.includes("pt") ? " Si el cliente escribe en portugués, respondé en portugués." : "";

  const priceLines = Object.entries(prices)
    .slice(0, 60)
    .map(([d, p]) => `${d}: doble=${fmt(p.doble)||"N/D"}, triple=${fmt(p.triple)||"N/D"}, cuádruple=${fmt(p.cuadruple)||"N/D"}`)
    .join("\n");

  const roomList = rooms.map(r => r.name).join(", ") || "doble, triple, cuádruple";
  const forbiddenBlock = forbidden.length > 0
    ? `\nINFORMACIÓN QUE NUNCA PODÉS REVELAR:\n${forbidden.map(f => `- ${f}`).join("\n")}`
    : "";

  return `Sos el asistente virtual de ${hotelName}. Respondés ÚNICAMENTE consultas sobre habitaciones, precios y servicios del hotel. Nunca revelás info de otros huéspedes ni datos internos.

PERSONALIDAD: ${PERSONALITY_PROMPTS[personality] || PERSONALITY_PROMPTS.friendly}${customTone ? `\nTONO ADICIONAL: ${customTone}` : ""}${langNote}${langNoteP}

INFORMACIÓN DEL HOTEL:
- Nombre: ${hotelName}
${hotelAddress ? `- Dirección: ${hotelAddress}` : ""}
${hotelPhone ? `- Teléfono: ${hotelPhone}` : ""}
${hotelEmail ? `- Email: ${hotelEmail}` : ""}
${checkin ? `- Check-in: ${checkin}` : ""}
${checkout ? `- Check-out: ${checkout}` : ""}
${reception ? `- Recepción: ${reception}` : ""}
${description ? `- Descripción: ${description}` : ""}
- Servicios: ${servicesList}
${policiesList ? `- Políticas: ${policiesList}` : ""}
${forbiddenBlock}

HABITACIONES: ${roomList}
HOY: ${today}

TARIFAS POR NOCHE:
${priceLines || "Sin tarifas cargadas."}

INSTRUCCIONES:
- Respondé en español. Máximo 3-4 oraciones por respuesta.
- Si preguntan precios para fechas específicas, calculá el total sumando las tarifas noche por noche.
- Si el cliente quiere CONFIRMAR, RESERVAR o dejar sus datos, respondé exactamente: HANDOFF_REQUESTED
- Si la consulta no es sobre el hotel, respondé exactamente: OUT_OF_SCOPE
- Si no tenés información suficiente para responder bien, respondé exactamente: UNANSWERED`;
}

export default async function handler(req) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });

  try {
    const { messages } = await req.json();
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_API_KEY) return new Response(JSON.stringify({ error: "API key no configurada" }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });

    const today = new Date().toISOString().split("T")[0];
    const future = new Date(); future.setMonth(future.getMonth() + 6);
    const futureStr = future.toISOString().split("T")[0];

    const [settingsData, roomsData, pricesData] = await Promise.all([
      fetchSupabase("settings", "key,value"),
      fetchSupabase("rooms", "id,name", "&order=id"),
      fetchSupabase("daily_prices", "date,doble,triple,cuadruple", `&date=gte.${today}&date=lte.${futureStr}&order=date`),
    ]);

    const settings = {};
    if (Array.isArray(settingsData)) settingsData.forEach(s => { settings[s.key] = s.value; });
    const rooms = Array.isArray(roomsData) ? roomsData : [];
    const prices = {};
    if (Array.isArray(pricesData)) pricesData.forEach(p => { prices[p.date] = { doble: p.doble, triple: p.triple, cuadruple: p.cuadruple }; });

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 600, system: buildSystemPrompt(settings, rooms, prices), messages }),
    });

    const data = await anthropicRes.json();
    const reply = data.content?.[0]?.text || "Lo siento, no pude procesar tu consulta.";

    // Registrar preguntas sin respuesta
    if (reply.trim() === "UNANSWERED" || reply.trim() === "OUT_OF_SCOPE") {
      const lastUser = [...messages].reverse().find(m => m.role === "user");
      if (lastUser) {
        try {
          await insertSupabase("chatbot_unanswered", {
            question: lastUser.content.substring(0, 500),
            status: "pending",
            context: messages.slice(-4).map(m => `${m.role}: ${m.content}`).join(" | ").substring(0, 500),
            frequency: 1,
            created_at: new Date().toISOString(),
          });
        } catch(e) {}
      }
    }

    // Reemplazar códigos internos por mensaje de fallback
    const finalReply = (reply.trim() === "OUT_OF_SCOPE" || reply.trim() === "UNANSWERED")
      ? (settings["bot_fallback_msg"] || "Esa consulta está fuera de mis posibilidades. Podés contactarnos directamente.")
      : reply;

    return new Response(JSON.stringify({ reply: finalReply }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
}
