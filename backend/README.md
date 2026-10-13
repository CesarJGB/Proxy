# Janitor → OpenRouter / DeepSeek Proxy

Proxy OpenAI-compatible pensado para usar **Janitor AI con OpenRouter o DeepSeek directo** desde un VPS/Coolify.

## Qué resuelve

- Endpoint compatible: `POST /v1/chat/completions`.
- La API key del proveedor se guarda únicamente en el servidor.
- Una `PROXY_API_KEY` separada para Janitor.
- Inyección persistente de una política de salida en español latinoamericano.
- Puede fijar un proveedor de OpenRouter para evitar cambios de latencia entre proveedores.
- Soporta solicitudes `stream: true` y `stream: false`.
- Detecta respuestas con razonamiento pero `content` vacío y puede reintentar.
- Modo `auto`/`strict` capaz de reescribir la salida al español sin cambiar el formato del roleplay.
- Logs de metadatos (latencia, intentos, caracteres), sin guardar el contenido de la conversación por defecto.
- CORS configurable para evitar el típico `Load failed` de clientes web.

OpenRouter usa `POST https://openrouter.ai/api/v1/chat/completions`; el streaming se realiza mediante SSE. OpenRouter también permite controlar proveedores con `provider.only`, `provider.order` y `allow_fallbacks`.

## Selección de proveedor

OpenRouter sigue siendo el proveedor predeterminado si no defines `AI_PROVIDER`.

OpenRouter:

```env
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=<tu-clave-de-openrouter>
PROXY_API_KEY=<tu-clave-actual-del-proxy>
FORCE_MODEL=deepseek/deepseek-v4-flash
OUTPUT_MODE=smart
```

DeepSeek directo (configuración sencilla y rápida recomendada):

```env
AI_PROVIDER=deepseek
DEEPSEEK_API_KEY=<tu-clave-de-deepseek>
PROXY_API_KEY=<tu-clave-actual-del-proxy>
FORCE_MODEL=deepseek-flash
OUTPUT_MODE=prompt
```

En Coolify actualiza estas variables en **Environment Variables** y redespliega.
Solo es obligatoria la API key del proveedor seleccionado, además de `PROXY_API_KEY`.
Janitor conserva exactamente la misma URL y `PROXY_API_KEY`; `FORCE_MODEL` sustituye
el modelo enviado por Janitor, por lo que tampoco necesitas cambiar su configuración.

DeepSeek usa `https://api.deepseek.com/chat/completions`. El proxy envía solamente
los campos admitidos por su [API oficial](https://api-docs.deepseek.com/api/create-chat-completion/),
conservando los mensajes y la misma política de español. Las opciones `OPENROUTER_PROVIDER`,
`PROVIDER_SORT`, `DATA_COLLECTION`, `ALLOW_PROVIDER_FALLBACKS`, `REQUIRE_PARAMETERS`
y los encabezados de OpenRouter solo se aplican a OpenRouter.

Para DeepSeek se conservan `thinking` y `reasoning_effort` del request;
`REASONING_EFFORT`, si está definido, sustituye este último. Los valores nativos
son `none`, `low`, `high` y `max` (también admite los alias `minimal`, `medium`, `xhigh`).
`none` desactiva el pensamiento. `max_tokens` limita toda la salida, incluido el
razonamiento; `max_completion_tokens` se convierte a `max_tokens` cuando no existe
este último. `MIN_COMPLETION_TOKENS` sigue aplicándose. Los objetos `reasoning`
y `REASONING_MAX_TOKENS` de OpenRouter no se envían a DeepSeek.

`OUTPUT_MODE=prompt` evita la traducción secundaria y conserva el streaming directo.
También siguen disponibles `smart` (detección local mientras recibe SSE), `auto`
y `strict`. Si estos modos necesitan traducir, usan el proveedor seleccionado:
OpenRouter conserva `openai/gpt-oss-20b:nitro`; DeepSeek usa `deepseek-flash`, con
`TRANSLATOR_REASONING_EFFORT=none` por defecto para traducir sin pensamiento.
Puedes definir `TRANSLATOR_MODEL` con un modelo compatible con ese proveedor
(por ejemplo `deepseek-flash` o `deepseek-v4-pro` para DeepSeek). Al cambiar de
proveedor elimina o actualiza cualquier `TRANSLATOR_MODEL` explícito del anterior.

## Modos de idioma

### `OUTPUT_MODE=prompt`

Una sola llamada. Conserva el streaming real del proveedor y es la opción más rápida/barata. El proxy inserta la política de español dentro del primer mensaje `system` y la refuerza al final de ese mismo bloque.

### `OUTPUT_MODE=auto` — recomendado para empezar

El proxy obtiene primero la respuesta completa. Esto permite:

1. reintentar si el modelo devuelve pensamiento pero ningún texto visible;
2. detectar una salida predominantemente inglesa;
3. hacer una segunda llamada de localización solo cuando parece necesaria.

Si Janitor solicita streaming, el proxy conserva el **protocolo SSE**, pero los fragmentos llegan después de terminar la generación upstream porque se necesita inspeccionar la respuesta completa.

### `OUTPUT_MODE=strict`

Siempre hace una segunda llamada para renderizar la respuesta al español. Es el modo más insistente, pero también el más lento y consume más tokens.

## Despliegue en Coolify

1. Sube esta carpeta a un repositorio de GitHub.
2. En Coolify crea un nuevo recurso desde ese repositorio.
3. Selecciona despliegue mediante `Dockerfile`.
4. Agrega las variables de `.env.example` en **Environment Variables**.
5. Como mínimo configura:

```env
OPENROUTER_API_KEY=sk-or-v1-...
PROXY_API_KEY=una-clave-larga-y-aleatoria
OUTPUT_MODE=auto
CORS_ORIGIN=*
```

6. Asigna un dominio HTTPS, por ejemplo:

```text
https://janitor-proxy.tudominio.com
```

7. En Coolify puedes usar `/health` como health check.

## Configuración de Janitor

En el proxy/API de Janitor usa:

```text
Proxy URL:
https://janitor-proxy.tudominio.com/v1/chat/completions

API Key:
<el valor de PROXY_API_KEY>

Model:
<modelo del proveedor; FORCE_MODEL lo sustituye si está definido>
```

**No pongas la API key real del proveedor en Janitor.**

### Si Janitor tiene un campo que añade `/chat/completions` automáticamente

Usa como base:

```text
https://janitor-proxy.tudominio.com/v1
```

Si Janitor espera la URL completa, usa `/v1/chat/completions` como en el ejemplo anterior.

## Fijar un proveedor

Después de comprobar que el proxy funciona con routing automático, define:

```env
OPENROUTER_PROVIDER=PROVIDER_ID
ALLOW_PROVIDER_FALLBACKS=false
```

Puedes usar varios en orden:

```env
OPENROUTER_PROVIDER=PROVIDER_A,PROVIDER_B
ALLOW_PROVIDER_FALLBACKS=true
```

No adivines el nombre: copia el identificador que OpenRouter muestra para el proveedor del modelo que vayas a usar.

Si no quieres fijar uno pero prefieres velocidad:

```env
OPENROUTER_PROVIDER=
PROVIDER_SORT=throughput
```

## Cuando el modelo piensa pero no devuelve texto

OpenRouter contabiliza los tokens de razonamiento como tokens de salida. En modelos con razonamiento, un presupuesto de salida demasiado pequeño puede dejar poco espacio para la respuesta final.

El proxy tiene dos protecciones:

```env
EMPTY_RESPONSE_RETRY=1
MIN_COMPLETION_TOKENS=0
```

Primero prueba con el valor `0`. Si siguen apareciendo respuestas vacías, prueba por ejemplo:

```env
MIN_COMPLETION_TOKENS=2000
REASONING_EFFORT=low
```

No todos los modelos admiten los mismos controles de razonamiento, por eso están desactivados por defecto salvo `REASONING_EXCLUDE=true`, que evita devolver el razonamiento al cliente.

## CORS y `Load failed`

Para la primera prueba:

```env
CORS_ORIGIN=*
```

Cuando confirmes desde qué origen exacto llama Janitor, puedes restringirlo:

```env
CORS_ORIGIN=https://example.com,https://www.example.com
```

Si restringes un origen incorrecto, el navegador mostrará un error de red aunque el servidor esté funcionando.

## Privacidad de logs

Por defecto **no se imprimen mensajes ni respuestas**. Los logs contienen datos como:

```json
{
  "request_id": "...",
  "model": "...",
  "provider": "...",
  "elapsed_ms": 3120,
  "rewritten": false,
  "visible_chars": 1482,
  "reasoning_chars": 0
}
```

Mantén:

```env
LOG_PROMPT_CONTENT=false
```

## Prueba rápida sin Janitor

```bash
curl -N https://TU-DOMINIO/v1/chat/completions \
  -H "Authorization: Bearer TU_PROXY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "TU_MODELO_OPENROUTER",
    "stream": true,
    "messages": [
      {"role":"user","content":"Salúdame y describe brevemente una noche lluviosa."}
    ]
  }'
```

## Desarrollo local

```bash
cp .env.example .env
npm test
npm run start:env
```

El proyecto no tiene dependencias npm de runtime; usa las APIs nativas de Node.js 20.

Health check:

```bash
curl http://localhost:3000/health
```

## Notas sobre costes

- `prompt`: normalmente 1 llamada por mensaje.
- `auto`: 1 llamada normalmente; 2 si necesita reescritura. Un reintento por salida vacía también agrega una llamada.
- `strict`: normalmente 2 llamadas por mensaje.

Si quieres minimizar coste manteniendo robustez, empieza con `auto`. Cuando encuentres un modelo que obedezca el español de forma consistente, cambia a `prompt`.
