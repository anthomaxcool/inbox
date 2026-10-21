// Random 128-bit IDs, Crockford base32 (26 chars). Never sequential (plan §7).
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export function randomId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	let bits = 0;
	let value = 0;
	let out = '';
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
	return out;
}

export const ID_PATTERN = /^[0-9a-hjkmnp-tv-z]{26}$/;

export async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function nowIso(): string {
	return new Date().toISOString();
}
