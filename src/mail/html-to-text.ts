// HTML → plain text on ingest (plan §8.11). Nothing from an email is ever rendered as HTML.
// Regex-based on purpose: it has to stay well inside Workers Free's 10 ms CPU budget.

const NAMED: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	ndash: '–',
	mdash: '—',
	hellip: '…',
	rsquo: '’',
	lsquo: '‘',
	rdquo: '”',
	ldquo: '“',
	copy: '©',
	reg: '®',
	euro: '€',
	eacute: 'é',
	egrave: 'è',
	agrave: 'à',
	ccedil: 'ç',
	ecirc: 'ê'
};

function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
		if (code[0] === '#') {
			const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
			return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
		}
		return NAMED[code.toLowerCase()] ?? whole;
	});
}

export function htmlToText(html: string): string {
	let s = html;
	s = s.replace(/<!--[\s\S]*?-->/g, '');
	s = s.replace(/<(head|script|style|title|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, '');
	s = s.replace(/<a\b[^>]*\bhref\s*=\s*["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, href: string, inner: string) => {
		const label = inner.replace(/<[^>]*>/g, '').trim();
		if (!label || label === href || href.startsWith('mailto:') || href.startsWith('#')) return label || href;
		return `${label} (${href})`;
	});
	s = s.replace(/<br\s*\/?>/gi, '\n');
	s = s.replace(/<li\b[^>]*>/gi, '\n- ');
	s = s.replace(/<\/(p|div|tr|table|ul|ol|h[1-6]|blockquote|section|article|header|footer)\s*>/gi, '\n\n');
	s = s.replace(/<(p|div|tr|h[1-6]|blockquote)\b[^>]*>/gi, '\n');
	s = s.replace(/<\/t[dh]\s*>/gi, '\t');
	s = s.replace(/<[^>]*>/g, '');
	s = decodeEntities(s);
	s = s.replace(/[ \t\f\v ]+/g, ' ');
	s = s.replace(/ *\n */g, '\n');
	s = s.replace(/\n{3,}/g, '\n\n');
	return s.trim();
}
