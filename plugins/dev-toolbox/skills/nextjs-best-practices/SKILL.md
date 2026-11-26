---
name: nextjs-best-practices
description: Next.js App Router decisions (Server vs Client Components, data fetching and caching, Server Actions, route handlers, metadata). Use when writing or reviewing code in a Next.js app directory. Not for plain React components (react-best-practices).
---

# Next.js App Router

Written for this plugin from the official Next.js documentation (nextjs.org/docs, App Router),
as of Next.js 16. Caching defaults and several APIs changed in 15 and again in 16, so:

1. Read the `next` version in `package.json` and `next.config.*` before giving advice.
2. For anything version-sensitive, look it up (the `library-docs` skill, library
   `/vercel/next.js`) instead of answering from memory.

## Server and Client Components

Components are Server Components unless a file starts with `'use client'`.

| Needs | Component |
|---|---|
| Data from a database or an API, secrets, large dependencies that should not ship to the browser | Server |
| State, effects, event handlers, browser APIs, hooks that use them | Client |
| Both | Server parent that fetches, Client child that interacts |

- `'use client'` marks a boundary: everything the file imports becomes client code. Put it on the
  smallest interactive leaf, not on a layout or a page.
- Props that cross the boundary must be serializable. Pass Server Components to a Client Component
  as `children`, not as imports.
- Code that must never reach the browser (database clients, secret readers) imports
  `server-only`, so a wrong import fails the build.
- Only variables prefixed `NEXT_PUBLIC_` reach the browser, and they are inlined at build time.

## Request data is asynchronous

`params`, `searchParams`, `cookies()`, `headers()` and `draftMode()` are asynchronous. Next.js 15
still accepted synchronous access with a warning; 16 removed it.

```tsx
export default async function Page(props: PageProps<'/blog/[slug]'>) {
  const { slug } = await props.params
  const query = await props.searchParams
  // ...
}
```

`PageProps` and `LayoutProps` are generated global types (`npx next typegen`, also on `dev` and
`build`). In a Client Component, read a params promise with React's `use()`.

## Fetching data

- Fetch in the Server Component that needs the data, straight from the data source. Do not call
  your own route handler from a Server Component: call the function.
- Start independent requests together (`Promise.all`) instead of awaiting them one after another.
- Wrap a slow part in `<Suspense>` (or give the route a `loading.tsx`) so the rest of the page
  streams first.
- The same `fetch` in one render is deduplicated. For a database call, wrap the function in
  React's `cache()`.
- To let a Client Component show server data without a waterfall, pass the promise down and read
  it with `use()` inside `<Suspense>`.

## Caching

Nothing is cached unless the code asks for it (since Next.js 15): a `fetch` without options is
not cached at request time, and `GET` route handlers are not cached. Which API to use depends on
one setting.

**`cacheComponents: true` in `next.config` (the Next.js 16 model)**

- Mark what may be cached with the `'use cache'` directive in an async function or component, set
  its lifetime with `cacheLife('hours')` and name it with `cacheTag('posts')`.
- Data that is neither cached nor inside `<Suspense>` is a build error: decide for each read
  whether it is cached or streamed at request time.
- A component that must render per request without reading cookies or headers awaits
  `connection()`.
- The route segment options `dynamic`, `revalidate` and `fetchCache` do not apply in this model.
  In a route handler, put `'use cache'` in a helper function, not in the handler body.

**Without it (the previous model)**

- Opt in per request: `fetch(url, { cache: 'force-cache' })` or
  `fetch(url, { next: { revalidate: 3600, tags: ['posts'] } })`.
- Opt in per route: `export const revalidate = 3600`, or `export const dynamic = 'force-static'`
  for a `GET` route handler.

**After a mutation, choose one**

| Call | Effect |
|---|---|
| `updateTag('posts')` | Expires the tag now; the next read waits for fresh data. Server Actions only. Use when the user must see their own change. |
| `revalidateTag('posts', 'max')` | Stale-while-revalidate. The second argument (a cache-life profile) is required in Next.js 16. Works in route handlers and webhooks. |
| `revalidatePath('/posts')` | Invalidates one path when tagging is more than the case needs. |
| `refresh()` | Refetches the current route without invalidating cached data. |

## Server Actions

A Server Action (`'use server'`) is a public HTTP endpoint, whatever page it is defined in.

- Authenticate and authorize **inside** the action. A check in the page or the layout does not
  protect it.
- Validate every argument on the server (a schema library such as Zod); `FormData` values are
  user input.
- Return a serializable result for expected failures and render it with `useActionState`; throw
  only for unexpected ones.
- After the write, update the cache (table above). `redirect()` works by throwing, so call it
  outside any `try`/`catch`.
- Use actions for mutations. Reads belong in Server Components.

## Route handlers and the proxy

- `route.ts` is for what a browser page does not cover: webhooks, a public API, non-HTML
  responses. It cannot share a folder with `page.tsx`.
- Validate the body, return real status codes, and check the caller's identity in the handler.
- The default Node.js runtime is the right choice unless there is a measured reason for Edge,
  which has no Node.js APIs.
- Next.js 16 renames `middleware.ts` to `proxy.ts` (`export function proxy(request) {}`). Keep it
  to redirects, rewrites and headers. It is not the only place to enforce authorization: check
  again where the data is read.

## Routing files

| File | Purpose |
|---|---|
| `page.tsx`, `layout.tsx` | Route UI and the layout shared by its children |
| `loading.tsx` | Suspense fallback for the segment |
| `error.tsx` | Error boundary for the segment; must be a Client Component |
| `global-error.tsx` | Error boundary for the root layout; renders its own `<html>` and `<body>` |
| `not-found.tsx` | Rendered by `notFound()` |
| `(group)/` | Organizes routes without changing the URL |
| `@slot/` | Parallel routes rendered in the same layout |
| `(.)segment/` | Intercepts a route, for example to show it as a modal |
| `_folder/` | Private folder, never a route |

Colocate a route's own components in its folder; share the rest from a folder outside `app/`
(`components/`, `lib/`).

## Metadata

- Export `metadata` for fixed values or `generateMetadata` for values that depend on the route.
  Both work only in Server Components. Viewport settings go in `viewport` / `generateViewport`.
- Set `metadataBase` in the root layout so relative Open Graph URLs resolve.
- Use the file conventions where they fit: `opengraph-image`, `icon`, `sitemap.ts`, `robots.ts`.

## Assets and bundle

- `next/image` for images, with `width` and `height` (or `fill`) and a `sizes` value for
  responsive ones. For the largest above-the-fold image use `preload` (Next.js 16; `priority` in
  15 and earlier, now deprecated) or `loading="eager"`.
- `next/font` for fonts: self-hosted, no layout shift.
- `next/dynamic` or `React.lazy` for a heavy Client Component that is not needed at first paint.
- Third-party scripts through `next/script` with an explicit `strategy`.

## Review checklist

- [ ] `'use client'` only on interactive leaves; no server-only module imported from client code
- [ ] `params`, `searchParams`, `cookies()` and `headers()` are awaited
- [ ] Each data read is either explicitly cached or streamed under `<Suspense>`; no accidental
      request waterfall
- [ ] Every Server Action and route handler authenticates, authorizes and validates its input
- [ ] Mutations update the cache with the call that matches the need
- [ ] Segments that can fail or be slow have `error.tsx` and `loading.tsx` (or a `<Suspense>`)
- [ ] No secret in a `NEXT_PUBLIC_` variable or in a prop passed to a Client Component

For React component performance (re-renders, bundle size, waterfalls inside components) use
`react-best-practices`.
