const PROMPTS = [
  "What's on my Chowdeck cart?",
  "Find jollof rice near me that's open now",
  "Order my usual shawarma from Item 7",
  "Any promo codes I can use?",
  "Pay with OPay",
  "Where's my rider?",
  "What's my delivery PIN?",
  "Send lunch to my sister",
];

/*
 * A scrolling ribbon of things people say to ChowBot, on Chowdeck's green
 * with its scalloped trim. Decorative, so hidden from screen readers.
 */
export function PromptBand() {
  const items = [...PROMPTS, ...PROMPTS];
  return (
    <div aria-hidden className="relative">
      <div className="scallop-band h-[22px] rotate-180" />
      <div className="overflow-hidden bg-chow-green py-6">
        <div className="flex w-max animate-marquee gap-4 motion-reduce:animate-none">
          {items.map((prompt, index) => (
            <span
              key={index}
              className="flex items-center gap-4 text-2xl font-extrabold tracking-tight whitespace-nowrap text-white sm:text-3xl"
            >
              “{prompt}”
              <span className="text-sun">✦</span>
            </span>
          ))}
        </div>
      </div>
      <div className="scallop-band h-[22px]" />
    </div>
  );
}
