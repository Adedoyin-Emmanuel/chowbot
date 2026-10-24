import { ClosingCta } from "@/components/site/closing-cta";
import { Connect } from "@/components/site/connect";
import { Faq } from "@/components/site/faq";
import { Features } from "@/components/site/features";
import { Footer } from "@/components/site/footer";
import { Header } from "@/components/site/header";
import { Hero } from "@/components/site/hero";
import { HowItWorks } from "@/components/site/how-it-works";
import { PromptBand } from "@/components/site/prompt-band";
import { Safety } from "@/components/site/safety";
import { Showcase } from "@/components/site/showcase";

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
