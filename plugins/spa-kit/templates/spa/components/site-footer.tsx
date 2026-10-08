import { content } from "@/content.ts";

export function SiteFooter() {
  return (
    <footer className="border-t border-rim/60 bg-void">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-6 py-8">
        <p className="text-sm text-fg-muted">{content.footer.note}</p>
        {content.footer.links.length > 0 && (
          <nav aria-label={content.ui.footerNav}>
            <ul className="flex flex-wrap items-center gap-5">
              {content.footer.links.map((link) => (
                <li key={link.href}>
                  <a
                    href={link.href}
                    className="text-sm text-fg-muted transition-colors duration-[var(--kit-dur-fast)] ease-[var(--kit-ease-glide)] hover:text-fg"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </div>
    </footer>
  );
}
