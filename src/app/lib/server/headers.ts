// Response headers on every inbox-app response (plan §8.11). The same values are in `_headers`
// for static assets, and test/node/headers.test.ts keeps the two in step.
export const CSP =
	"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export const SECURITY_HEADERS: Record<string, string> = {
	'Content-Security-Policy': CSP,
	'X-Robots-Tag': 'noindex',
	'Referrer-Policy': 'no-referrer',
	'X-Content-Type-Options': 'nosniff'
};

export function withSecurityHeaders(response: Response): Response {
	const out = new Response(response.body, response);
	for (const [name, value] of Object.entries(SECURITY_HEADERS)) out.headers.set(name, value);
	return out;
}
