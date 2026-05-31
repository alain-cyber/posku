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

## Customer source (BigQuery)

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

1. **Response shape on success** — the field name carrying the new invoice id.
   Posku currently sniffs `newOrderId / newId / id / order_id` and falls back
   to "(check response)". To be locked once ERP team confirms.
2. **`payments[]` semantics for unpaid invoices** — `[]` vs omitted vs
   pending-method record. Currently always `[]`; ERP-side behavior unknown.
3. **`/api/customers` REST endpoint** — when available, swap the BigQuery
   bridge for a thin pass-through.
4. **"Presold" data signal** — whether there's a flag/tag/sheet column
   marking which loads have a customer waiting. Would let Posku surface a
   "presold" chip on the load row and gate the Invoice button on it.

## Where the code lives

- Draft + push: `index.html` — search for `// ════ INVOICE FLOW ════`.
- Customer search proxy: `functions/api/customers/search.js`.
- Rules editor extensions: `index.html` → `drawCfgUISams()` and `drawCfgUIWyf()`.
- Tri-chip status strip (SKU · PO · INV): `index.html` → `statusChip()`.
