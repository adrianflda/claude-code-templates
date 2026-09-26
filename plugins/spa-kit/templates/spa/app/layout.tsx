import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { pageMetadata } from "@/lib/seo/metadata.ts";
import { jsonLdScript, organizationSchema, websiteSchema } from "@/lib/seo/jsonld.ts";
import { site } from "@/lib/site.ts";
import { SiteHeader } from "@/components/site-header.tsx";
import { SiteFooter } from "@/components/site-footer.tsx";
import "./globals.css";

export const metadata: Metadata = pageMetadata({
  title: site.name,
  description: site.description,
  path: "/",
});

export const viewport: Viewport = {
  themeColor: "#07090d",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang={site.locale.split("_")[0]}>
      <head>
        {/* Rendered server-side: answer engines read JSON-LD out of raw HTML. */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonLdScript(organizationSchema()) }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: jsonLdScript(websiteSchema()) }}
        />
      </head>
      <body>
        <SiteHeader name={site.name} />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
