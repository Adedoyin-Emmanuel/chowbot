# Plan: sending tip, gift and promo code through `place_order`

**Status (updated 2026-10-22): steps 1–4 and 6 are implemented** for tip, gift and promo code.
- **Promo:** applied in `get_checkout_quote` (not `place_order`), only for a code on the account and only when Chowdeck's discount calculation, sent with the quote's fee, returns a discount naming the code. The code and discount are stored on the quote (migration 0007), which resolves step 5 for promo codes. See `docs/chowdeck-checkout-evidence.md`.
- **Gift:** sent only after `POST /auth/phone/validate` returns `is_valid: true`.
- **Step 5 (storing the extras on the submission record) is not done.** It would need a schema change. Chowdeck's order record is the reference instead.
- **Still off:** `place_order` stays registered only with `CHOWBOT_PLACE_ORDER_ENABLED` and the channel settings, and `start_payment` stays unregistered.
- The tables below describe the state before this change.

## What `place_order` submits today (`features/order-placement/service.ts`)

| Field | Submitted | Shown in the confirmation | Bound against later changes |
|---|---|---|---|
| `customer_vendor_note` | from the cart, re-read at submit | yes (exact text) | yes (`notesDigest` in the HMAC'd request state; submit refuses on change) |
| `customer_delivery_note` | from the cart, re-read at submit | yes (exact text) | yes (same) |
| `tip` | never sent | "Tip: none" | n/a |
| `promo_codes` | always `[]` | "No promo code or gift details are sent" | n/a |
| `gift_recipient` | always `null` | same | n/a |

`preview_order` accepts `promo_code`, `tip` and `gift` as **preview-only draft values**. Its output says so ("place_order does not send promo codes, tips or gift details yet").

## The smallest change set, once each field's evidence exists

1. **Arguments.** Add optional `tip`, `gift` and `promo_code` to `PlaceOrderArgs` and the tool schema. Validate them with the existing `features/checkout/draft.ts` functions, the same code `preview_order` uses, so preview and submission cannot drift apart.
2. **Confirmation (`askForConfirmation`):**
   - **Tip:** re-read `GET /customer/config` and validate with `tipFromNaira`. Show the tip in naira, and show the total as `computed_total + tip`, labelled as computed by ChowBot.
   - **Gift:** show recipient, phone, country, message and `save_as_beneficiary`. Saving a beneficiary is a side effect on the account, so the user must explicitly opt in.
   - **Promo:** show the code and say that **no discount is confirmed**. The displayed total doesn't include any discount.
3. **Binding.** Add an `extrasDigest` to `PlacementState` covering the validated tip (raw), gift object and promo code, the same way `notesDigest` works. Submit recomputes it from the arguments and refuses on any mismatch, and also refuses a state without it.
4. **Payload (`sendOrderOnce`):**
   - `tip`: the raw ×100 amount, only when greater than 0.
   - `gift_recipient`: the validated object, or `null`.
   - `promo_codes`: `[code]`, or `[]`.

   All three must be built by one shared helper that `preview_order` also uses.
5. **Record keeping.** `order_submissions.computed_total` excludes extras. Storing the submitted tip, promo or gift for recovery and audit would need **new columns, which means a schema change**. Alternatively, rely on Chowdeck's order record. This needs a decision before implementing.
6. **Tests.** Cover exact payload equality with each extra, the confirmation text, digest mismatch refusals, tip limit failures, and preview/submission parity.

## Evidence still required before each field may be submitted

| Field | Known from source [CODE] | Missing |
|---|---|---|
| `tip` | units (raw ×100), `Math.round(100 × naira)`, inclusive config limits, omitted when 0 | one captured order **with** a tip [NET]: the earlier order had `tip` present but its value wasn't recorded |
| `gift_recipient` | the object shape, digits-only phone, `country_code` such as `NG`, `POST /auth/phone/validate` | any wire observation of a gift order or of the phone-validation response; whether Chowdeck needs the phone validated first |
| `promo_codes` | array of codes, discount/apply request shape and pack model | redemption (`POST /customer/promo-code/{code}` is a mutation, possibly with a security question); the discount/apply response for valid, invalid, expired and ineligible codes; which discount comes from the code; whether an unredeemed code is accepted |

Until a field's evidence exists, submitting it would be inference. Keep it preview-only.

## Recommended next milestone

**"Tip submission", gated behind the existing `place_order` flag.**
- Tip has the strongest evidence: the units, conversion and limits are all in source, and omitting it at 0 is already the behaviour.
- **Prerequisite:** one read-only passive capture of a real order that includes a tip, made by the user, which records the `tip` value and type.
- **Then:** implement steps 1–4 and 6 for `tip` only, and decide step 5.
- **Gift and promo** follow once their wire evidence exists. Promo additionally needs a design for redemption (an account mutation) with its own confirmation.
