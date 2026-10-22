// Agent key SQL, shared by key-create.mjs / key-revoke.mjs and tested in test/mail/keys.test.ts.
// The key itself is never stored: only its SHA-256 (plan §8.6).
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const LABEL = /^[a-z0-9][a-z0-9-]{1,40}$/;

function base32(bytes) {
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

export function checkLabel(label) {
	if (!LABEL.test(label ?? '')) throw new Error('label must be 2-41 chars: lowercase letters, digits, dashes');
	return label;
}

/** 256-bit random key, shown once. */
export function makeKey() {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return `ibx_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

export async function sha256Hex(text) {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createKeySql(label, key, now = new Date().toISOString()) {
	checkLabel(label);
	const id = base32(crypto.getRandomValues(new Uint8Array(16)));
	return `INSERT INTO agent_keys (id, label, key_hash, created_at) VALUES ('${id}', '${label}', '${await sha256Hex(key)}', '${now}');`;
}

export function revokeKeySql(label, now = new Date().toISOString()) {
	checkLabel(label);
	return `UPDATE agent_keys SET revoked_at = '${now}' WHERE label = '${label}' AND revoked_at IS NULL;`;
}
