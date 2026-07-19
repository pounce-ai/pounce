// Deploys the use-pounce.com site (Astro static output) to Cloudflare Workers.
//
//   bun alchemy deploy                 → verification deploy on a workers.dev URL
//   bun alchemy deploy --stage prod    → production deploy on use-pounce.com
//
// The use-pounce.com zone already exists in the Cloudflare account (its
// nameservers point at Cloudflare), so the `domain` prop can attach the apex
// hostname directly. First run walks through the interactive Cloudflare login.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "PounceWebsite",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const site = yield* Cloudflare.Website.StaticSite(
      "Website",
      Alchemy.Stack.useSync((stack) => ({
        command: "bun run build",
        outdir: "dist",
        domain: stack.stage === "prod" ? ["use-pounce.com", "www.use-pounce.com"] : undefined,
        dev: {
          command: "bun run dev",
        },
        memo: {
          include: ["src/**", "public/**", "astro.config.mjs", "package.json", "../../bun.lock"],
        },
        compatibility: {
          flags: ["nodejs_compat"],
        },
        assets: {
          notFoundHandling: "404-page",
        },
      })),
    );

    return { url: site.url };
  }),
);
