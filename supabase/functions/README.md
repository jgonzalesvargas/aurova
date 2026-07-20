# Edge Functions de Aurova

Respaldo del codigo que corre en Supabase (proyecto `ljkfwgoqpwfckhqhklhi`).

**Por que existe esta carpeta:** hasta el 19 jul 2026 estas funciones vivian
UNICAMENTE dentro de Supabase. No estaban en git, no se podian versionar ni
revisar, y si se perdia el acceso al proyecto, los tres sistemas criticos
(pagos, bancos e IA) eran irrecuperables. Descargadas con el MCP de Supabase.

| Funcion | verify_jwt | Que hace |
|---|---|---|
| `plaid` | si | Conexion bancaria: link_token, exchange, list, remove, sync |
| `stripe` | si | Precios, checkout y portal de cliente |
| `stripe-webhook` | **no** (correcto) | Reconcilia la tabla `subscriptions` con Stripe |
| `ai-chat` | si | Asistente con Claude Haiku. **PENDIENTE de respaldar** |

## Secretos que necesitan (viven en Supabase, no aqui)

`PLAID_CLIENT_ID` · `PLAID_SECRET` · `PLAID_ENV` (sandbox/development/production)
`STRIPE_SECRET_KEY` · `STRIPE_WEBHOOK_SECRET` · `APP_URL`
`ANTHROPIC_API_KEY` · `SUPABASE_SERVICE_ROLE_KEY` (automatico)

## Precios (hardcodeados en `stripe/index.ts`, en centavos)

- Mensual: `PRICE_MONTHLY = 699` ($6.99)
- Anual: `PRICE_ANNUAL = 5999` ($59.99)
- Anual fundador: `PRICE_ANNUAL_FOUNDER = 3999` ($39.99), primeros 100

No usa Price IDs de Stripe sino `price_data` en linea: cambiar precios es
editar estas constantes y redesplegar, no tocar el dashboard de Stripe.

## Redesplegar

    supabase functions deploy <slug> --project-ref ljkfwgoqpwfckhqhklhi
