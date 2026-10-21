// Message-ID handling. IDs are stored without angle brackets, case preserved.

/** Pull every `<id>` out of a header value. Falls back to whitespace-split tokens when no brackets are used. */
export function parseMessageIds(header: string | null | undefined): string[] {
	if (!header) return [];
	const bracketed = [...header.matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]);
	if (bracketed.length > 0) return bracketed;
	return header
		.split(/[\s,]+/)
		.map((s) => s.trim())
		.filter((s) => s.includes('@'));
}

export function firstMessageId(header: string | null | undefined): string | null {
	return parseMessageIds(header)[0] ?? null;
}

export function formatMessageIds(ids: string[]): string {
	return ids.map((id) => `<${id}>`).join(' ');
}

/** `Re: ` + subject, without stacking prefixes (`Re: Re:`, `RE:`, `Re[2]:`). */
export function replySubject(subject: string): string {
	const trimmed = subject.trim();
	if (/^re(\[\d+\])?\s*:/i.test(trimmed)) return trimmed.replace(/^re(\[\d+\])?\s*:\s*/i, 'Re: ');
	return `Re: ${trimmed}`;
}

export function domainOf(address: string): string {
	return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}
