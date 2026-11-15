# apps/site

Marketing site, help centre and trust centre (epic OL-E10, later Sanity CMS).

**Today the public website lives in `apps/web`**, in the `src/app/(site)` route group, so it shares
the design system, the CSP middleware and one deployment with the product:

- Pages: `/`, `/features`, `/pricing`, `/compare/*`, `/help` (+ articles), `/blog` (+ posts),
  `/contact`, `/security`, `/privacy`, `/terms`, plus `sitemap.xml`, `robots.txt` and a 404.
- Content: `apps/web/src/content/` (help articles, blog posts, pricing, comparisons, legal drafts).
  Help articles must match how the product works — check the PRDs when a feature changes.
- Undecided values (domain, email addresses, company legal name, address, effective date):
  `apps/web/src/config/site.ts`. Set `NEXT_PUBLIC_SITE_URL` once the domain exists.
- Comparison pages publish a competitor fact only with a source URL and a check date; pages with
  no verified facts are `noindex` and left out of the sitemap.
- Product screenshots: `apps/web/public/screens/*.png` (1440×900, captured from a seeded demo
  workspace).
- Tests: `tests/e2e/specs/site.spec.ts`.

Pages still planned here: Customers, How we measure, Changelog, About, pricing calculator.
