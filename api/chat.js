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

HABITACIONES: ${roomList}
HOY: ${today}

TARIFAS POR NOCHE:
${priceLines || "Sin tarifas cargadas."}

CÓMO CALCULAR Y PRESENTAR UNA COTIZACIÓN:
Cuando el cliente pregunta el precio para fechas específicas, calculá el total sumando las tarifas noche por noche, luego aplicá esta lógica EXACTA (igual que la app de reservas):

1. totalSinDescuento = suma de tarifas de cada noche
2. totalConDescuento = redondear al $100 más cercano (totalSinDescuento × ${1 - discount})
3. saldoEfectivo     = redondear al $1000 más cercano (totalConDescuento × 0.667)
4. senia             = totalConDescuento - saldoEfectivo
5. saldoSinDescuento = totalSinDescuento - senia

EJEMPLO con total $${ej.total.toLocaleString("es-AR")}:
- Total sin descuento: $${ej.total.toLocaleString("es-AR")}
- Total con descuento (${ej.descPorc}% off en efectivo): $${ej.conDesc.toLocaleString("es-AR")}
- Seña: $${ej.senia.toLocaleString("es-AR")}
- Saldo sin descuento: $${ej.saldoSD.toLocaleString("es-AR")}
- Saldo en efectivo: $${ej.saldo.toLocaleString("es-AR")}

FORMATO DE RESPUESTA para cotizaciones (usá exactamente este formato):
Habitación: [tipo]
Check In: [fecha] / Check Out: [fecha]
Noches: [n]
Total de la estadía: $[total_sin_descuento] en un pago.

Promoción: -${descPorc}% de descuento en efectivo: $[total_con_descuento]

Para confirmar la reserva se le pedirá una seña de $[senia] por transferencia bancaria.

El saldo restante se abona al llegar:
$[saldo_sin_desc] con cualquier medio de pago.
$[saldo_efectivo] pagando en efectivo (con descuento).

HABITACIONES: ${roomList}
HOY: ${today}

TARIFAS POR NOCHE:
${priceLines || "Sin tarifas cargadas."}

INSTRUCCIONES:
- Respondé en español. Máximo 2 oraciones salvo cuando cotizás precios.
- Si preguntan precios para fechas específicas, usá el formato de cotización de arriba con los cálculos exactos.
- Si el cliente quiere CONFIRMAR, RESERVAR o dejar sus datos, primero verificá si ya tenés en la conversación: nombre, fechas (checkin y checkout), tipo de habitación y cantidad de personas. Si faltan datos, preguntá SOLO los que faltan de a uno. Cuando tengas TODOS esos datos, respondé EXACTAMENTE con este JSON (sin texto adicional):
HANDOFF_JSON:{"nombre":"...","checkin":"...","checkout":"...","habitacion":"...","personas":"...","precio":"..."}
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

    // Detectar HANDOFF con datos JSON
    let finalReply = reply;
    let handoffData = null;

    if (reply.trim().startsWith("HANDOFF_JSON:")) {
      try {
        handoffData = JSON.parse(reply.trim().replace("HANDOFF_JSON:", ""));
        // Guardar lead en Supabase
        try {
          await insertSupabase("chatbot_leads", {
            name: handoffData.nombre || "",
            phone: "",
            context: `Hab: ${handoffData.habitacion}, Personas: ${handoffData.personas}, Fechas: ${handoffData.checkin} → ${handoffData.checkout}, Precio: ${handoffData.precio}`,
            created_at: new Date().toISOString(),
          });
        } catch(e) {}
        finalReply = "HANDOFF_READY";
      } catch(e) {
        finalReply = reply;
      }
    } else if (reply.trim() === "OUT_OF_SCOPE" || reply.trim() === "UNANSWERED") {
      finalReply = settings["bot_fallback_msg"] || "Esa consulta está fuera de mis posibilidades. Podés contactarnos directamente.";
    }

    return new Response(JSON.stringify({ reply: finalReply, handoffData, hotelWhatsapp: settings["hotel_whatsapp"] || "", hotelEmail: settings["hotel_email"] || "" }), {
      status: 200, headers: { ...cors, "Content-Type": "application/json" },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } });
  }
}
