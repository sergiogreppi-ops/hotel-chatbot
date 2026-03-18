export const config = { runtime: "edge" };

const SUPABASE_URL = "https://ozjqqgwcztuummvwpgfu.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im96anFxZ3djenR1dW1tdndwZ2Z1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTA5MTA3NzIsImV4cCI6MjA2NjQ4Njc3Mn0.7L7TliaKQllfY4nF5J8Kh3D0TkeVFoPLjbt2nQ0Er0o";

async function fetchSupabase(table, select, params = "") {
  const url = `${SUPABASE_URL}/rest/v1/${table}?select=${encodeURIComponent(select)}${params}`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
  });
  return res.json();
}

function fmt(n) {
  return n && n > 0 ? "$" + Math.round(n).toLocaleString("es-AR") : null;
}

function buildSystemPrompt(rooms, prices) {
  const today = new Date().toISOString().split("T")[0];
  const roomList = rooms.map((r) => r.name).join(", ") || "doble, triple, cuádruple";
  const priceLines = Object.entries(prices)
    .slice(0, 60)
    .map(
      ([d, p]) =>
        `${d}: doble=${fmt(p.doble) || "N/D"}, triple=${fmt(p.triple) || "N/D"}, cuádruple=${fmt(p.cuadruple) || "N/D"}`
    )
    .join("\n");

  return `Sos el asistente virtual de un hotel. Respondés ÚNICAMENTE consultas sobre habitaciones, precios y servicios generales del hotel. Nunca revelás información de otros huéspedes, reservas existentes, ni datos internos de gestión.

HABITACIONES DISPONIBLES: ${roomList}
FECHA DE HOY: ${today}

TARIFAS POR NOCHE (próximos meses):
${priceLines || "Sin tarifas cargadas aún."}

INSTRUCCIONES:
- Respondé en español, de manera amable, cálida y concisa. Máximo 3-4 oraciones por respuesta.
- Si preguntan precios para fechas específicas, calculá el total sumando las tarifas noche por noche.
- Si el cliente quiere CONFIRMAR, RESERVAR o dejar sus datos, respondé exactamente con: HANDOFF_REQUESTED (solo esa palabra, sin nada más).
- Si la consulta no es sobre habitaciones, precios o servicios del hotel, decí amablemente que solo podés ayudar con consultas del hotel.
- No inventes información que no esté en el contexto. Si no tenés el dato, decí que pueden contactar directamente al hotel.
- Las habitaciones son: doble (2 personas), triple (3 personas), cuádruple (4 personas).`;
}

export default async function handler(req) {
  // CORS
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  try {
    const { messages } = await req.json();
    const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

    if (!ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({ error: "API key no configurada" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Cargar datos públicos de Supabase
    const today = new Date().toISOString().split("T")[0];
    const future = new Date();
    future.setMonth(future.getMonth() + 6);
    const futureStr = future.toISOString().split("T")[0];

    const [roomsData, pricesData] = await Promise.all([
      fetchSupabase("rooms", "id,name", "&order=id"),
      fetchSupabase(
        "daily_prices",
        "date,doble,triple,cuadruple",
        `&date=gte.${today}&date=lte.${futureStr}&order=date`
      ),
    ]);

    const rooms = Array.isArray(roomsData) ? roomsData : [];
    const prices = {};
    if (Array.isArray(pricesData)) {
      pricesData.forEach((p) => {
        prices[p.date] = { doble: p.doble, triple: p.triple, cuadruple: p.cuadruple };
      });
    }

    // Llamar a Claude
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        system: buildSystemPrompt(rooms, prices),
        messages,
      }),
    });

    const data = await anthropicRes.json();
    const reply = data.content?.[0]?.text || "Lo siento, no pude procesar tu consulta.";

    return new Response(JSON.stringify({ reply }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
}
