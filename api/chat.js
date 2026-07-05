export const config = { runtime: "edge" };

// ── CONFIG POR VARIABLES DE ENTORNO ───────────────────
//   SUPABASE_URL      = https://pozunquwpuxqgiuajuft.supabase.co
//   SUPABASE_ANON_KEY = (anon key del proyecto NUEVO, Settings → API)
//   GEMINI_API_KEY    = (ya la tenés)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;

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

// Campos técnicos que el modelo NO debe filtrar al cliente.
const HANDOFF_KEYS = ["nombre", "checkin", "checkout", "habitacion", "personas", "precio", "tipo", "cama"];

function safeJsonParse(str, fallback) {
  try { return JSON.parse(str); } catch (e) { return fallback; }
}

// Extrae un objeto JSON balanceado (respeta comillas). null si viene truncado.
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
  return null;
}

// Rescata un campo aunque venga en markdown/backticks/sin comillas.
// Acepta:  "campo": "valor" | `campo`: "valor" | campo: valor | * campo: "valor"
function looseField(text, field) {
  if (!text) return "";
  const re = new RegExp("[`\"']?\\b" + field + "\\b[`\"']?\\s*[:=]\\s*[`\"']?([^\"'`\\n,}]+)", "i");
  const m = text.match(re);
  return m ? m[1].trim().replace(/[)*]+$/, "").trim() : "";
}

// ¿El texto parece una FILTRACIÓN de datos estructurados de reserva?
// (2+ campos técnicos en forma "campo:" — con o sin comillas/backticks).
function looksLikeStructuredLeak(text) {
  if (!text) return false;
  let hits = 0;
  for (const k of HANDOFF_KEYS) {
    if (new RegExp("[`\"']?\\b" + k + "\\b[`\"']?\\s*[:=]", "i").test(text)) hits++;
  }
  return hits >= 2;
}

// Nombres que NO son nombres (textos de botones, comandos, números).
function isJunkName(n) {
  if (!n) return true;
  const s = n.trim().toLowerCase();
  if (s.length < 2 || s.length > 60) return true;
  const junk = [
    "quiero reservar", "si", "sí", "no", "hola", "buenas", "buenos dias", "buenos días",
    "ver habitaciones", "consultar precios", "consultar otras fechas", "reservar",
    "nombre", "n/d", "none", "null", "cliente", "...", "-",
  ];
  if (junk.includes(s)) return true;
  if (/^\$?\d[\d.,]*$/.test(s)) return true; // es un número / precio
  return false;
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
  const res = await fetch(url, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } });
  return res.json();
}

async function insertSupabase(table, data) {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, Prefer: "return=minimal" },
    body: JSON.stringify(data),
  });
}

async function rpcSupabase(fn, args) {
  await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    body: JSON.stringify(args),
  });
}

function fmt(n) { return n && n > 0 ? "$" + Math.round(n).toLocaleString("es-AR") : null; }

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

REGLAS DE FORMATO (MUY IMPORTANTE):
- Respondé SIEMPRE en texto plano. PROHIBIDO usar markdown, viñetas, asteriscos (*), guiones de lista o comillas invertidas (backticks \`).
- NUNCA muestres al cliente los datos de la reserva como una lista de campos, ni menciones nombres técnicos como nombre, checkin, checkout, habitacion, personas, precio, tipo o cama. Esos nombres son internos.

INSTRUCCIONES DE COTIZACIÓN Y RESERVA:
- NUNCA calcules precios ni muestres totales vos mismo. La cotización es automática.
- NUNCA hagas operaciones matemáticas en el chat.
- EQUIVALENCIAS: "para 2 personas" → tipo=doble.
- Cuando el cliente pida precio para fechas concretas, respondé SOLO con esta única línea (sin nada antes ni después, sin backticks):
QUOTE_REQUEST:{"checkin":"YYYY-MM-DD","checkout":"YYYY-MM-DD","tipo":"doble|triple|cuadruple"}
- Para CONFIRMAR una reserva necesitás el NOMBRE del cliente. Si todavía NO tenés el nombre, respondé SOLO con esta frase en texto natural: ¿A nombre de quién hago la reserva? (sin JSON, sin listas).
- Cuando YA tengas el nombre, respondé SOLO con esta única línea (JSON válido, comillas dobles, llave cerrada, sin texto ni backticks):
HANDOFF_JSON:{"nombre":"...","checkin":"...","checkout":"...","habitacion":"...","personas":"...","precio":"...","cama":"..."}
- Reutilizá fechas, habitación y precio de la cotización previa. No vuelvas a preguntarlos si ya los tenés.
- Si falta algún dato que no sea el nombre, preguntalo en lenguaje natural (sin JSON).
- Si la consulta no es sobre el hotel: OUT_OF_SCOPE
- Si es sobre el hotel pero no tenés la información: UNANSWERED`;
}

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

// Extrae los campos del handoff, ya sea de JSON o de texto suelto/markdown.
function resolveHandoffFields(reply) {
  let fields = {};
  const objStr = extractJsonObject(reply);
  if (objStr) { try { fields = JSON.parse(objStr); } catch (e) { fields = {}; } }
  if (!fields || typeof fields !== "object" || !Object.keys(fields).length) {
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
  return fields;
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
      return json({ config: { hotelName: settings["hotel_name"] || "", welcomeMsg: settings["bot_welcome_msg"] || "", enabled: settings["bot_enabled"] !== "false" } });
    }

    if (settings["bot_enabled"] === "false") {
      return json({ reply: settings["bot_fallback_msg"] || "El asistente no está disponible.", hotelWhatsapp, hotelEmail });
    }

    const geminiMessages = messages.map(msg => ({ role: msg.role === "assistant" ? "model" : "user", parts: [{ text: msg.content }] }));
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${GEMINI_API_KEY}`;

    const geminiRes = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: buildSystemPrompt(settings, rooms, prices) }] },
        contents: geminiMessages,
        generationConfig: { maxOutputTokens: 800, temperature: 0.4 },
      }),
    });

    const data = await geminiRes.json();
    const rawReply = data.candidates?.[0]?.content?.parts?.[0]?.text || "Lo siento, no pude procesar tu consulta.";
    let reply = rawReply.trim();

    // ── Señales de intención (tolerantes a backticks / markdown) ──────
    const nombreKey = /[`"']?\bnombre\b[`"']?\s*[:=]/i.test(reply);
    const checkinKey = /[`"']?\bcheckin\b[`"']?\s*[:=]/i.test(reply);
    const tipoKey    = /[`"']?\btipo\b[`"']?\s*[:=]/i.test(reply);
    const isHandoff  = reply.includes("HANDOFF_JSON") || nombreKey;
    const isQuote    = !isHandoff && (reply.includes("QUOTE_REQUEST") || (checkinKey && tipoKey));

    // ── HANDOFF ───────────────────────────────────────────────────────
    if (isHandoff) {
      const fields = resolveHandoffFields(reply);
      const nombre = (fields.nombre || "").trim();
      const tieneFechas = (fields.checkin || lastQuote?.checkin) && (fields.checkout || lastQuote?.checkout);

      if (isJunkName(nombre)) {
        return json({ reply: "¡Genial! ¿A nombre de quién hago la reserva?", handoffData: null, hotelWhatsapp, hotelEmail });
      }
      if (!tieneFechas) {
        return json({ reply: "¡Perfecto! ¿Me confirmás las fechas de entrada y salida y el tipo de habitación?", handoffData: null, hotelWhatsapp, hotelEmail });
      }

      const { handoffData, quoteText } = buildHandoffResponse(fields, lastQuote, prices, settings, hotelWhatsapp, hotelEmail);
      try {
        await insertSupabase("chatbot_leads", { name: String(handoffData.nombre).slice(0, 120), phone: "", context: `Hab: ${handoffData.habitacion}, Personas: ${handoffData.personas}, Fechas: ${handoffData.checkin} → ${handoffData.checkout}, Precio: ${handoffData.precio}` });
      } catch (e) {}
      return json({ reply: "QUOTE_BEFORE_HANDOFF", handoffData, quoteText, hotelWhatsapp, hotelEmail });
    }

    // ── QUOTE ─────────────────────────────────────────────────────────
    if (isQuote) {
      const objStr = extractJsonObject(reply);
      let qData = null;
      if (objStr) { try { qData = JSON.parse(objStr); } catch (e) { qData = null; } }
      if (!qData) {
        qData = { checkin: looseField(reply, "checkin"), checkout: looseField(reply, "checkout"), tipo: looseField(reply, "tipo") || "doble" };
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
      return json({ reply: "¿Para qué fechas de entrada y salida querés la cotización?", hotelWhatsapp, hotelEmail });
    }

    // ── UNANSWERED / OUT_OF_SCOPE ─────────────────────────────────────
    if (reply === "UNANSWERED" || reply === "OUT_OF_SCOPE") {
      if (reply === "UNANSWERED") {
        try {
          const lastUser = [...messages].reverse().find(m => m.role === "user");
          const prevContext = messages.slice(-5, -1).map(m => `${m.role}: ${m.content.slice(0, 80)}`).join(" | ");
          if (lastUser?.content) await rpcSupabase("log_unanswered_question", { p_question: lastUser.content, p_context: prevContext });
        } catch (e) { console.error("Error registrando unanswered:", e); }
      }
      return json({ reply: settings["bot_fallback_msg"] || "Esa consulta está fuera de mis posibilidades. Podés contactarnos directamente.", handoffData: null, hotelWhatsapp, hotelEmail });
    }

    // ── Respuesta normal ──────────────────────────────────────────────
    let clean = reply
      .replace(/```json/gi, "").replace(/```/g, "")
      .replace(/HANDOFF_JSON:/g, "").replace(/QUOTE_REQUEST:/g, "")
      .trim();

    // RED DE SEGURIDAD: si quedó cualquier filtración de datos estructurados
    // (JSON, o "campo:" en markdown/backticks), NO se la mostramos al cliente.
    if (looksLikeStructuredLeak(clean) || /\{\s*[`"']?(nombre|checkin|checkout|tipo|habitacion)[`"']?\s*[:=]/i.test(clean)) {
      const fields = resolveHandoffFields(clean);
      const nombre = (fields.nombre || "").trim();
      const tieneFechas = (fields.checkin || lastQuote?.checkin) && (fields.checkout || lastQuote?.checkout);

      if (!isJunkName(nombre) && tieneFechas) {
        const { handoffData, quoteText } = buildHandoffResponse(fields, lastQuote, prices, settings, hotelWhatsapp, hotelEmail);
        try {
          await insertSupabase("chatbot_leads", { name: String(handoffData.nombre).slice(0, 120), phone: "", context: `Hab: ${handoffData.habitacion}, Fechas: ${handoffData.checkin} → ${handoffData.checkout}, Precio: ${handoffData.precio}` });
        } catch (e) {}
        return json({ reply: "QUOTE_BEFORE_HANDOFF", handoffData, quoteText, hotelWhatsapp, hotelEmail });
      }
      // Sin nombre válido: pedirlo en lenguaje natural (nunca mostrar el JSON).
      return json({ reply: "¡Genial! ¿A nombre de quién hago la reserva?", handoffData: null, hotelWhatsapp, hotelEmail });
    }

    return json({ reply: clean, handoffData: null, hotelWhatsapp, hotelEmail });

  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
