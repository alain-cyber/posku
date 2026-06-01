# Orders / Invoices API — field reference

How Posku pushes a customer invoice to the ERP via `POST /api/orders`. This is
the source of truth for the invoice flow's payload shape and the enums Posku
hardcodes (since there's no `/api/orders/dropdowns` endpoint).

Pair with `PRODUCTS_API.md` for the SKU push contract and `CLOUDFLARE_SETUP.md`
step 8 for the BigQuery IAM grants the customer typeahead needs.

## Envelope

Same `{ data: { ... } }` envelope as `POST /api/products`, same `api-key` header
(per-env secret injected by the Pages proxy — same TEST/LIVE split as products:
`viatrading.biz` for test, `ops.viatrading.com` for live).

## Canonical body

Per the ERP team's sample curl:

```jsonc
{
  "data": {
    "user_id": 123,              // ← THE CUSTOMER's id, not the service account
    "salesrep_id": 1,            // separate from user_id; optional
    "order_type_id": 15,         // see enums below
    "sub_total": "100.00",       // stringified
    "grand_total": "100.00",
    "tax_rate": "0.00",
    "shipping_cost": "0.00",
    "payment_method_id": 5,      // see enums below
    "shipping_method_id": 74,    // see enums below
    "promo_code": "",
    "billing_address":  { /* inline object, see below */ },
    "shipping_address": { /* inline object, see below */ },
    "items": [
      {
        "product_id": 456,
        "sku": "WYFPRLQ50432",
        "qty": "1",
        "original_price": "100.00",
        "discount": "0",
        "discount_type": 1,
        "price": "100.00",
        "total": "100.00"
      }
    ],
    "payments": []               // always empty for posku v1; ERP-side semantics not yet locked
  }
}
```

### Address blocks

Both `billing_address` and `shipping_address` are **inline objects** (not refs).
Posku pulls them from the BigQuery `customers_flat` row when the user picks a
customer in the typeahead, then defaults `shipping_address = billing_address`
because customers_flat has no `shipping_*` columns. User edits in the draft.

```jsonc
{
  "first_name":  "Jane",
  "last_name":   "Doe",
  "companyName": "",
  "address":     "123 Main St",
  "addressMore": "",
  "city":        "New York",
  "stateName":   "NY",
  "state":       "",
  "zip":         "10001",
  "countryCode": "US",
  "phoneNumber": "5551234567",
  // shipping_address ONLY — billing omits these:
  "commercial":  0,
  "liftgate":    0
}
```

### Field semantics

| Key | Type | Notes |
|---|---|---|
| `user_id` | int | ⚠ **The CUSTOMER's customer_id from `customers_flat`** — not the Posku service user (`179` on products). |
| `salesrep_id` | int / null | Optional. |
| `order_type_id` | int | See enum table below. |
| `sub_total`, `grand_total`, `tax_rate`, `shipping_cost` | string | All numerics arrive stringified. |
| `payment_method_id`, `shipping_method_id` | int | See enum tables below. |
| `promo_code` | string | Empty string OK. |
| `items[].product_id` | int | The product id (= `newProductId` from a successful SKU push, stashed on the load). |
| `items[].sku` | string | Sent alongside `product_id` for redundancy. |
| `items[].qty` | string | Posku always sends `"1"` — one load = one inventory unit. |
| `items[].price`, `original_price`, `total` | string | Per-unit sell, original, and line total. |
| `items[].discount`, `discount_type` | string / int | Posku v1 always sends `"0"` / `1` (never exercises discount math). |
| `payments` | array | Posku always sends `[]`. Server-side semantics of `[]` vs omitted vs pending-method record not yet locked with ERP team. |

## Hardcoded enums

There's no `/api/orders/dropdowns` endpoint, so Posku hardcodes these. The
existing wizard the ERP team referenced does the same.

### `order_type_id`

| id | name | posku default? |
|---|---|---|
| 1  | Other ||
| 2  | Phone ||
| 3  | Auction ||
| 6  | Walk-in ||
| 7  | Internet ||
| 9  | Email ||
| 11 | Show ||
| 13 | Inbound phone ||
| 14 | Outbound phone ||
| **15** | **Program** | **✓ default for all invoices** |

### `payment_method_id`

| id | name | posku default? |
|---|---|---|
| 2  | Cash ||
| **5**  | **Wire Transfer** | **✓ default** |
| 7  | Check ||
| 15 | Credit Card (3% fee) ||
| 16 | Paypal (3% fee) ||
| 18 | Net 30 ||
| 21 | Other ||
| 22 | Zelle ||
| 36 | Customer Credit ||
| 37 | ACH ||

### `shipping_method_id`

| id | name | posku default? |
|---|---|---|
| 64 | Truckload ||
| **65** | **Direct Truckload** | **✓ default for Wayfair** |
| 66 | LTL ||
| 68 | Walk-In/Pick-Up ||
| 70 | Domestic Courier ||
| 71 | International Courier ||
| 72 | Container ||
| 73 | SoCalShip ||
| **74** | **Direct LTL** | **✓ default for Sam's Club** |
| 77 | Direct Domestic Courier ||
| 94 | TBD ||
| 277 | Not Applicable ||

All three dropdowns are editable per-invoice in the draft panel — the defaults
above are just what pre-fills.

## Customer source — MIGRATION PLANNED: BigQuery → native ERP endpoints

> **Status (2026-06-01):** The ERP team published an official Orders API
> reference pack (Drive folder `orders_api`, owner armin@viatrading.com:
> `ORDERS_API.md`, `ORDERS_INTEGRATION_FAQ.md`, `samples/`). It exposes
> **native customer endpoints** that should replace the BigQuery bridge below.
> Captured here; **not yet implemented** — see "Migration plan" + prerequisites.

### Native flow (from the ERP team's integration FAQ) — TWO calls

The native path is a search call **plus** a detail call. Search does **not**
return addresses ("Search results do not include full addresses; always GET by
id.").

1. **Typeahead search** — returns the customer + `id` (→ `data.user_id`), no address:
   ```http
   GET /api/customers?is_customer=2,3&context=order_search&limit=10&full_name=Jane
   GET /api/customers?is_customer=2,3&context=order_search&limit=10&email=jane@example.com
   GET /api/customers?is_customer=2,3&context=order_search&limit=10&phone=5551234567
   ```
   Result `data[]` fields: `id`, `first_name`, `last_name`, `email`,
   `phone_number`, `company_name`. Needs privilege `VIEW_CUSTOMERS` /
   `VIEW_OWN_CUSTOMERS` (may scope to sales rep).

2. **Address fetch on pick** — `GET /api/customers/{id}` → use `data[0]`:
   | Field | Use for order prefill |
   |---|---|
   | `billingAddressDetails[0]` | → `data.billing_address` |
   | `defaultAddressDetails[0]`  | → default `data.shipping_address` |
   | `shippingAddressDetails[]`  | all shipping addresses (pick one / default) |

   Address objects already use IMS keys (`companyName`, `addressMore`,
   `countryCode`, `stateName`, `state`, `phoneNumber`, `phoneId`, `commercial`,
   `liftgate`) — i.e. **the exact shape `POST /api/orders` wants, no transform**.

### Why migrate (not just "temp")

Audited `customers_flat` on 2026-06-01: of **854,186** active customers,
**~356,000 (42%) have no billing address** (≈36% missing city, ≈44% state,
≈36% zip). The BigQuery snapshot is stale/incomplete; `GET /api/customers/{id}`
reads the live customer record (source of truth), so addresses are current.

### Migration plan (when scheduled)

- **Prerequisite — verify endpoints first.** Confirm `GET /api/customers?...`
  and `GET /api/customers/{id}` actually return the documented shapes on
  `viatrading.biz` (test) before wiring UI. Check: search result field names
  (`phone_number` vs `phone`), and that `billingAddressDetails[0]` /
  `defaultAddressDetails[0]` exist and are populated.
- Replace `functions/api/customers/search.js` (BigQuery) with a thin proxy to
  `GET /api/customers?...` via the env-aware key injection.
- Add a second proxy hop / call for `GET /api/customers/{id}` on customer pick;
  map `billingAddressDetails[0]`/`defaultAddressDetails[0]` into the draft's
  `billing_address`/`shipping_address`. Frontend already stores
  `{customer_id, email, name, billing_address, shipping_address}` on the draft,
  so the draft/payload code shouldn't need to change — only the data source.
- Privileges: the LIVE/TEST API keys need `VIEW_CUSTOMERS` (+ `CREATE_ORDERS`,
  `VIEW_PRODUCTS` for lookups).

### Current (legacy) BigQuery bridge — still in place until migration

Posku's `/api/customers/search?q=...` Pages Function queries
`data-warehouse-494801.alain_via_erp.customers_flat`. Match ranking:

1. exact email
2. email startsWith
3. email contains
4. customer_full_name startsWith
5. customer_full_name contains
6. company_name contains

Tie-break on `last_order_date DESC NULLS LAST` so frequent buyers float first.

Returned shape per customer:

```jsonc
{
  "customer_id": 261477,                       // ← maps to data.user_id
  "email":   "robles.glass@gmail.com",
  "name":    "Joel Robles",
  "company": "Robles Glass & Supplies Inc.",
  "phone":   "111776",
  "billing_address":  { /* full inline object as above */ },
  "shipping_address": { /* defaulted to a copy of billing_address */ }
}
```

This whole path is **temporary** — when the ERP team exposes a proper
`/api/customers` search endpoint, swap the Pages Function for a thin proxy
pass-through. The frontend already calls `/api/customers/search` so the
client code doesn't need to change.

## Default invoice customer per supplier (rules)

The Wayfair and Sam's Club rules editors carry a per-supplier map of `{ key →
customer email }` that drives invoice-draft customer pre-fill:

- **Sam's**: `SUPPLIERS.SMS.invoiceCustomerByLoc` keyed by `locCode` (e.g.
  `{ DEN: 'denver-buyer@x.com', LB: 'longbeach@y.com' }`).
- **Wayfair**: `SUPPLIERS.WYF.invoiceCustomerByLocType` keyed by
  `locCode + '_' + typeCode` (e.g. `{ PR_LQ: '...', JFL_HDO: '...' }`).

These are stored in Cloudflare KV (the same blob as the rest of the rules) and
load via `applySamsRulesOverride` / `applyRulesOverride`.

## Grouping & the `unique invoice` flag

Each pushed load on the loads table gets a per-row checkbox **"unique inv"**
(default checked). Behavior on **Generate invoice draft(s)**:

- `unique = true` → that load becomes its own draft (1 line item).
- `unique = false` → that load clusters with other un-unique loads that
  resolve to the **same customer**. One draft per customer cluster.

So selecting 5 Sam's loads where rules → 3 to Customer A + 2 to Customer B, all
un-unique, produces 2 drafts: `A(3 loads)` and `B(2 loads)`. The header bar
shows the predicted draft count live as the user toggles.

## Open items

1. **Response shape on success** — ✅ **RESOLVED** by the ERP FAQ. Create
   returns **`{ "id": 12345 }`** (internal PK `orders.id`, used for
   `PUT /api/orders/{id}`). The customer-facing **`order_id`** (e.g. `1159186`)
   is **not** in the POST body — fetch it with `GET /api/orders/{id}` and read
   `order_id` for the "Invoice #… pushed" display. *(Code still sniffs
   `newOrderId/newId/id/order_id`; switch to `id` + a GET on implement.)*
2. **`payments[]` semantics for unpaid invoices** — ✅ **RESOLVED**: `[]` (or
   omitting `payments`) is recommended. Set `payment_method_id` on the **order
   header** for how they'll pay / terms; leave `payments` empty until money is
   recorded (later `PUT` with `payments[]`). Posku already sends `[]`.
3. **`/api/customers` REST endpoint** — ✅ **AVAILABLE** (see "Customer source"
   migration plan above). Two-call native flow ready to wire; verify-first.
4. **Hardcoded enums** — the FAQ says `order_type_id`, `payment_method_id`,
   `shipping_method_id` are **not** fixed in code; load from
   `GET /api/lookups?table=orders_types` / `orders_payment_methods` /
   `shipping_methods` (rows `{id, name}`, optional `status_id`/`limit`/`page`).
   Posku hardcodes them today (see "Hardcoded enums" above) — fine for now,
   but live lookups would keep them in sync per-environment.
5. **Line-item default price** — IMS order entry defaults `items[].price` (and
   `original_price`) from the product's **`price`** field, via
   `GET /api/products/get-skus?search=SKU&skuSearch=true&limit=5&skipCounts=1`.
   Not `unit_price`/`load_price`. Context for auto-filling invoice line prices.
6. **"Presold" data signal** — whether there's a flag/tag/sheet column
   marking which loads have a customer waiting. Would let Posku surface a
   "presold" chip on the load row and gate the Invoice button on it.

### Source of these answers

Drive folder **`orders_api`** (owner armin@viatrading.com, 2026-06-01):
`ORDERS_API.md`, `ORDERS_INTEGRATION_FAQ.md`, `samples/create-order*.json`,
`samples/curl-create-order.sh`. The FAQ is the integration source of truth;
this file mirrors the parts Posku depends on.

## Where the code lives

- Draft + push: `index.html` — search for `// ════ INVOICE FLOW ════`.
- Customer search proxy: `functions/api/customers/search.js`.
- Rules editor extensions: `index.html` → `drawCfgUISams()` and `drawCfgUIWyf()`.
- Tri-chip status strip (SKU · PO · INV): `index.html` → `statusChip()`.
