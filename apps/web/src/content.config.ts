import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
import { glob } from "astro/loaders";
import { defineCollection, z } from "astro:content";

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
  changelog: defineCollection({
    loader: glob({ base: "./src/content/changelog", pattern: "**/*.md" }),
    schema: z.object({
      title: z.string(),
      date: z.date(),
      component: z.enum(["ios", "android", "desktop", "bridge", "cli", "tunnel", "site"]),
      version: z.string().optional(),
      link: z.string().url().optional(),
    }),
  }),
};
