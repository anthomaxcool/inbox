// No client-side Svelte runtime: pages are server-rendered HTML plus one self-hosted script
// (static/review.js), so the CSP needs no inline-script exception (plan §8.11).
export const csr = false;
export const prerender = false;
