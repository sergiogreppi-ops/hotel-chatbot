# Hotel Chatbot

Chatbot de consultas para hotel. Tecnologías: Vercel (serverless) + Supabase + Claude AI.

---

## Estructura del proyecto

```
hotel-chatbot/
├── api/
│   └── chat.js        ← Función serverless (maneja Claude + Supabase)
├── public/
│   └── index.html     ← Página del chatbot
├── vercel.json        ← Configuración de rutas
└── README.md
```

---

## Deploy paso a paso

### 1. Subir a GitHub

1. Creá un repositorio nuevo en github.com (puede ser privado)
2. Subí todos estos archivos manteniendo la estructura de carpetas
3. El repositorio debe verse exactamente así:
   ```
   api/chat.js
   public/index.html
   vercel.json
   README.md
   ```

### 2. Conectar Vercel

1. Entrá a [vercel.com](https://vercel.com) y creá cuenta (gratis)
2. Click en **"Add New Project"**
3. Conectá tu cuenta de GitHub y seleccioná el repositorio
4. En la configuración del proyecto:
   - **Framework Preset**: Other
   - **Root Directory**: `.` (dejar en raíz)
5. Click **Deploy** — va a fallar por ahora porque falta la API key (paso 3)

### 3. Agregar la API key de Anthropic

1. En Vercel, entrá a tu proyecto → **Settings** → **Environment Variables**
2. Agregá esta variable:
   - **Name**: `ANTHROPIC_API_KEY`
   - **Value**: tu API key de Anthropic (la obtenés en console.anthropic.com)
   - **Environment**: Production, Preview, Development (tildar los tres)
3. Click **Save**

### 4. Re-deployar

1. Ir a **Deployments** → click en los tres puntos del último deploy → **Redeploy**
2. En unos segundos vas a tener la URL: `https://tu-proyecto.vercel.app`

---

## Obtener API key de Anthropic

1. Entrá a [console.anthropic.com](https://console.anthropic.com)
2. Registrate o iniciá sesión
3. Ir a **API Keys** → **Create Key**
4. Copiá la key y pegála en Vercel (paso 3)
5. Necesitás cargar créditos en Billing para que funcione (desde $5)

---

## Crear tabla de leads en Supabase (opcional)

Para que los datos de contacto se guarden cuando alguien quiere reservar,
ejecutá esto en el **SQL Editor** de tu proyecto Supabase:

```sql
CREATE TABLE chatbot_leads (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  context TEXT,
  attended BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Política para que el chatbot pueda insertar
ALTER TABLE chatbot_leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "insert_leads" ON chatbot_leads FOR INSERT WITH CHECK (true);
CREATE POLICY "select_leads" ON chatbot_leads FOR SELECT USING (true);
```

---

## A futuro: integrar en otra web

Cuando tengas la web del hotel, agregá esta sola línea en el HTML:

```html
<!-- Chatbot del hotel -->
<script src="https://tu-proyecto.vercel.app/widget.js"></script>
```

(Te armo el widget.js cuando llegue ese momento)

---

## Preguntas frecuentes

**¿Cuánto cuesta?**
- Vercel: gratis para este uso
- Supabase: gratis (ya lo tenés)
- Anthropic: pago por uso, muy económico (~$0.001 por conversación con Haiku)

**¿Es seguro?**
- La API key de Anthropic NUNCA está expuesta al browser
- El chatbot solo accede a rooms y daily_prices, nunca a reservas ni datos de huéspedes
