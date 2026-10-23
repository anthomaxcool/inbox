// Values the owner pastes into the Cloudflare dashboard. A copy button or a rich-text paste can
// carry invisible characters and surrounding spaces, which make an exact comparison fail silently.
const INVISIBLE = /[­​-‍⁠﻿]/g;

/** The pasted value without invisible characters or surrounding whitespace. '' when unset. */
export function cleanConfig(raw: string | undefined): string {
	return (raw ?? '').replace(INVISIBLE, '').trim();
}

/** An address from config or the envelope, compared case-insensitively and without `<…>`. */
export function cleanAddress(raw: string | undefined): string {
	return cleanConfig(raw).replace(/^<(.*)>$/, '$1').trim().toLowerCase();
}
