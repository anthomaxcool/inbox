// Screen 4 behaviour. Self-hosted, no inline script (CSP script-src 'self').
// The idempotency key is minted when the page (or a new revision) loads, and reused on every retry of that Send.
(() => {
	const form = document.getElementById('review');
	if (!form) return;
	const textarea = document.getElementById('body');
	const save = document.getElementById('save');
	const send = document.getElementById('send');
	const status = document.getElementById('status');
	const draftId = form.dataset.draftId;
	let revisionId = form.dataset.revisionId;
	let savedBody = textarea.value;
	let idempotencyKey = crypto.randomUUID();

	const say = (text) => {
		status.textContent = text;
	};

	async function post(path, intent, body) {
		const res = await fetch(path, {
			method: 'POST',
			credentials: 'same-origin',
			headers: { 'Content-Type': 'application/json', 'X-Inbox-Intent': intent },
			body: JSON.stringify(body)
		});
		let data = {};
		try {
			data = await res.json();
		} catch {
			// empty or non-JSON body
		}
		return { status: res.status, data };
	}

	save.addEventListener('click', async () => {
		save.disabled = true;
		const { status: code, data } = await post(`/api/drafts/${draftId}/revisions`, 'save', { body: textarea.value });
		save.disabled = false;
		if (code === 200) {
			revisionId = data.revisionId;
			savedBody = textarea.value;
			idempotencyKey = crypto.randomUUID();
			say(`Saved as revision ${data.n}. Agents can no longer change this draft.`);
		} else {
			say(`Not saved (${data.error || code}).`);
		}
	});

	send.addEventListener('click', async () => {
		if (textarea.value !== savedBody) {
			say('Save your edit first. Send only sends a saved revision.');
			return;
		}
		send.disabled = true;
		say('Sending…');
		const { status: code, data } = await post(`/api/drafts/${draftId}/send`, 'send', { draftId, revisionId, idempotencyKey });
		if (data.status === 'sent') {
			say('Sent.');
			window.location.reload();
			return;
		}
		if (data.status === 'pending' || data.status === 'unknown') {
			say('Checking whether it was sent… Tap Send again to check.');
			send.disabled = false;
			return;
		}
		if (data.error === 'revision_changed') {
			say('The draft changed since you opened it. Reload to see the new version.');
			return;
		}
		say(`Not sent (${data.error || code}).`);
		if (data.status === 'failed') {
			// The draft is open again. A new tap is a new attempt.
			idempotencyKey = crypto.randomUUID();
			send.disabled = false;
		}
	});
})();
