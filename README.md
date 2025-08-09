# Guesty Owners → Owner Revenue (last month)

This Apify actor logs into Guesty Admin, opens each owner's **"vista previa"**, goes property by property in the Owner Portal, switches to the **previous month**, reads **"Ingresos estimados del propietario"**, and POSTs a JSON payload to your **n8n Cloud** webhook.

## Input (example)

```json
{
  "loginUrl": "https://app.guesty.com/login",
  "ownersUrl": "https://app.guesty.com/contact/owners",
  "email": "YOUR_EMAIL",
  "password": "YOUR_PASSWORD",
  "n8nWebhookUrl": "https://YOUR-N8N-DOMAIN/webhook/owner-revenue",
  "timezone": "America/Argentina/Buenos_Aires"
}
```

> The actor computes the **previous month** automatically using your timezone. It will post `{ items: [{ owner, nickname, month: "YYYY-MM", ownerRevenue }] }`.

## Notes

- If “vista previa” opens a new tab/window (popup), the actor handles it.
- If your UI uses different selectors, override the `selectors` object in the input.
- If 2FA/SSO is enforced for your account, consider using a dedicated user without 2FA for automation or keep a long-lived session via Apify Key-Value Store (advanced).

## Schedule

In Apify → Schedules:
- CRON: `0 9 2 * *`
- Timezone: `America/Argentina/Buenos_Aires`
- Action: Run this actor with your saved input.

## n8n (sketch)

1. **Webhook (POST)** → path `/owner-revenue`
2. **Function** to fan-out:
   ```js
   const { items = [] } = $json;
   return items.filter(i => (i.ownerRevenue ?? 0) > 0).map(i => ({ json: i }));
   ```
3. **(Your Notion nodes)**: match `nickname` to your Properties DB, then create/update a page in your Revenue DB with ACC relation, OR number, and Month date (e.g., `${month}-01`).

