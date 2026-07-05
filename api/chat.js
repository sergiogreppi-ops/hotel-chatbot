export const config = { runtime: "edge" };

// ── CONFIG POR VARIABLES DE ENTORNO ───────────────────
// En Vercel → Settings → Environment Variables agregar:
//   SUPABASE_URL      = https://pozunquwpuxqgiuajuft.supabase.co
//   SUPABASE_ANON_KEY = (anon key del proyecto NUEVO, Settings → API)
//   GEMINI_API_KEY    = (ya la tenés)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

// ── CACHÉ 10 MINUTOS ──────────────────────────────────
const CACHE_TTL = 10 * 60 * 1000;
let cache = { data: null, ts: 0 };

const SETTINGS_KEYS = [
  "hotel_name", "hotel_phone", "hotel_whatsapp", "hotel_address",
  "hotel_email", "checkin_time", "checkout_time", "reception_hours",
  "hotel_description", "hotel_services", "hotel_policies",
  "quote_extra_info", "bot_personality", "bot_custom_tone",
  "bot_welcome_msg", "bot_fallback_msg", "bot_forbidden",
  "bot_languages", "bot_enabled", "discount", "tpl_confirmacion",
];

function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch (e) { return fallback; }
}

// ── Extracción robusta de un objeto JSON dentro de un texto ───────────
// Escanea desde la primera "{" contando llaves balanceadas y respetando
// las comillas (para no cortar en una "}" que esté dentro de un string).
// Devuelve el substring del objeto o null si viene TRUNCADO/incompleto.
// Reemplaza al viejo substring(indexOf("{"), lastIndexOf("}")) que fallaba
// si el modelo no cerraba la llave o mandaba texto extra alrededor.
function extractJsonObject(text) {
  if (!text) return null;
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null; // llaves sin cerrar → JSON truncado
}

// Rescata un campo string de un JSON aunque esté truncado/mal formado,
// leyéndolo con una regex tolerante. Ej: "nombre":"Oscar delaolla".
function looseField(text, field) {
  if (!text) return "";
  const m = text.match(new RegExp(`"${field}"\\s*:\\s*"([^"]*)"`));
  return m ? m[1].trim() : "";
}

async function getStaticData() {
  const now = Date.now();
  if (cache.data && (now - cache.ts) < CACHE_TTL) return cache.data;

  const today = new Date().toISOString().split("T")[0];
  const future = new Date(); future.setMonth(future.getMonth() + 6);
  const futureStr = future.toISOString().split("T")[0];

  const [settingsData, roomsData, pricesData] = await Promise.all([
    fetchSupabase("settings", "key,value", `&key=in.(${SETTINGS_KEYS.join(",")})`),
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

async function rpcSupabase(fn, args) {
  await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify(args),
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

function tipoFromHab(hab) {
  const h = (hab || "").toLowerCase();
  if (h.includes("triple")) return "triple";
  if (h.includes("cuadruple") || h.includes("cuádruple")) return "cuadruple";
  return "doble";
}

// Mismos redondeos que quote.js de la app principal.
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
    nights, tipo, checkin, checkout,
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
  const checkin      = settings["checkin_time"]       || "";
  const checkout     = settings["checkout_time"]      || "";
  const reception    = settings["reception_hours"]    || "";
  const description  = settings["hotel_description"]  || "";
  const services     = settings["hotel_services"]     || "";
  const policies     = settings["hotel_policies"]     || "";
  const personality  = settings["bot_personality"]    || "friendly";
  const customTone   = settings["bot_custom_tone"]    || "";
  const forbidden    = safeJsonParse(settings["bot_forbidden"] || "[]", []);
  const languages    = safeJsonParse(settings["bot_languages"] || '["es"]', ["es"]);

  const langNote  = languages.includes("en") ? " Si el cliente escribe en inglés, respondé en inglés." : "";
  const langNoteP = languages.includes("pt") ? " Si el cliente escribe en portugués, respondé en portugués." : "";

  const priceLines = Object.entries(prices)
    .slice(0, 60)
    .map(([d, p]) => `${d}: doble=${fmt(p.doble)||"N/D"}, triple=${fmt(p.triple)||"N/D"}, cuádruple=${fmt(p.cuadruple)||"N/D"}`)
    .join("\n");

  const roomList = rooms.map(r => r.name).join(", ") || "doble, triple, cuádruple";
  const forbiddenBlock = Array.isArray(forbidden) && forbidden.length > 0
    ? `\nINFORMACIÓN QUE NUNCA PODÉS REVELAR:\n${forbidden.map(f => `- ${f}`).join("\n")}`
    : "";

  return `Sos el asistente virtual de ${hotelName}. Respondés ÚNICAMENTE consultas sobre habitaciones, precios y servicios del hotel.

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
- Cuando el cliente pida precio para fechas concretas, respondé ÚNICA Y EXCLUSIVAMENTE con este formato exacto, en UNA sola línea, sin comillas triples ni texto antes o después:
QUOTE_REQUEST:{"checkin":"YYYY-MM-DD","checkout":"YYYY-MM-DD","tipo":"doble|triple|cuadruple"}
- Si el cliente quiere CONFIRMAR la reserva, cuando tengas su nombre respondé ÚNICA Y EXCLUSIVAMENTE con este formato exacto, en UNA sola línea, empezando por HANDOFF_JSON: y cerrando SIEMPRE la llave, sin texto antes ni después:
HANDOFF_JSON:{"nombre":"...","checkin":"...","checkout":"...","habitacion":"...","personas":"...","precio":"...","cama":"..."}
- Los datos de fechas, habitación y precio ya los conocés de la cotización previa: reutilizalos. Si solo te falta el nombre, pedí el nombre y nada más.
- IMPORTANTE: cuando emitas QUOTE_REQUEST o HANDOFF_JSON, tu respuesta debe contener SOLO esa línea. Nunca muestres llaves { } ni JSON al cliente en ningún otro caso.
- Si falta algún dato, preguntá en lenguaje natural (sin JSON).
- Si la consulta no es sobre el hotel: OUT_OF_SCOPE
- Si la consulta SÍ es sobre el hotel pero no tenés la información para responderla: UNANSWERED`;
}

// Construye la respuesta de handoff (lead + tarjeta de contacto) a partir de
// los datos disponibles, completando huecos con la última cotización.
function buildHandoffResponse(fields, lastQuote, prices, settings, hotelWhatsapp, hotelEmail) {
  const handoffData = {
    nombre:     fields.nombre    || "",
    checkin:    fields.checkin   || lastQuote?.checkin   || "",
    checkout:   fields.checkout  || lastQuote?.checkout  || "",
    habitacion: fields.habitacion|| lastQuote?.habitacion|| "",
    personas:   fields.personas  || lastQuote?.personas  || "",
    precio:     fields.precio    || lastQuote?.precio     || "",
    cama:       fields.cama      || "",
  };

  const tipo = tipoFromHab(handoffData.habitacion);
  let quoteText = null;
  if (handoffData.checkin && handoffData.checkout) {
    const q = calcQuote(prices, handoffData.checkin, handoffData.checkout, tipo, settings["discount"] || "0", "");
    if (q && !q.error) { handoffData.precio = q.totalSinDesc; handoffData.habitacion = tipo; quoteText = q.text; }
  }

  return { handoffData, quoteText, hotelWhatsapp, hotelEmail };
}

export default async function handler(req) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: cors });

  const json = (obj, status = 200) =>
    new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

  try {
    const body = await req.json();
    const { lastQuote, action } = body;

    const messages = (Array.isArray(body.messages) ? body.messages : [])
      .slice(-20)
      .map(m => ({ role: m.role, content: String(m.content || "").slice(0, 2000) }));

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) return json({ error: "API key no configurada" }, 500);
    if (!SUPABASE_URL || !SUPABASE_KEY) return json({ error: "Supabase no configurado (SUPABASE_URL / SUPABASE_ANON_KEY)" }, 500);

    const { settings, rooms, prices } = await getStaticData();
    const hotelWhatsapp = settings["hotel_whatsapp"] || "";
    const hotelEmail    = settings["hotel_email"] || extractEmail(settings["tpl_confirmacion"] || "");

    if (action === 'config') {
      return json({
        config: { hotelName: settings["hotel_name"] || "", welcomeMsg: settings["bot_welcome_msg"] || "", enabled: settings["bot_enabled"] !== "false" }
      });
    }

    if (settings["bot_enabled"] === "false") {
      const offMsg = settings["bot_fallback_msg"] || "El asistente no está disponible.";
      return json({ reply: offMsg, hotelWhatsapp, hotelEmail });
    }

    const geminiMessages = messages.map(msg => ({ role: msg.role === "assistant" ? "model" : "user", parts: [{ text: msg.content }] }));
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${GEMINI_API_KEY}`;

    const geminiRes = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: buildSystemPrompt(settings, rooms, prices) }] }, contents: geminiMessages, generationConfig: { maxOutputTokens: 800 } }),
    });

    const data = await geminiRes.json();
    const rawReply = data.candidates?.[0]?.content?.parts?.[0]?.text || "Lo siento, no pude procesar tu consulta.";
    let reply = rawReply.trim();

    // ── Señales de intención (independientes del prefijo exacto) ──────
    const hasNombreKey = /"nombre"\s*:/.test(reply);
    const isHandoff = reply.includes("HANDOFF_JSON") || hasNombreKey;
    const isQuote   = !isHandoff && (reply.includes("QUOTE_REQUEST") ||
                      (/"checkin"\s*:/.test(reply) && /"tipo"\s*:/.test(reply)));

    // ── HANDOFF (confirmar reserva) ───────────────────────────────────
    if (isHandoff) {
      let fields = {};
      const objStr = extractJsonObject(reply);
      if (objStr) {
        try { fields = JSON.parse(objStr); } catch (e) { fields = {}; }
      }
      // Si el JSON vino truncado/inválido, rescatamos campo por campo con regex.
      if (!fields || !Object.keys(fields).length) {
        fields = {
          nombre:     looseField(reply, "nombre"),
          checkin:    looseField(reply, "checkin"),
          checkout:   looseField(reply, "checkout"),
          habitacion: looseField(reply, "habitacion"),
          personas:   looseField(reply, "personas"),
          precio:     looseField(reply, "precio"),
          cama:       looseField(reply, "cama"),
        };
      }

      // Necesitamos al menos un nombre + fechas (propias o de la cotización previa).
      const nombre = (fields.nombre || "").trim();
      const tieneFechas = (fields.checkin || lastQuote?.checkin) && (fields.checkout || lastQuote?.checkout);

      if (!nombre) {
        return json({ reply: "¡Perfecto! ¿Me decís tu nombre completo para dejar la consulta lista?", handoffData: null, hotelWhatsapp, hotelEmail });
      }
      if (!tieneFechas) {
        return json({ reply: "¡Genial! ¿Me confirmás las fechas (entrada y salida) y el tipo de habitación para dejar tu consulta lista?", handoffData: null, hotelWhatsapp, hotelEmail });
      }

      const { handoffData, quoteText } = buildHandoffResponse(fields, lastQuote, prices, settings, hotelWhatsapp, hotelEmail);

      try {
        await insertSupabase("chatbot_leads", {
          name: String(handoffData.nombre).slice(0, 120),
          phone: "",
          context: `Hab: ${handoffData.habitacion}, Personas: ${handoffData.personas}, Fechas: ${handoffData.checkin} → ${handoffData.checkout}, Precio: ${handoffData.precio}`,
        });
      } catch (e) { /* no bloquear el flujo si falla el registro del lead */ }

      return json({ reply: "QUOTE_BEFORE_HANDOFF", handoffData, quoteText, hotelWhatsapp, hotelEmail });
    }

    // ── QUOTE (cotización) ────────────────────────────────────────────
    if (isQuote) {
      const objStr = extractJsonObject(reply);
      let qData = null;
      if (objStr) { try { qData = JSON.parse(objStr); } catch (e) { qData = null; } }
      if (!qData) {
        qData = {
          checkin: looseField(reply, "checkin"),
          checkout: looseField(reply, "checkout"),
          tipo: looseField(reply, "tipo") || "doble",
        };
      }

      if (qData.checkin && qData.checkout) {
        const discount = settings["discount"] || "0";
        const extraInfo = settings["quote_extra_info"] ? `Información adicional:\n- ${settings["quote_extra_info"]}` : "";
        const quote = calcQuote(prices, qData.checkin, qData.checkout, (qData.tipo || "doble"), discount, extraInfo);

        if (quote && !quote.error) {
          return json({ reply: quote.text + "\n\n¿Querés confirmar la reserva?", quoteData: { checkin: qData.checkin, checkout: qData.checkout, tipo: qData.tipo, precio: quote.totalSinDesc }, hotelWhatsapp, hotelEmail });
        }
        return json({ reply: quote?.error || "No hay tarifas cargadas para esas fechas.", hotelWhatsapp, hotelEmail });
      }
      // Sin fechas utilizables: pedirlas en lenguaje natural (nunca mostrar JSON).
      return json({ reply: "¿Para qué fechas de entrada y salida querés la cotización?", hotelWhatsapp, hotelEmail });
    }

    // ── UNANSWERED / OUT_OF_SCOPE ─────────────────────────────────────
    if (reply === "UNANSWERED" || reply === "OUT_OF_SCOPE") {
      if (reply === "UNANSWERED") {
        try {
          const lastUser = [...messages].reverse().find(m => m.role === "user");
          const prevContext = messages.slice(-5, -1).map(m => `${m.role}: ${m.content.slice(0, 80)}`).join(" | ");
          if (lastUser?.content) {
            await rpcSupabase("log_unanswered_question", { p_question: lastUser.content, p_context: prevContext });
          }
        } catch (e) { console.error("Error registrando unanswered:", e); }
      }
      return json({ reply: settings["bot_fallback_msg"] || "Esa consulta está fuera de mis posibilidades. Podés contactarnos directamente.", handoffData: null, hotelWhatsapp, hotelEmail });
    }

    // ── Respuesta normal ──────────────────────────────────────────────
    let clean = reply.replace(/```json/gi, "").replace(/```/g, "").replace(/HANDOFF_JSON:/g, "").replace(/QUOTE_REQUEST:/g, "").trim();

    // RED DE SEGURIDAD FINAL: si por lo que sea todavía quedó JSON crudo
    // (llaves con claves técnicas), NO se lo mostramos al cliente.
    if (/\{\s*"(nombre|checkin|checkout|tipo|habitacion)"\s*:/.test(clean)) {
      // Último intento: si hay un nombre, tratarlo como handoff; si no, mensaje amable.
      const nombre = looseField(clean, "nombre");
      if (nombre && (lastQuote?.checkin || looseField(clean, "checkin")) && (lastQuote?.checkout || looseField(clean, "checkout"))) {
        const { handoffData, quoteText } = buildHandoffResponse(
          { nombre, checkin: looseField(clean, "checkin"), checkout: looseField(clean, "checkout"), habitacion: looseField(clean, "habitacion"), precio: looseField(clean, "precio"), cama: looseField(clean, "cama") },
          lastQuote, prices, settings, hotelWhatsapp, hotelEmail
        );
        try {
          await insertSupabase("chatbot_leads", { name: String(handoffData.nombre).slice(0, 120), phone: "", context: `Hab: ${handoffData.habitacion}, Fechas: ${handoffData.checkin} → ${handoffData.checkout}, Precio: ${handoffData.precio}` });
        } catch (e) {}
        return json({ reply: "QUOTE_BEFORE_HANDOFF", handoffData, quoteText, hotelWhatsapp, hotelEmail });
      }
      return json({ reply: settings["bot_fallback_msg"] || "Disculpá, tuve un problema al procesar eso. ¿Me repetís tu consulta o tu nombre para dejar la reserva lista?", handoffData: null, hotelWhatsapp, hotelEmail });
    }

    return json({ reply: clean, handoffData: null, hotelWhatsapp, hotelEmail });

  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
