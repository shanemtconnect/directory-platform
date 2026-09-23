# Verifying the featured-spots billing model against PayPal (sandbox)

Owed before featured spots go live. This platform has no PayPal sandbox credentials of its
own, so the steps below are written to be run by whoever holds them, exactly as `lib/billing`
and `lib/spots` expect the API to behave. Every claim the code makes about PayPal is listed
with the call that proves or disproves it.

Set once:

```sh
export BASE=https://api-m.sandbox.paypal.com
export TOKEN=$(curl -s -u "$PAYPAL_CLIENT_ID:$PAYPAL_CLIENT_SECRET" \
  -d grant_type=client_credentials $BASE/v1/oauth2/token | jq -r .access_token)
export H=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")
```

## 1. A plan can be quantity-supported at one unit a month

`scripts/paypal-setup.ts` does this (`featuredPlanRequestBody`); by hand:

```sh
PRODUCT=$(curl -s "${H[@]}" -d '{"name":"Featured spots verify","type":"SERVICE","category":"ADVERTISING"}' \
  $BASE/v1/catalogs/products | jq -r .id)
PLAN=$(curl -s "${H[@]}" -d '{
  "product_id":"'"$PRODUCT"'","name":"Featured verify (per unit, monthly)","status":"ACTIVE",
  "quantity_supported":true,
  "billing_cycles":[{"frequency":{"interval_unit":"MONTH","interval_count":1},"tenure_type":"REGULAR",
    "sequence":1,"total_cycles":0,"pricing_scheme":{"fixed_price":{"value":"1.00","currency_code":"GBP"}}}],
  "payment_preferences":{"auto_bill_outstanding":true,"setup_fee_failure_action":"CONTINUE","payment_failure_threshold":3}
}' $BASE/v1/billing/plans | jq -r .id)
curl -s "${H[@]}" $BASE/v1/billing/plans/$PLAN | jq '{quantity_supported, status}'
```

Expect `quantity_supported: true`. If PayPal rejects a 1.00 unit price or the flag, the plan
body in `lib/billing/featured-plan.ts` is wrong.

## 2. A subscription is created with a quantity, and the buyer approves once

```sh
curl -s "${H[@]}" -d '{"plan_id":"'"$PLAN"'","quantity":"60","custom_id":"verify-row-1",
  "application_context":{"user_action":"SUBSCRIBE_NOW","shipping_preference":"NO_SHIPPING",
  "return_url":"https://example.test/account/featured/return","cancel_url":"https://example.test/account/featured/cancelled"}}' \
  $BASE/v1/billing/subscriptions | tee /tmp/sub.json | jq '{id, status, approve: (.links[] | select(.rel=="approve") | .href)}'
export SUB=$(jq -r .id /tmp/sub.json)
```

Open the approve link with a sandbox buyer and approve. Then:

```sh
curl -s "${H[@]}" $BASE/v1/billing/subscriptions/$SUB | jq '{status, quantity, next: .billing_info.next_billing_time, last: .billing_info.last_payment}'
```

Expect `status: ACTIVE`, **`quantity: "60"`**, and a first payment of 60.00. The code reads
`quantity` from this GET (`getSubscription` → `parseQuantity`) and from the
`BILLING.SUBSCRIPTION.ACTIVATED` webhook payload. **Record the ACTIVATED webhook body**
(webhook simulator or a real endpoint) and confirm `resource.quantity` is present — C1 in the
review depends on it: without a quantity on the payload nothing is confirmed.

## 3. Revise the quantity — does it need consent, and does UPDATED carry the quantity?

```sh
curl -s "${H[@]}" -d '{"quantity":"80","application_context":{"user_action":"SUBSCRIBE_NOW",
  "shipping_preference":"NO_SHIPPING","return_url":"https://example.test/account/featured/return",
  "cancel_url":"https://example.test/account/featured/cancelled"}}' \
  $BASE/v1/billing/subscriptions/$SUB/revise | jq '{plan_id, quantity, links: [.links[] | {rel, href}]}'
curl -s "${H[@]}" $BASE/v1/billing/subscriptions/$SUB | jq '{status, quantity}'
```

Three things to record:
1. whether the revise response has an `approve` link (the code assumes yes and redirects the
   owner there);
2. whether the GET shows `80` immediately or only after the buyer approves (the code assumes
   only after — `requested_quantity` = 80, `quantity` stays 60 until evidence arrives);
3. after approving, the **`BILLING.SUBSCRIPTION.UPDATED` payload**: does `resource.quantity`
   say `80`? The webhook handler confirms pending bids only when the payload's quantity ≥ the
   requested one. If UPDATED carries no quantity, the handler must be changed to reconcile
   with a GET on every UPDATED instead.

Also try a **decrease** (`"quantity":"40"`) and record whether that, too, needs approval. If a
decrease applies without consent, `syncQuantities` can stop re-requesting decreases.

## 4. Suspend / activate without consent (the outbid path)

```sh
curl -s -o /dev/null -w '%{http_code}\n' "${H[@]}" -d '{"reason":"outbid"}' $BASE/v1/billing/subscriptions/$SUB/suspend
curl -s "${H[@]}" $BASE/v1/billing/subscriptions/$SUB | jq '{status, quantity}'
curl -s -o /dev/null -w '%{http_code}\n' "${H[@]}" -d '{"reason":"re-entered"}' $BASE/v1/billing/subscriptions/$SUB/activate
curl -s "${H[@]}" $BASE/v1/billing/subscriptions/$SUB | jq '{status, quantity, next: .billing_info.next_billing_time}'
```

Expect 204 / `SUSPENDED` / 204 / `ACTIVE` with the same quantity, no new approval link, and no
new first-cycle charge. Record the `BILLING.SUBSCRIPTION.SUSPENDED` and `ACTIVATED` webhook
bodies: the handler ignores a SUSPENDED for a row this site paused, and treats the ACTIVATED
as a confirm (with its `quantity` as evidence). Also check whether `next_billing_time`
moved while suspended.

## 5. Cancel

```sh
curl -s -o /dev/null -w '%{http_code}\n' "${H[@]}" -d '{"reason":"verify done"}' $BASE/v1/billing/subscriptions/$SUB/cancel
```

Expect 204 and a `BILLING.SUBSCRIPTION.CANCELLED` webhook. Delete the verify plan/product
afterwards (deactivate the plan: `POST /v1/billing/plans/$PLAN/deactivate`).

## What to bring back

The five recorded webhook bodies (ACTIVATED, UPDATED after a revise, SUSPENDED, ACTIVATED
after `/activate`, CANCELLED) belong in `lib/billing/__fixtures__/` as
`featured-*.ts` so the tests in `lib/spots/bidding.test.ts` run against real shapes.
