# Proxy de Janitor para OpenRouter, DeepSeek y Venice

Proxy compatible con OpenAI para usar **Janitor AI con OpenRouter, DeepSeek directo o Venice AI** desde un VPS o Coolify.

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

### OpenRouter

```env
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=<tu-clave-de-openrouter>
PROXY_API_KEY=<tu-clave-actual-del-proxy>
FORCE_MODEL=deepseek/deepseek-v4-flash
OUTPUT_MODE=smart
```

### DeepSeek directo

```env
AI_PROVIDER=deepseek
DEEPSEEK_API_KEY=<tu-clave-de-deepseek>
PROXY_API_KEY=<tu-clave-actual-del-proxy>
FORCE_MODEL=deepseek-flash
OUTPUT_MODE=prompt
```

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

### Venice AI

```env
AI_PROVIDER=venice
VENICE_API_KEY=<tu-clave-de-venice>
PROXY_API_KEY=<tu-clave-actual-del-proxy>
FORCE_MODEL=deepseek-v4-1-flash-1017-uncensored
OUTPUT_MODE=smart
```

Venice usa `https://api.venice.ai/api/v1/chat/completions`. El adaptador conserva
los mensajes y su historial, aplica la política de español y filtra los campos
de la solicitud. Envía `max_completion_tokens` como límite total, incluidos los
tokens de razonamiento. Si solo llega `max_tokens` con un valor positivo, lo
convierte. Si llegan ambos, prevalece `max_completion_tokens`.
`MIN_COMPLETION_TOKENS` fija el piso de ese límite.

El modelo recomendado admite `none`, `low`, `high` y `max` en
`reasoning_effort`. `REASONING_EFFORT` tiene prioridad sobre el esfuerzo
solicitado por el cliente. También se admite `reasoning.enabled` cuando no se
envía un esfuerzo válido. Si un intento queda vacío y el cliente o el operador
no eligieron un ajuste de razonamiento, el reintento del modelo recomendado usa
`none`.

En `venice_parameters` se aceptan los booleanos `disable_thinking`,
`strip_thinking_response` e `include_venice_system_prompt`. El prompt propio de
Venice queda desactivado por defecto para preservar las instrucciones de
Janitor. El proxy descarta los ajustes de búsqueda, scraping, personajes y
sufijos del modelo que activan funciones adicionales. `REASONING_EXCLUDE=true`
oculta el razonamiento en las respuestas JSON y SSE.
[Referencia de chat](https://docs.venice.ai/api-reference/endpoint/chat/completions) ·
[Capacidades del modelo](https://docs.venice.ai/models/deepseek-v4-1-flash-1017-uncensored)

Los streams directos conservan el evento de uso con `choices: []`. Si Venice
envía un error dentro del stream, el proxy lo devuelve como un evento SSE
sanitizado y cierra con un solo `[DONE]`. Las salidas sin texto visible ni
llamadas a funciones usan el reintento configurado. Los errores de autenticación,
saldo, validación, límites de uso y sobrecarga conservan su estado HTTP cuando
ocurren antes de que empiece el SSE.
[Errores de Venice](https://docs.venice.ai/api-reference/error-codes) ·
[Formato SSE](https://docs.venice.ai/guides/getting-started/openai-migration#streaming-format)

### Modelo de traducción

Cada proveedor usa su propio modelo predeterminado para traducir. Puedes
sustituirlo mediante `TRANSLATOR_MODEL` con un ID válido para el proveedor
seleccionado.

| Proveedor | Modelo predeterminado | `TRANSLATOR_REASONING_EFFORT` predeterminado |
| --- | --- | --- |
| OpenRouter | `openai/gpt-oss-20b:nitro` | `low` |
| DeepSeek directo | `deepseek-flash` | `none` |
| Venice | `qwen3-5-35b-a3b` | `none` |

## Modos de idioma

### `OUTPUT_MODE=prompt`

Normalmente hace una sola llamada. Conserva el streaming real del proveedor y es la opción más rápida. El proxy inserta la política de español dentro del primer mensaje `system` y la refuerza al final de ese mismo bloque. Con Venice empieza a reenviar los fragmentos de respuesta cuando llega texto visible o una llamada a función, y puede reintentar si el stream termina vacío.

### `OUTPUT_MODE=smart` (predeterminado)

Cuando Janitor solicita streaming, el proxy guarda temporalmente los primeros
fragmentos para detectar su idioma. Si la salida está en español, continúa el
streaming original. Si detecta inglés, traduce la respuesta completa por SSE
con el proveedor seleccionado.

### `OUTPUT_MODE=auto` — recomendado para empezar

El proxy obtiene primero la respuesta completa. Esto permite:

1. reintentar si el modelo devuelve pensamiento pero ningún texto visible;
2. detectar una salida predominantemente inglesa;
3. hacer una segunda llamada de localización solo cuando parece necesaria.

Si Janitor solicita streaming, el proxy conserva el **protocolo SSE**, pero los fragmentos llegan después de terminar la generación upstream porque se necesita inspeccionar la respuesta completa.

### `OUTPUT_MODE=strict`

Hace una segunda llamada para renderizar el texto de roleplay al español. Conserva las respuestas de Venice con llamadas a funciones tal como llegaron. La segunda llamada añade latencia y consumo de tokens.

## Despliegue en Coolify

1. En Coolify crea una aplicación desde el repositorio y elige el build pack
   **Dockerfile**. Para este repositorio usa `/backend` como **Base Directory**
   y `/Dockerfile` como **Dockerfile Location**.
2. En **Environment Variables** configura `AI_PROVIDER`, la API key del
   proveedor y `PROXY_API_KEY` como variables de ejecución. Para Venice, usa
   los valores del bloque anterior y guarda `VENICE_API_KEY` como secreto.
3. Configura el puerto interno `3000`, asigna un dominio HTTPS y usa `/health`
   para el health check.

Para cambiar de proveedor en una aplicación existente, actualiza `AI_PROVIDER`,
agrega la API key correspondiente y fija `FORCE_MODEL` con un ID válido del
nuevo proveedor. Si habías definido `TRANSLATOR_MODEL`, `TRANSLATOR_REASONING_EFFORT`
o `REASONING_EFFORT`, revisa sus valores para el nuevo modelo o bórralos para
usar los predeterminados. Redespliega con el mismo dominio y `PROXY_API_KEY`.
Así Janitor conserva la URL, la clave y el campo de modelo que ya tenía.
[Despliegue con Dockerfile en Coolify](https://coolify.io/docs/applications/builds/dockerfile)

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
    "model": "TU_MODELO_DEL_PROVEEDOR",
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
npm run check
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
