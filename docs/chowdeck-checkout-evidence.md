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

**Established on the wire on 2026-10-22 (see below); still open:**
- **Server responses for invalid, expired, ineligible or unredeemed codes** to `discount/apply`. Only a success was observed.
- **Whether `fee_id: 0` and `delivery_fee: 0`** (no quote) give meaningful results. `check_promo_code` and `preview_order` still send them; `get_checkout_quote` sends the real quote's values.

## Live checkout observations [NET] (2026-10-22, the user's own browser session)

Captured by the user from the website's network tab; order ids are real, other values as
recorded. Six unpaid orders were created from one cart; none was paid.

**Carts**
- `POST /customer/cart/vendor/{vendor_id}` with `{"customer_vendor_note": …}` or
  `{"customer_delivery_note": …}` (or `{"bag_quantity": 1}`) answers
  `{"status":"success","message":"Cart updated successfully"}` with no cart. The website then
  re-reads `GET /customer/cart/vendor/{vendor_id}`, whose `data` carries both notes.
- Cart 31006911 stayed `status: "active"`, `is_active: true` and **`order_id: null`** while six
  orders were created from it. An order is a copy of the cart: editing the cart afterwards does
  not reach an order. A cart with `order_id` set, or after a **paid** order, was not observed.
- `GET /customer/cart` lists every active cart with the same fields.

**Promo codes and discounts**
- `GET /customer/promo-code` → `data[]` of `{ id, code, note, user_id, promo_code_id, amount,
  is_valid (1), expiry_time, discount_id, maximum_usage_count, usage_count,
  minimum_order_amount, maximum_order_amount, vendor_id, vendor_ids[], title, target_service
  ("deliveryfees" | "orders"), type, settings, voucher_type ("discount"), display_name,
  voucher_status, voucher_worth, vendors[] }`. Observed codes: `5FOR5` (free delivery, minimum
  300000, single use) and `DECK11` (N500 off, minimum 250000).
- `GET /customer/discount` → `{"data":[]}`; an entry's shape was never seen.
- `POST /customer/promo-code/{code}` with `{"currency":"NGN"}` for an unknown code →
  `{"status":"failed","message":"Promo code does not exist"}`. For an existing code the website
  then calls `GET /customer/promo-code/{code}/security-question?currency=NGN` →
  `{"data":{"security_question":null}}`. ChowBot does not redeem codes.
- **`POST /customer/discount/apply`**, sent when a code was chosen:
  `{"promo_codes":["5FOR5"],"vendor_id":134985,"address_id":4966130,"fee_id":262993706,"cart_id":31006911,"currency":"NGN","order_items":[{"item_id":2974683,"quantity":1,"type":"menu","pack_id":1,"pack_unique_id":"pack-…"}],"containers":[],"delivery_fee":65000,"order_class":"delivery"}`
  → `data[]` of `{ discount_id, title, description, amount_off (65000), target ("deliveryfees"),
  bogof_amount_off, vendor_id, discount_terms, maximum_usage_count, usage_count,
  promo_code ("5FOR5"), … }`. **Each discount names the promo code it came from**, and the
  request carries the quote's `fee_id` and `final_delivery_amount`.
- The website then looked up payment methods with `amount=636000`: 701000 (items 550000 + bag
  20000 + delivery 65000 + service 66000) minus the 65000 discount.

**Orders and payment**
- `POST /customer/order` with `promo_codes: ["5FOR5"]` was accepted three times for the same
  single-use code while unpaid. Each answered `{ id, reference, delivery_price, tip_amount,
  made_payment: false, pay_for_me_url, delivery_pin, tracking_url, … }`.
- `POST /customer/payment/start/v2` for OPay: `{ method: "opay", order_id, return_url,
  cancel_url }` → `{ processor: "opay", reference, authorization_url, currency,
  amountInLowerUnits: 636000, status: "initialised", display_type: "webview" }`. The
  processor's amount already includes the promo discount. Card, bank transfer, bank and USSD
  start Paystack pages; Pocket and Zap differ; QR fails (also in the app).
- **`GET /customer/order/{id}` returns an unpaid order**: order 43609160 showed
  `status: "abandoned"` seconds after creation, `payment: {}`, `time_payment_confirmed: null`,
  `total_price: 701000`, `promo_codes: ""`, `promo_code_price: 0`, `discount_price: 0`, both
  notes, `can_be_updated: false`, and a timeline listing `MADE_PAYMENT` first (never evidence).
  `GET /customer/order?status=active` listed it too.
- **Tracking:** every create response and order record carried
  `tracking_url: https://chowdeck.com/store/track/<token>`, a page anyone with the link can open.
  `GET /customer/order/{id}/live-tracking` answered `{ order_id, user_id, order_status,
  order_class, placed_at, delivered_at, delivery_id, delivery_status, delivery_is_terminal,
  rider, rider_location, customer_location, vendor_location, route, socket_room,
  pusher_channel }`, all delivery fields null for the unpaid order. ChowBot (`track_order`,
  `get_order`, `place_order`) passes on only a tracking link of exactly that form, and leaves out
  the user id, locations of the customer and vendor, route and channel names.
- **Not observed:** an unpaid order's record **with** a promo code (whether `total_price`
  already subtracts the discount and how `promo_codes` lists it), a paid order's record in this
  session, and any cancellation. `POST /customer/order/{id}/cancel` was reported by the user;
  its body, eligibility and responses are unverified, and ChowBot sends it without a body.

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

## Implementation status (2026-10-22)
- **Order state** is read only from `GET /customer/order/{id}` (`features/orders/status.ts`):
  paid only when `payment.status` is `success`; cancelled when the status contains `cancel`;
  unpaid when there is no successful payment and no `time_payment_confirmed`; otherwise
  unknown. A failed read is `unknown`, never unpaid.
- **`list_promo_codes`** reads both promo lists. **`get_checkout_quote` with `promo_code`**
  accepts only a code on the account, sends `discount/apply` once with the fresh quote's fee,
  and counts the code as applied only when a returned discount names it. The quote stores the
  code and Chowdeck's discount and supersedes older unconfirmed quotes for the cart.
- **`check_promo_code` and `preview_order`** still calculate without a fee quote and attribute
  discounts by `promo_code`; delivery-fee discounts need the quote.
- **`place_order`** sends the quote's code, `tip` (raw ×100, only when chosen) and
  `gift_recipient` (after `POST /auth/phone/validate` returns `is_valid: true`), then reads the
  order record and reports its state, total and notes.
- **`start_payment`** shows the order record's `total_price` and starts only with that total
  confirmed; **`cancel_order`** sends `POST /customer/order/{id}/cancel` once and trusts only
  the re-read order record.
