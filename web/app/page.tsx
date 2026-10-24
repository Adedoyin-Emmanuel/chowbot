import { Faq } from "@/components/site/faq";
import { Hero } from "@/components/site/hero";
import { Safety } from "@/components/site/safety";
import { Footer } from "@/components/site/footer";
import { Header } from "@/components/site/header";
import { Connect } from "@/components/site/connect";
import { Showcase } from "@/components/site/showcase";
import { Features } from "@/components/site/features";
import { PromptBand } from "@/components/site/prompt-band";
import { ClosingCta } from "@/components/site/closing-cta";
import { HowItWorks } from "@/components/site/how-it-works";

export default function Home() {
  return (
    <>
      <Header />
      <main id="main">
        <Hero />
        <PromptBand />
        <Features />
        <HowItWorks />
        <Showcase />
        <Safety />
        <Connect />
        <Faq />
        <ClosingCta />
      </main>
      <Footer />
    </>
  );
}
