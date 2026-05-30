# Products API — field mapping reference

How posku posts a SKU to `POST /api/products` on viatrading.biz (test) and
ops.viatrading.com (live). This is the source of truth for **which JSON key
the server actually reads** for each field, plus the gotchas we discovered
the hard way. Read this before changing `buildPayload()` in `index.html`
(starts around line 1605).

## Envelope

Every push wraps the product fields in a top-level `data` object:

```json
{ "data": { ...fields below... } }
```

`Content-Type: application/json`, `api-key` header injected by the Pages
proxy (`functions/api/[[path]].js`).

## Field mapping (canonical)

| posku key (request) | type | stored column / display | notes |
|---|---|---|---|
| `sku` | string | `sku` | uppercased on save |
| `name` | string | `name` |  |
| `psku` | string | `psku` | parent SKU, e.g. `LOAD-SMSST` |
| `psku_type` | string | — | always `"regular"` |
| `active` | int (0/1) | `active` |  |
| `make_an_offer` | bool | `make_offer` (Y/N) |  |
| **`store`** | int | `store` | ⚠ **NOT `store_id`** — that key is silently dropped |
| `lang_id` | int | `lang_id` | always `1` |
| `slug` | string | i18n.slug | derived from sku: lowercase, non-alphanumeric → `-` |
| **`packing`** | int (trait id) | `product_trait_id` in `products_traits_link` | ⚠ Must be the **integer trait id** from `/api/products/dropdowns`. Passing the name string ("LTL") triggers `SQLSTATE 1366 Incorrect integer value`. See "Trait IDs" below. |
| `condition` | int (trait id) | `product_trait_id` (type=condition) | e.g. `63` = Customer Returns |
| `manifested` | int (trait id) | `product_trait_id` (type=manifest status) | `603` = Manifested, `514` = Unmanifested |
| **`categories`** | int[] | `products_segments_link` (cat rows) | ⚠ Categories and groups are **separate arrays**. Don't lump them together. |
| **`groups`** | int[] | `products_segments_link` (group rows) | ⚠ NEW field — e.g. `56` (Load Center) is a **group**, not a category |
| `fobStates` | int[] | `products_fob_link` | camelCase, e.g. `[44]` for Utah |
| `supplierId` | int | `supplier_id` | ⚠ camelCase here, snake on output |
| `status_id` | int | `status_id` |  |
| `user_id` | int | `user_id` | `179` for posku service user |
| `user_id_created` | int | `user_id_created` | same `179` |
| `peachtree_code` | string | `peachtree_code` | e.g. `LOAD-SAMS` |
| **`unit_qty`** | int | `unit_qty` | ⚠ **NOT `qty`** — `qty` is silently dropped |
| `pallets_qty` | int | `pallets_qty` |  |
| `price` | number | `price` | total sell |
| `retail_price` | number | `retail_price` | total retail |
| **`unit_price`** | number | `unit_price` | ⚠ **NOT `price_per_unit`** — that key is silently dropped |
| `retail_price_per_unit` | number | `retail_price_per_unit` | confusingly this one IS `_per_unit` |
| `price_per_pallet` | number | `price_per_pallet` |  |
| `peachtree_qty` | int | `peachtree_qty` |  |
| **`productType`** | int (trait id) | `product_trait_id` (type=type) | Integer trait id from dropdowns, e.g. `263` = "Program - Manifested". Same direct-insert pattern as `packing` — no name lookup. |
| `restrict_price_change` | bool | `restrict_price_change` |  |
| `taxable` | bool | `taxable` (0/1) |  |

### Fields you do NOT send

`id`, `created`, `updated`, `timestamp`, anything ending in `Name` or
`status_text` — those are server-derived from the trait/segment joins.

## Response shape

```json
{
  "status": "success",
  "message": "Product created",
  "newProductId": 139049
}
```

The response **does not echo the created product**. To verify what was
actually saved, GET `/api/products/{newProductId}` afterwards — that's a
DataTables-style summary view that exposes most but not all fields (it
doesn't expose `store`, `productType`, `unit_price`, `layout_id`).

## Trait IDs (packing, condition, manifested, productType)

The `packing`/`condition`/`manifested`/`productType` fields all write to
the same `products_traits_link` junction with their respective `type_id`.
The integer trait IDs come from `/api/products/dropdowns`.

**Important:** the dropdowns endpoint and the raw `airbyte_sync.products_traits`
table use **different ID spaces** for some trait categories. The API
validates against the dropdowns IDs, so always send dropdowns IDs.

Test dropdowns (verified 2026-05-29):

| trait | id | name |
|---|---|---|
| packing | 83 | Case |
| packing | 88 | Load |
| packing | 93 | Pallet |
| packing | 96 | LTL |
| product_type | 261 | Assorted Case Pack |
| product_type | 263 | Program - Manifested |
| product_type | 267 | Program - Unmanifested |
| product_type | 269 | A La Carte Cosmetics |
| product_type | 272 | Single & Multi Pallet |

Confirmed by alain: **test and live use the same dropdown ID space**
for these traits, so a single hardcoded ID works in both environments.

For condition/manifested we've been using these in production for a
while; values:
- condition: `63` = Customer Returns, `61` = New Overstock, `62` = Shelf Pulls
- manifested: `603` = Manifested, `514` = Unmanifested

## Failure modes we hit (and the fix)

| Symptom | Root cause | Fix |
|---|---|---|
| `qty: 75` saves as `unit_qty: null` | Wrong key name | Rename to `unit_qty` |
| `packing: 203` saves as `packingId: null` | 203 is the airbyte trait id but the API validates against dropdowns IDs (LTL=96 on test) | Send the dropdowns id |
| `packing: "LTL"` → `SQLSTATE 1366 Incorrect integer value` | Server writes input directly into INT column — does NOT do name→id SQL lookup on create | Send the integer trait id, not the name |
| `categories: [191, 56]` → `groups: []` in saved record | 56 is a group, not a category | Split into `categories: [191]` + `groups: [56]` |
| `store_id: 18` saves as missing | Wrong key | Rename to `store` |
| `price_per_unit: 5.34` saves as missing | Wrong key | Rename to `unit_price` |
| Stale config keeps re-sending the wrong value after I update the default | localStorage override in `applySamsRulesOverride()` shadows the new baked-in default | Add a migration step inside that function (see line ~993 for the packingTrait 203→96 example) |

## How to verify a push

1. Open `/diagnostic` after pushing — it shows the last request payload,
   the create response, and a follow-up GET of the saved product.
2. Diff the SAVED PRODUCT block against the REFERENCE SKU block (a
   known-good SKU like `SMSCB743`). Any field that the reference has
   populated but the new push has null is a mapping bug.
3. Some fields aren't in the GET response shape — for those, log in to
   `viatrading.biz` or `ops.viatrading.com` and inspect the product
   edit form directly.

## Where this lives in code

- `buildPayload()` — `index.html` ~line 1605
- Per-supplier defaults (packingTrait, productType, etc.) — `index.html`
  `SUPPLIERS.WYF` ~line 555 and `SUPPLIERS.SMS` ~line 615
- localStorage config overrides — `applyWyfRulesOverride()` /
  `applySamsRulesOverride()` ~line 925 / 980
- Proxy that injects the api-key — `functions/api/[[path]].js`

## When the API changes

If a field stops working or a new one is added, the fastest debug loop is:

1. Push a test SKU, copy the `/diagnostic` output, paste into the chat.
2. The REFERENCE SKU block shows what a known-good record looks like —
   that's the target. The SAVED PRODUCT block shows what the new push
   actually stored. Diff them.
3. If you can read the API's PHP/Node source, search it for the field
   name to see which column/table it writes to. The dev's pseudo-code
   for packing was:
   ```
   "packing" => $PackingID
   $PackingID = SELECT pt.id FROM products_traits pt JOIN products_traits_type ptt
                ON ptt.id = pt.type_id AND ptt.name = 'packing'
                WHERE pt.name = '{$Packing}'
   ```
   That's the UPDATE path (does a name lookup). CREATE bypasses the
   lookup and inserts the input directly — hence the type-mismatch error
   when we sent the name string.
