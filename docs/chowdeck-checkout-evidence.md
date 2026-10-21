# Chowdeck checkout evidence (storefront code, 2026-10-21)

Read as text from Chowdeck's public storefront bundle on 2026-10-21. No API
requests were made and nothing was executed. Chunk names change on every
deploy:

- `3488-5180f93212136eb4.js`
- `6117-63662d353a80393c.js`
- `app/(payments)/checkout/page-e9cd5402f11d90c4.js`

**Labels:**
- **[CODE]**: the client code establishes what the website *sends* and *reads*.
- **[NET]**: observed traffic (see the earlier capture reports).
- **Unknown**: server-side rules, limits and error responses, unless stated otherwise.

## Order payload (`handleCheckout`, 3488) [CODE]
- `customer_vendor_note` and `customer_delivery_note` are copied **from the cart**.
- `promo_codes` is `[promo?.code, discount?.code].filter(Boolean)`, or `[]`.
- `gift_recipient` is the gift form object, or `null`. It is always `null` for pickup.
- `tip` is set only when truthy (`q && (e.tip = q)`), so it is never sent as `0`.
- `payment_method_id` is the selected channel's `id`, and `payment_method` is that channel's `type`. Online channels have no `type`, so the key is dropped.

## Notes [CODE]
- **Restaurant note:** the cart's note sheet calls `handleSaveToCart(vendorId, { customer_vendor_note })`.
- **Delivery (rider) note:** the checkout page calls `handleSaveToCart(vendorId, { customer_delivery_note })`.
- `handleSaveToCart(vendorId, payload)` sends **`POST /customer/cart/vendor/{vendorId}`** with that payload alone.
- New carts start with both notes as `""`.
- The textareas have no `maxLength`, and Chowdeck's server-side limit is unknown. ChowBot's 500-character limit is its own.
- "Save for later" keeps reusable notes on the device only (`saveCustomerNote`).
- `PUT /customer/order/{id}/delivery` with `{customer_delivery_note}` edits the note on an **existing** order. ChowBot doesn't use it.

## Promo codes and discounts [CODE]
**Endpoint map:**
- `customerPromoCodes`: `/customer/promo-code`
- Re-read 2026-10-21, same build: confirmed unchanged.
- `customerDiscounts`: `/customer/discount`
- `applyDiscount`: `/customer/discount/apply`
- `config`: `/customer/config`

**Calls:**
- `GET /customer/promo-code`: the user's codes.
- `GET /customer/discount`: the user's discounts.
- `POST /customer/promo-code/{code}` with `{ currency, security_answer? }`: adds or redeems a code on the account. **A mutation.**
- `GET /customer/promo-code/{code}/security-question?currency=`: a code's security question.
- `POST /customer/discount/apply`: a calculation, re-run automatically by the site, including on window focus. Its body:
  ```
  { promo_codes: [code] | [], vendor_id, address_id, fee_id (or 0), cart_id?,
    currency, order_items, containers,
    delivery_fee: fee.final_delivery_amount || 0, order_class }
  ```
  - `order_items` and `containers` are built from the website's **local pack model**:
    - menu items as `{ item_id, quantity, type, pack_id (pack index + 1), pack_unique_id }`;
    - options as `{ item_id, price, quantity, type: "group", pack_id, group_id }`;
    - containers as `{ id, quantity, name, price, type: "container", pack_id }`.
  - The response's `data` is a list of applied discounts, each with `amount_off`, an optional `bogof_amount_off`, and a `target` (for example `deliveryfees`, `menus`, `menucategories`).
  - The website's total is `subtotal + service + delivery + bags − Σ(amount_off + bogof_amount_off)`.

**The pack model (now established from source).**
- **The chain:** `initializeCart(cart)` sets `packs = 16117.Mdh(cart.cart_items, cart.vendor)`. `Mdh` re-exports `64269.Md`, which is `P(cart_items, vendor)`.
- **What `P` does:**
  - It groups rows by `pack_reference`, in order of first appearance, into `{ name: "Pack n", id: pack_reference, items }`.
  - Each `type: "menu"` row becomes `{ cart_item_id, quantity, pack_id: pack_reference, type, menu: { id: item_id, price: H(price_per_quantity, discount_price), … } }`.
  - Its modifiers are `{ [menu_group_id]: [{ id: item_id, price: H(…), menu_group_id, quantity, … }] }`, taken from the pack's `type: "group"` rows.
  - Each `type: "container"` row is also added as its own item, `{ cart_item_id, quantity, pack_id, type: "container", menu: { id: item_id, name, price: price_per_quantity } }`.
- **`H(price, discount)`** returns `discount` when `0 ≤ discount < price`, otherwise `price`.
- **The `discount/apply` builder then emits:**
  - `order_items`:
    - `{ item_id: menu.id, quantity, type: type || "menu", pack_id: packIndex + 1, pack_unique_id: pack.id }` for each non-container item;
    - `{ item_id, price, quantity, type: "group", pack_id: packIndex + 1, group_id: menu_group_id }` for each modifier.
  - `containers`: `{ id: menu.id, quantity, name: menu.name, price: menu.price, type: "container", pack_id: packIndex + 1 }`.
- **So the request body can be reproduced from server cart rows without guessing [CODE].**

**How promo codes reach checkout [CODE]:**
- A new code is **redeemed onto the account** first: `GET /customer/promo-code/{code}/security-question?currency=`. If a `security_question` comes back, the user answers it; then `POST /customer/promo-code/{code}` with `{ currency, security_answer? }` runs. **That's a mutation.**
- The user then **selects** a promo from the list `GET /customer/promo-code` returns. The order's `promo_codes` takes the selected object's `code`.
- The website never submits a typed code that hasn't been redeemed.

**Still not established, so ChowBot doesn't call `discount/apply`:**
- **Never observed on the wire.** The 2026-10-20 capture recorded a `POST /customer/discount/apply` with HTTP 200, but its body wasn't read [NET].
- **Which applied discount comes from the user's code.** The client reads only `amount_off`, `bogof_amount_off` and `target`, and doesn't match discounts to a code.
- **Server responses for invalid, expired, ineligible or unredeemed codes.** The client has no error handling of its own; it just leaves the query in an error state.
- **Whether `fee_id: 0` and `delivery_fee: 0`** (no quote) give meaningful results.
- **The response shape** of `GET /customer/promo-code`, which would be needed to check a code is already on the account.

## Gift recipient [CODE]
- **Schema (module 64834):** `phone` must match `/^[0-9]+$/` (**digits only**). `donor_name` (defaults to the user's first name), `name` and `country_code` are required, all non-empty.
- **Country code:** the default comes from the first country in the phone picker. The list's entries look like `{ code: "NG", callingCode: "234", … }`, so `country_code` is a two-letter code; the default is presumably `NG`.
- **Optional:** `email` (valid or `""`) and `message`.
- **Sent as:** `{ ...form, country_code, phone: phone.trim(), save_as_beneficiary, message: message.trim() }`.
- **Phone check:** before saving, the site calls **`POST /auth/phone/validate`** with `{ phone, country_code }` and reads `response.data.data.is_valid` (module 55926, `validatePhone`).
  - It is source-derived only: never run, and its responses (including for invalid numbers) were never observed.
  - ChowBot doesn't call it.
- **Delivery:** the gift goes to the cart's selected address. **Clear** sets the gift to `null`.

## Tip [CODE]
- **Config:** `GET /customer/config` returns `data.delivery_driver_tips_config` with `recommendation_percent` (numbers, optionally `"Custom"`), `default_percent`, `minimum_tip_amount` and `maximum_tip_amount` (raw ×100).
- **No tip control without config:** the tip section renders nothing when `recommendation_percent` is absent.
- **Custom tip (naira):**
  - an error if it isn't a number or is below `min/100`;
  - an error if `max > 0` and it's above `max/100`;
  - otherwise `tip = Math.round(100 × value)`.
- **Presets:** `max(1000 × round(cartTotal × percent / 100 / 1000), min)`, capped at `max` when `max > 0`.
- **Automatic default tip:** applied on mount only when `default_percent` is truthy. ChowBot never applies one.

## Address transform (6117) [CODE]
- **Lookup:** `address_components.forEach(c => c.types.forEach(t => map[t] = c.long_name))`.
  - It reads **`long_name`**, never `short_name`.
  - The **last** component of a type wins.
- **Fields:**
  - `city` and `area` both use the chain `neighborhood || sublocality || sublocality_level_1 || locality || administrative_area_level_2 || "nil"`.
  - `state` is `administrative_area_level_1 || ""`.
  - `country` is `country || ""`.
  - Coordinates fall back to `|| 0`, which ChowBot refuses.
- **Saved addresses:** `coordinate.y` is latitude and `coordinate.x` is longitude (cart builder in 3488).

## Payment start [CODE] (re-read 2026-10-21)
- **Where:** after `POST /customer/order` succeeds with `made_payment: false`, the website calls `POST /customer/payment/start/v2`. It skips this for cash, and for `pay_for_me` when a `pay_for_me_url` is present.
- **Body:**
  - `method`: the channel's `type`, or failing that its `name` (`"opay"`);
  - `order_id`: the create response's `data.id`, unchanged. It was observed as a number [NET].
  - **OPay:**
    - `return_url = ${origin}/store/ongoing-order?orderId=${id}`
    - `cancel_url = ${origin}${pathname}${search}?status=failed`, which is `/store/checkout?status=failed` on the website
  - **Other channels:** `callback_url` and `return_url`, both set to the ongoing-order URL.
  - **Optional:** `split_payment_with_wallet`, `source: "opay"`, `pocket_tag`, `momo_account_number`, `payment_phone`.
- **ChowBot** sends the website's own pages on `https://chowdeck.com` (`paymentRedirects` in `features/payments/service.ts`).
- **Still unobserved [NET]:** whether `GET /customer/order/{id}` returns an **unpaid** order. `start_payment` checks that before starting a payment, and stays unregistered in production until it's seen.

## Implementation status (2026-10-21)
- **`check_promo_code` and `preview_order`** run `discount/apply` as above, with and without the code. ChowBot reports the difference as the code's effect; it's not a Chowdeck figure.
- **`place_order`** sends `promo_codes: [code]` only when that difference is positive. It also sends:
  - `tip`: raw ×100, only when chosen;
  - `gift_recipient`: the validated object, after `POST /auth/phone/validate` returns `is_valid: true`.
- **None of these has been observed on the wire yet.**
