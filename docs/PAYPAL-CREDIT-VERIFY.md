# Verifying lead-credit top-ups against PayPal (sandbox)

Owed before the lead marketplace (`leadMarketplace`) takes real money. Like
`docs/PAYPAL-FEATURED-VERIFY.md`, this is written for whoever holds sandbox
credentials: the platform has none of its own, and every PayPal behaviour
`lib/billing/orders.ts` and `lib/billing/credit-topup.ts` rely on is proved here
by hand. The unit suite proves the code against recorded payloads and a fake
client; it cannot prove PayPal still sends those payloads.

Set once:

```sh
export BASE=https://api-m.sandbox.paypal.com
export TOKEN=$(curl -s -u "$PAYPAL_CLIENT_ID:$PAYPAL_CLIENT_SECRET" \
  -d grant_type=client_credentials $BASE/v1/oauth2/token | jq -r .access_token)
export H=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")
```

## 1. An order for one pack carries our custom_id and returns a payer-action link

This is the body `createOrder` sends for the smallest default pack (£50):

```sh
curl -s "${H[@]}" -d '{"intent":"CAPTURE","purchase_units":[{"custom_id":"credit:00000000-0000-4000-8000-000000000001",
  "description":"Lead credit verify","amount":{"value":"50.00","currency_code":"GBP"}}],
  "payment_source":{"paypal":{"experience_context":{"user_action":"PAY_NOW","shipping_preference":"NO_SHIPPING",
  "return_url":"https://example.test/account/credit/return","cancel_url":"https://example.test/account/credit/cancelled"}}}}' \
  $BASE/v2/checkout/orders | tee /tmp/order.json | jq '{id, status, links: [.links[] | {rel, href}]}'
export ORDER=$(jq -r .id /tmp/order.json)
```

Expect `status: PAYER_ACTION_REQUIRED` and a `payer-action` link (the code also
accepts `approve`). Open it with a sandbox buyer and approve. PayPal should send
the buyer to `.../account/credit/return?token=$ORDER` — **record that the query
parameter is `token`**; the return page reads nothing else.

## 2. Capture returns the amount and our custom_id

```sh
curl -s "${H[@]}" -X POST -d '{}' $BASE/v2/checkout/orders/$ORDER/capture \
  | jq '{status, capture: .purchase_units[0].payments.captures[0] | {id, status, amount, custom_id}}'
```

Expect `status: COMPLETED`, `amount: {value: "50.00", currency_code: "GBP"}`.
`settleTopupOrder` credits nothing unless the amount equals the row's pack in
the site currency.

Capture it **again** and record the error: the code treats
`422 UNPROCESSABLE_ENTITY` with issue `ORDER_ALREADY_CAPTURED` as "the webhook
got there first" and reads the order back.

## 3. The webhook carries custom_id and the order id

Record the `PAYMENT.CAPTURE.COMPLETED` delivery for that capture (webhook
simulator, or a real endpoint subscribed to the event) and check:

- `resource.custom_id` is `credit:<uuid>` — without it the capture is treated
  as a job's and ignored as an unknown order;
- `resource.supplementary_data.related_ids.order_id` equals `$ORDER` — when it
  is present and disagrees with the row, nothing is credited
  (`credit.payment.mismatch`, reason `order-mismatch`);
- `resource.amount` is `{value, currency_code}`.

**The webhook subscription must include `PAYMENT.CAPTURE.COMPLETED`.** The
subscription events alone (`BILLING.SUBSCRIPTION.*`, `PAYMENT.SALE.COMPLETED`)
never deliver it; a missing subscription means top-ups settle only on the
return page, and a buyer who closes the tab after approving is credited by
nobody until an admin adjusts by hand.

## 4. End to end on a sandbox deploy

With `leadMarketplace` on and sandbox keys set on web and worker:

1. Sign in, open `/account/credit`, press the smallest pack, approve at PayPal.
2. The return page says the credit was added; the balance shows it; one
   `topup` row is on the ledger with `order_id = <PayPal order id>`.
3. Redeliver the capture webhook from the dashboard: the response is
   `{"outcome":"duplicate"}` (or `ignored` with `capture:already-credited` for
   a fresh event id) and the balance is unchanged.
4. Start another top-up, approve, and **close the tab** before the return page
   loads: the webhook alone credits it within a few seconds.
5. The receipt email arrives (worker running, Resend configured).

Record the results here with the date, then flip `leadMarketplace` on for real.
