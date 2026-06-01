# Wayfair manifest → Load Center sheet — column mapping spec

Status: **analysis / not yet wired.** There is currently no `transformWayfairManifest`
in `index.html` (only `transformSamsManifest`). This doc is the basis for building it.

Derived from a review of the live Wayfair manifests in Drive (Wayfair supplier
folder `15Rz6qF4XvPmporn3rxMkvTeLgOSN9eoz`, FC + HDO sub-folders) and the
`airbyte_sync.ProductManifest` table (`Store='WYF'`, ~192K rows).

---

## 1. Key finding

**Every Wayfair product manifest uses ONE common 25-column schema** — regardless
of condition (LQ / Aged / Salvage / QC), origin warehouse, FC vs HDO, or xlsx vs
csv. The load **type lives in the filename, not in the columns**. So we need a
single column remap, not one per type; "per type" only affects sheet-tab routing.

## 2. Type taxonomy (all filename-driven)

Two orthogonal dimensions plus packing channel:

- **Condition** (filename prefix → WYF type code):
  `Liquidation Load` → `LQ`, `Aged (Liquidation|Inventory)` → `A`,
  `Salvage Load` → `S`, `QC Liquidation Load` → `QC`, `Supplier Liquidation Load` → `LQ`.
  The master index sheet (`Wayfair.xlsx`) confirms a `Category` field of LQ / Aged / Salvage / QC.
- **Family / tree** (folder + filename, see `functions/api/drive/list.js` `classifyTree`):
  `FC` (fulfillment center / small parcel), `HDO` (home delivery / big & bulky),
  `Perigold` (physical retail, type `PG`), `Outlet` (type `OUT`).
- **Origin warehouse** (filename suffix → location code): PerrisSmallParcel/PerrisCA→PR
  (dominant), Aberdeen→AMD, Erlanger→EKY, Jacksonville→JFL, Lancaster→LTX,
  Romeoville→RIL, Lathrop→LA, City of Industry→CI, etc. (`wyfLocCodeFromCity`).
- **Load-ID code** (from accounting files): `WYF` + FC code + condition + load# —
  e.g. `WYFAMDLQ50571`, `WYFRILS50568` (S/LS = salvage). Matches `buildSKU`.

## 3. Source schema — 25 columns, verbatim, in order

```
Load ID, Carton ID, Pallet ID, Wayfair ID, Quantity, Product Category,
Product Type, Product Manufacturer, Product Name, Product Style,
Product Part Number, Product Weight, Product UPC or EAN, Unit Grade,
Cartons Per Product, Price Per Product, Price Per Carton, Price Currency,
Wholesale Price Per Product, Wholesale Price Per Carton, Wholesale Price Currency,
Price Type, Product Image URL, Product Site URL, Total Product Price
```

Optional trailing summary columns (Via Trading additions, not all files):
`Recovery Rate`, `Total Recovery` (Perris/Aged Lancaster have both; Salvage has
only `Total Recovery`).

## 4. Column mapping → `LC_COLUMNS`

| Load Center column   | ← Source (Wayfair)                         | Transform |
|----------------------|--------------------------------------------|-----------|
| `SKU`                | *(not in file)*                            | `WYF{loc}{type}{loadId}` from filename |
| `Store`              | *(constant)*                               | `"WYF"` |
| `Pallet ID`          | `Pallet ID`                                | as-is; blank OK |
| `Item ID`            | `Wayfair ID`                               | as-is (`NDPE3544.107490744`) |
| `UPC`                | `Product UPC or EAN`                       | coerce scientific notation → integer string; blank OK |
| `Description`        | `Product Manufacturer` + `Product Name`    | join; fix mojibake (UTF-8/Latin-1); fall back to Name |
| `Main Category`      | `Product Category`                         | as-is; often blank (optional backfill from Product Type) |
| `Subcategory`        | `Product Type`                             | as-is |
| `Quantity`           | `Quantity`                                 | int, default 1 |
| `Appx. Unit Retail`  | `Price Per Product`                        | strip `$`/commas |
| `Appx. EXT Retail`   | `Total Product Price`                      | strip `$`/commas (= Price×Qty; compute if blank) |
| `Your Unit Price $`  | `Wholesale Price Per Product`              | strip `$`/commas |
| `Your EXT Price`     | `Wholesale Price Per Product` × `Quantity` | (or `Wholesale Price Per Carton`) |
| `Your Price %`       | `Wholesale ÷ Price Per Product`            | ≈ 0.65 (LQ wholesale rate) |
| `% of Load QTY`      | *computed*                                 | `Quantity ÷ Σqty` |
| `% of Load $$`       | *computed*                                 | `Your EXT ÷ Σ Your EXT` |

**Internal-only / dropped (NOT on the customer sheet):** `Recovery Rate`,
`Total Recovery` (Via Trading's actual cost ~8% of retail — not a customer
number), `Price Per Carton`, `Cartons Per Product`, `Product Weight`,
`Unit Grade`, `Price Type`, currency columns, `Product Style`, `Product Part Number`.
Keep `Product Image URL` / `Product Site URL` only if wanted for listings.

## 5. Proposed sheet column set: `WYF_COLUMNS`

= the 16 `LC_COLUMNS` **+ 2** Wayfair-only columns for filtering:
`Load Type` (LQ/Aged/Salvage/QC) and `FC / Location`. Kept separate from
`LC_COLUMNS` so Sam's output is unaffected.

## 6. Tab routing — PENDING USER DECISION

Columns are uniform, so this is purely organizational. `SUPPLIERS.WYF.sheetTab`
would become a per-type map/function. Options:
- **By condition** (recommended): `Wayfair LQ` / `Wayfair Aged` / `Wayfair Salvage` / `Wayfair QC`.
- **By family**: `Wayfair FC` / `Wayfair HDO` / `Wayfair Perigold` / `Wayfair Outlet`.
- **Single tab + `Load Type` column** (simplest; current behavior + 1 column).
- **Family × condition** (most granular).

Default until decided: single `Wayfair` tab + `Load Type` column (easy to switch).

## 7. Parser requirements (for `transformWayfairManifest`)

1. Detect & ignore the worksheet-name fragment xlsx prepends to the header row
   (e.g. `Liquidation Load 50477 PerrisSm`).
2. Match the 25-column header; tolerate optional trailing `Recovery Rate` /
   `Total Recovery`.
3. Coerce scientific-notation UPCs; strip `$` and commas from money fields.
4. Handle both UTF-8 and Latin-1 (mojibake cleanup on text fields).
5. Treat blank `Pallet ID` / `Product Category` as normal.
6. Derive SKU + load type + location from the filename (`deriveWyfSkuFromFilename`).
7. Compute `% of Load QTY` / `% of Load $$` after totals (mirror `transformSamsManifest`).
