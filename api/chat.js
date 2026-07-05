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

function extractEmail(text) {
  const match = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  return match ? match[0] : "";
}

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

Si decidís avanzar, para confirmar esta reserva nuestro equipo te solicitará una seña de ${fmtARS(senia)} por transferencia bancaria.

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
  const checkin      = settings["checkin_time"]       || "";
  const checkout     = settings["checkout_time"]      || "";
  const reception    = settings["reception_hours"]    || "";
  const description  = settings["hotel_description"]  || "";
  const services     = settings["hotel_services"]     || "";
  const policies     = settings["hotel_policies"]     || "";
  const personality  = settings["bot_personality"]    || "friendly";
  const customTone   = settings["bot_custom_tone"]    || "";
  const forbidden    = JSON.parse(settings["bot_forbidden"]   || "[]");
  const languages    = JSON.parse(settings["bot_languages"]   || '["es"]');

  const langNote  = languages.includes("en") ? " Si el cliente escribe en inglés, respondé en inglés." : "";
  const langNoteP = languages.includes("pt") ? " Si el cliente escribe en portugués, respondé en portugués." : "";

  const priceLines = Object.entries(prices)
    .slice(0, 60)
    .map(([d, p]) => `${d}: doble=${fmt(p.doble)||"N/D"}, triple=${fmt(p.triple)||"N/D"}, cuádruple=${fmt(p.cuadruple)||"N/D"}`)
    .join("\n");

  const roomList = rooms.map(r => r.name).join(", ") || "doble, triple, cuádruple";
  const forbiddenBlock = forbidden.length > 0
    ? `\nINFORMACIÓN QUE NUNCA PODÉS REVELAR:\n${forbidden.map(f => `- ${f}`).join("\n")}`
    : "";

  return `Sos el asistente virtual de ${hotelName}. Tu objetivo principal es COTIZAR estadías y brindar información. DEBES ACLARAR siempre que no podés confirmar reservas automáticamente y que tu función es brindar presupuesto y derivar al equipo humano para concretar la reserva.

PERSONALIDAD: ${PERSONALITY_PROMPTS[personality] || PERSONALITY_PROMPTS.friendly}${customTone ? `\nTONO ADICIONAL: ${customTone}` : ""}${langNote}${langNoteP}

INFORMACIÓN DEL HOTEL:
- Nombre: ${hotelName}
${hotelAddress ? `- Dirección: ${hotelAddress}` : ""}
${hotelPhone ? `- Teléfono: ${hotelPhone}` : ""}
${hotelWhatsapp ? `- WhatsApp: ${hotelWhatsapp}` : ""}
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

INSTRUCCIONES CRÍTICAS DE COTIZACIÓN Y RESERVA:
- NUNCA calcules precios ni muestres totales vos mismo. El sistema de cotización es automático.
- NUNCA hagas operaciones matemáticas en el chat.
- EQUIVALENCIAS AUTOMÁTICAS: "para 2 personas" → tipo=doble.
- Cuando el cliente pida precio para fechas concretas, respondé ÚNICA Y EXCLUSIVAMENTE con este formato, sin comillas triples (\`\`\`) ni texto extra:
QUOTE_REQUEST:{"checkin":"YYYY-MM-DD","checkout":"YYYY-MM-DD","tipo":"doble|triple|cuadruple"}
- Si el cliente quiere AVANZAR con la reserva o SOLICITARLA, los únicos datos que necesitás son: nombre, fechas, tipo de habitación, cantidad de personas y tipo de cama. Cuando tengas todo, respondé ÚNICA Y EXCLUSIVAMENTE con este formato, sin saltos de línea ni texto extra:
HANDOFF_JSON:{"nombre":"...","checkin":"...","checkout":"...","habitacion":"...","personas":"...","precio":"...","cama":"..."}
- Si falta algún dato, preguntá.
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
    
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) return new Response(JSON.stringify({ error: "API key no configurada" }), { status: 500, headers: cors });

    const { settings, rooms, prices } = await getStaticData();
    const hotelWhatsapp = settings["hotel_whatsapp"] || "";
    const hotelEmail    = settings["hotel_email"] || extractEmail(settings["tpl_confirmacion"] || "");

    if (action === 'config') {
      return new Response(JSON.stringify({
        config: { hotelName: settings["hotel_name"] || "", welcomeMsg: settings["bot_welcome_msg"] || "", enabled: settings["bot_enabled"] !== "false" }
      }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
    }

    if (settings["bot_enabled"] === "false") {
      const offMsg = settings["bot_fallback_msg"] || "El asistente no está disponible.";
      return new Response(JSON.stringify({ reply: offMsg, hotelWhatsapp, hotelEmail }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
    }

    const geminiMessages = messages.map(msg => ({ role: msg.role === "assistant" ? "model" : "user", parts: [{ text: msg.content }] }));
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${GEMINI_API_KEY}`;
    
    const geminiRes = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: buildSystemPrompt(settings, rooms, prices) }] }, contents: geminiMessages, generationConfig: { maxOutputTokens: 600 } }),
    });

    const data = await geminiRes.json();
    const rawReply = data.candidates?.[0]?.content?.parts?.[0]?.text || "Lo siento, no pude procesar tu consulta.";
    let reply = rawReply.trim();

    // FILTRO ANTIBALAS: Extraer JSON limpio de QUOTE_REQUEST
    if (reply.includes("QUOTE_REQUEST:")) {
      try {
        const jsonStr = reply.substring(reply.indexOf("{"), reply.lastIndexOf("}") + 1);
        const qData = JSON.parse(jsonStr);
        const discount = settings["discount"] || "0";
        const extraInfo = `Información adicional:\n- Las tarifas pueden variar si la reserva no se confirma.`;
        const quote = calcQuote(prices, qData.checkin, qData.checkout, qData.tipo, discount, extraInfo);
        
        if (quote && !quote.error) {
          return new Response(JSON.stringify({ reply: quote.text + "\n\n¿Te gustaría que envíe estos datos a recepción para iniciar tu reserva?", quoteData: { checkin: qData.checkin, checkout: qData.checkout, tipo: qData.tipo, precio: quote.totalSinDesc }, hotelWhatsapp, hotelEmail }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
        } else {
          return new Response(JSON.stringify({ reply: quote?.error || "No hay tarifas cargadas para esas fechas.", hotelWhatsapp, hotelEmail }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
        }
      } catch(e) { console.error("Error parseando QUOTE:", e); }
    }

    // FILTRO ANTIBALAS: Extraer JSON limpio de HANDOFF_JSON
    if (reply.includes("HANDOFF_JSON:")) {
      try {
        const jsonStr = reply.substring(reply.indexOf("{"), reply.lastIndexOf("}") + 1);
        const raw = JSON.parse(jsonStr);
        const handoffData = {
          nombre: raw.nombre || "", checkin: raw.checkin || lastQuote?.checkin || "", checkout: raw.checkout || lastQuote?.checkout || "", habitacion: raw.habitacion || lastQuote?.habitacion || "", personas: raw.personas || lastQuote?.personas || "", precio: raw.precio || lastQuote?.precio || "", cama: raw.cama || ""
        };

        const tipo = handoffData.habitacion.toLowerCase().includes("triple") ? "triple" : handoffData.habitacion.toLowerCase().includes("cuadruple") ? "cuadruple" : "doble";
        let quoteText = null;
        
        if (handoffData.checkin && handoffData.checkout) {
          const q = calcQuote(prices, handoffData.checkin, handoffData.checkout, tipo, settings["discount"] || "0", "");
          if (q && !q.error) { handoffData.precio = q.totalSinDesc; handoffData.habitacion = tipo; quoteText = q.text; }
        }
        
        try {
          await insertSupabase("chatbot_leads", { name: handoffData.nombre, phone: "", context: `Hab: ${handoffData.habitacion}, Fechas: ${handoffData.checkin} → ${handoffData.checkout}`, created_at: new Date().toISOString() });
        } catch(e) {}
        
        return new Response(JSON.stringify({ reply: "QUOTE_BEFORE_HANDOFF", handoffData, quoteText, hotelWhatsapp, hotelEmail }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
      } catch(e) { console.error("Error parseando HANDOFF:", e); }
    }

    if (reply === "UNANSWERED" || reply === "OUT_OF_SCOPE") {
      return new Response(JSON.stringify({ reply: settings["bot_fallback_msg"] || "Esa consulta está fuera de mis posibilidades. Podés contactarnos directamente.", handoffData: null, hotelWhatsapp, hotelEmail }), { status: 200, headers: { ...cors, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ reply: reply.replace(/
http://googleusercontent.com/immersive_entry_chip/0

### Un último detalle importante
En el código no modifiqué el mensaje de bienvenida con el que arranca el chat, porque tu sistema lo está tomando de Supabase. Para que el cambio sea 100% efectivo, vas a tener que entrar al *Table Editor* de tu proyecto, buscar la tabla `settings`, encontrar la fila donde la `key` es **`bot_welcome_msg`**, y actualizar ese texto para que ya no diga *"confirmar tu reserva"*, sino algo como *"cotizar tu estadía e iniciar el contacto"*.
