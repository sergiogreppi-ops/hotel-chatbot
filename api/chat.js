export const config = { runtime: "edge" };

const SUPABASE_URL = "https://ozjqqgwcztuummvwpgfu.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im96anFxZ3djenR1dW1tdndwZ2Z1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTA5MTA3NzIsImV4cCI6MjA2NjQ4Njc3Mn0.7L7TliaKQllfY4nF5J8Kh3D0TkeVFoPLjbt2nQ0Er0o";

// ── CACHÉ 6 HORAS ─────────────────────────────────────
const CACHE_TTL = 6 * 60 * 60 * 1000;
let cache = { data: null, ts: 0 };

async function getStaticData() {
  const now = Date.now();
  if (cache.data && (now - cache.ts) < CACHE_TTL) return cache.data;

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

  cache = { data: { settings, rooms, prices }, ts: now };
  return cache.data;
}

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

const PERSONALITY_PROMPTS = {
  formal: "Usá un tono formal, profesional y elegante. Tratá al cliente de 'usted'.",
  friendly: "Usá un tono amigable y cálido. Tratá al cliente de 'vos'.",
  casual: "Usá un tono casual y descontracturado. Podés usar emojis ocasionalmente.",
};

// Extrae el primer email que encuentre en un texto
function extractEmail(text) {
  const match = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : "";
}

// Cálculo EXACTO igual que la app de reservas
function calcQuote(prices, checkin, checkout, tipo, discount, extraInfo = "") {
  const r100  = n => Math.round(n / 100) * 100;
  const r1000 = n => Math.round(n / 1000) * 1000;

  const start = new Date(checkin + "T00:00:00");
  const end   = new Date(checkout + "T00:00:00");
  if (isNaN(start) || isNaN(end) || start >= end) return null;

  const nights = Math.round((end - start) / 86400000);
  let total = 0;
  const missing = [];

  for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
    const ds = d.toISOString().split("T")[0];
    const p  = prices[ds]?.[tipo.toLowerCase()];
    if (!p || p <= 0) missing.push(ds);
    else total += p;
  }

  if (missing.length > 0) return { error: `Sin tarifas para: ${missing.slice(0,3).join(", ")}` };

  const desc          = parseFloat(discount) / 100 || 0;
  const conDescuento  = r100(total * (1 - desc));
  const saldoEfectivo = r1000(conDescuento * (1 - 0.333));
  const senia         = conDescuento - saldoEfectivo;
  const saldoSinDesc  = total - senia;
  const descPorc      = Math.round(desc * 100);

  const fmtARS = n => "$" + Math.round(n).toLocaleString("es-AR");

  return {
    nights,
    tipo,
    checkin,
    checkout,
    totalSinDesc:  fmtARS(total),
    totalConDesc:  fmtARS(conDescuento),
    senia:         fmtARS(senia),
    saldoSinDesc:  fmtARS(saldoSinDesc),
    saldoEfectivo: fmtARS(saldoEfectivo),
    descPorc,
    text: `Habitación: ${tipo}
Check In: ${checkin} / Check Out: ${checkout}
Cantidad de noches: ${nights}
Total de la estadía: ${fmtARS(total)} en un pago.

Promoción: -${descPorc}% de descuento en efectivo: ${fmtARS(conDescuento)}

Para confirmar la reserva se le pedirá una seña de ${fmtARS(senia)} por transferencia bancaria.

El saldo restante se abona al llegar:
${fmtARS(saldoSinDesc)} con cualquier medio de pago el día de llegada.
${fmtARS(saldoEfectivo)} pagando únicamente en efectivo, el día de llegada.${extraInfo ? `\n\n${extraInfo}` : ""}`
  };
}

function buildSystemPrompt(settings, rooms, prices) {
  const today = new Date().toISOString().split("T")[0];
  const hotelName    = settings["hotel_name"]        || "el hotel";
  const hotelPhone   = settings["hotel_phone"]        || "";
  const hotelWhatsapp= settings["hotel_whatsapp"]     || "";
  const hotelAddress = settings["hotel_address"]      || "";
  const hotelEmail   = settings["hotel_email"] || extractEmail(settings["tpl_confirmacion"] || "");
  const discount     = parseFloat(settings["discount"] || "0") / 100;
  const checkin      = settings["checkin_time"]       || "";
  const checkout     = settings["checkout_time"]      || "";
  const reception    = settings["reception_hours"]    || "";
  const description  = settings["hotel_description"]  || "";
  const services     = settings["hotel_services"]     || "";
  const policies     = settings["hotel_policies"]     || "";
  const personality  = settings["bot_personality"]    || "friendly";
  const customTone   = settings["bot_custom_tone"]    || "";
  const fallback     = settings["bot_fallback_msg"]   || "Esa consulta está fuera de mis posibilidades. Podés contactarnos directamente.";
  const forbidden    = JSON.parse(settings["bot_forbidden"]   || "[]");
  const languages    = JSON.parse(settings["bot_languages"]   || '["es"]');

  const langNote  = languages.includes("en") ? " Si el cliente escribe en inglés, respondé en inglés." : "";
  const langNoteP = languages.includes("pt") ? " Si el cliente escribe en portugués, respondé en portugués." : "";

  // Calcular ejemplo de cotización para que la IA entienda el formato
  // (la IA va a replicar esta lógica con los valores reales)
  const r100  = (n) => Math.round(n / 100) * 100;
  const r1000 = (n) => Math.round(n / 1000) * 1000;
  const descPorc = Math.round(discount * 100);

  function calcQuote(total) {
    const conDesc   = r100(total * (1 - discount));
    const saldo     = r1000(conDesc * (1 - 0.333));
    const senia     = conDesc - saldo;
    const saldoSD   = total - senia;
    return { total, conDesc, senia, saldo, saldoSD, descPorc };
  }

  // Ejemplo con $100.000 para que la IA entienda la lógica
  const ej = calcQuote(100000);

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
${hotelPhone ? `- Teléfono para llamadas: ${hotelPhone}` : ""}
${hotelWhatsapp ? `- WhatsApp para mensajes: ${hotelWhatsapp}` : ""}
${hotelEmail ? `- Email: ${hotelEmail}` : ""}
${checkin ? `- Check-in: ${checkin}` : ""}
${checkout ? `- Check-out: ${checkout}` : ""}
${reception ? `- Recepción: ${reception}` : ""}
${description ? `- Descripción: ${description}` : ""}
${services ? `\nSERVICIOS:\n${services}` : ""}
${policies ? `\nPOLÍTICAS:\n${policies}` : ""}
${forbiddenBlock}

HABITACIONES DISPONIBLES: ${roomList}
HOY: ${today}

TARIFAS DISPONIBLES:
${priceLines || "Sin tarifas cargadas."}

INSTRUCCIONES:
- Respondé en español. Máximo 2 oraciones salvo cuando mostrás una cotización.
- EQUIVALENCIAS AUTOMÁTICAS (aplicar siempre sin preguntar):
  * "habitación doble" o "para 2 personas" → tipo=doble, personas=2
  * "habitación triple" o "para 3 personas" → tipo=triple, personas=3
  * "habitación cuádruple" o "para 4 personas" → tipo=cuadruple, personas=4
- Cuando el cliente pida precio para fechas concretas y tengas checkin, checkout y tipo de habitación, respondé ÚNICA Y EXCLUSIVAMENTE con este JSON, sin ningún texto adicional, sin calcular nada vos mismo, sin mostrar precios parciales:
QUOTE_REQUEST:{"checkin":"YYYY-MM-DD","checkout":"YYYY-MM-DD","tipo":"doble|triple|cuadruple"}
- NUNCA calcules precios ni muestres totales vos mismo. El sistema de cotización es automático y calcula descuentos, seña y saldo. Si intentás calcularlo vos, el resultado será incorrecto.
- Si el cliente no especificó las fechas o el tipo de habitación, preguntale solo lo que falta. Nunca preguntes cantidad de personas si ya sabés el tipo, ni el tipo si ya sabés las personas.
- Si el cliente quiere CONFIRMAR o RESERVAR, los únicos datos que necesitás son: nombre, fechas, tipo de habitación, cantidad de personas y tipo de cama (matrimonial o separadas, solo aplica para doble). NUNCA pidas teléfono ni email. Cuando tengas todos los datos, respondé ÚNICA Y EXCLUSIVAMENTE con el JSON, sin ningún texto antes ni después:
HANDOFF_JSON:{"nombre":"...","checkin":"...","checkout":"...","habitacion":"...","personas":"...","precio":"...","cama":"..."}
- Si faltan datos para el handoff, preguntá de a uno.
- Si la consulta no es sobre el hotel: OUT_OF_SCOPE
- Si no tenés información suficiente: UNANSWERED`;
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
    const body = await req.json();
    const { messages, lastQuote, action } = body;
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_API_KEY) return new Response(JSON.stringify({ error: "API key no configurada" }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });

    const { settings, rooms, prices } = await getStaticData();
    const hotelWhatsapp = settings["hotel_whatsapp"] || "";
    const hotelEmail    = settings["hotel_email"] || extractEmail(settings["tpl_confirmacion"] || "");

    // Endpoint de configuración pública para el frontend
    if (action === 'config') {
      return new Response(JSON.stringify({
        config: {
          hotelName:  settings["hotel_name"]      || "",
          welcomeMsg: settings["bot_welcome_msg"] || "",
          enabled:    settings["bot_enabled"]     !== "false",
        }
      }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
    }

    // Verificar si el bot está activo
    if (settings["bot_enabled"] === "false") {
      const offMsg = settings["bot_fallback_msg"] || "El asistente no está disponible en este momento. Por favor contactanos directamente.";
      return new Response(JSON.stringify({ reply: offMsg, hotelWhatsapp, hotelEmail }), {
        status: 200, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 600, system: buildSystemPrompt(settings, rooms, prices), messages }),
    });

    const data = await anthropicRes.json();
    const reply = data.content?.[0]?.text || "Lo siento, no pude procesar tu consulta.";

    // Detectar QUOTE_REQUEST — calcular en el servidor con precisión exacta
    if (reply.trim().startsWith("QUOTE_REQUEST:")) {
      try {
        const qData = JSON.parse(reply.trim().replace("QUOTE_REQUEST:", ""));
        const discount = settings["discount"] || "0";

        // Armar info adicional desde admin — servicios y horarios ya configurados
        const ci = settings["checkin_time"] || "";
        const co = settings["checkout_time"] || "";
        const horarios = ci && co ? `- Check-in ${ci} / Check-out ${co}.` : "";
        const serviciosExtra = settings["quote_extra_info"] || "";
        const extraLines = [serviciosExtra, horarios, "- Las tarifas y promociones pueden variar si la reserva no queda confirmada."]
          .filter(Boolean).join("\n");
        const extraInfo = `Información adicional:\n${extraLines}`;

        const quote = calcQuote(prices, qData.checkin, qData.checkout, qData.tipo, discount, extraInfo);
        if (quote && !quote.error) {
          return new Response(JSON.stringify({ reply: quote.text, hotelWhatsapp: settings["hotel_whatsapp"] || "", hotelEmail: settings["hotel_email"] || extractEmail(settings["tpl_confirmacion"] || "") }), {
            status: 200, headers: { ...cors, "Content-Type": "application/json" },
          });
        } else {
          const errMsg = quote?.error || "No hay tarifas cargadas para esas fechas.";
          return new Response(JSON.stringify({ reply: errMsg, hotelWhatsapp: settings["hotel_whatsapp"] || "", hotelEmail: settings["hotel_email"] || "" }), {
            status: 200, headers: { ...cors, "Content-Type": "application/json" },
          });
        }
      } catch(e) { /* si falla el parse, continúa con la respuesta normal */ }
    }

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

    // Detectar HANDOFF — aunque Claude ponga texto antes del JSON
    let finalReply = reply;

    const handoffMatch = reply.match(/HANDOFF_JSON:(\{.+\})/s);
    if (handoffMatch) {
      try {
        const raw = JSON.parse(handoffMatch[1]);
        const handoffData = {
          nombre:     raw.nombre     || "",
          checkin:    raw.checkin    || lastQuote?.checkin    || "",
          checkout:   raw.checkout   || lastQuote?.checkout   || "",
          habitacion: raw.habitacion || lastQuote?.habitacion || "",
          personas:   raw.personas   || lastQuote?.personas   || "",
          precio:     raw.precio     || lastQuote?.precio     || "",
          cama:       raw.cama       || "",
        };

        // Si no hay precio, calcularlo ahora
        if (!handoffData.precio && handoffData.checkin && handoffData.checkout && handoffData.habitacion) {
          const discount = settings["discount"] || "0";
          const tipo = handoffData.habitacion.toLowerCase().includes("triple") ? "triple"
                     : handoffData.habitacion.toLowerCase().includes("cuádruple") || handoffData.habitacion.toLowerCase().includes("cuadruple") ? "cuadruple"
                     : "doble";
          const q = calcQuote(prices, handoffData.checkin, handoffData.checkout, tipo, discount);
          if (q && !q.error) {
            handoffData.precio = q.totalSinDesc;
            handoffData.habitacion = tipo; // normalizar
          }
        }
        try {
          await insertSupabase("chatbot_leads", {
            name: handoffData.nombre,
            phone: "",
            context: `Hab: ${handoffData.habitacion}, Personas: ${handoffData.personas}, Fechas: ${handoffData.checkin} → ${handoffData.checkout}, Precio: ${handoffData.precio}`,
            created_at: new Date().toISOString(),
          });
        } catch(e) {}
        return new Response(JSON.stringify({ reply: "HANDOFF_READY", handoffData, hotelWhatsapp, hotelEmail }), {
          status: 200, headers: { ...cors, "Content-Type": "application/json" },
        });
      } catch(e) { /* continúa */ }
    }

    if (reply.trim() === "OUT_OF_SCOPE" || reply.trim() === "UNANSWERED") {
      finalReply = settings["bot_fallback_msg"] || "Esa consulta está fuera de mis posibilidades. Podés contactarnos directamente.";
    }

    return new Response(JSON.stringify({ reply: finalReply, handoffData: null, hotelWhatsapp, hotelEmail }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
}
