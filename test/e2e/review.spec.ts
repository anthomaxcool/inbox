import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { CSP } from '../../src/app/lib/server/headers';

const THREAD = 'e2ethread00000000000000000';
const jwt = () => readFileSync('.e2e-state/jwt.txt', 'utf8');

test('without an Access JWT the app refuses', async ({ request }) => {
	const res = await request.get(`/t/${THREAD}/review`);
	expect(res.status()).toBe(401);
	expect(res.headers()['content-security-policy']).toBe(CSP);
});

test('every response carries the §8.11 headers', async ({ request }) => {
	for (const path of [`/t/${THREAD}/review`, `/api/threads/${THREAD}`, '/review.js']) {
		const res = await request.get(path, { headers: { 'Cf-Access-Jwt-Assertion': jwt() } });
		const h = res.headers();
		expect(h['content-security-policy'], path).toBe(CSP);
		expect(h['x-robots-tag'], path).toBe('noindex');
		expect(h['referrer-policy'], path).toBe('no-referrer');
	}
});

test('screen 4: save an owner edit, send, and see the outbound message', async ({ browser }) => {
	const context = await browser.newContext({ extraHTTPHeaders: { 'Cf-Access-Jwt-Assertion': jwt() } });
	const page = await context.newPage();
	const dialogs: string[] = [];
	page.on('dialog', (d) => {
		dialogs.push(d.message());
		void d.dismiss();
	});
	await page.goto(`/t/${THREAD}/review`);

	await expect(page.getByTestId('to')).toHaveText('customer@example.org');
	await expect(page.getByTestId('from')).toHaveText('inbox-test@example.com');
	await expect(page.getByTestId('subject')).toHaveText('Re: Where is my order?');
	await expect(page.getByTestId('revision')).toHaveText('Revision 1 by agent:support-agent');
	// Mail content renders as text: the script tag shows up literally and never runs.
	await expect(page.locator('article pre').first()).toContainText('<script>alert(1)</script>');

	await page.locator('#body').fill('Hello, your order shipped yesterday. Tracking: 123.');
	await page.locator('#save').click();
	await expect(page.locator('#status')).toContainText('Saved as revision 2');

	await page.getByRole('button', { name: 'Send to customer@example.org' }).click();
	await page.waitForLoadState('load');
	await expect(page.locator('article[data-direction="out"] pre')).toHaveText('Hello, your order shipped yesterday. Tracking: 123.');
	await expect(page.getByText('No draft on this thread.')).toBeVisible();
	expect(dialogs).toEqual([]);
	await context.close();
});
