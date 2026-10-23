<script lang="ts">
	// Screen 4, bare (Phase 0). Every mail and draft field renders as text, never as HTML.
	let { data } = $props();
	const r = $derived(data.review);
</script>

<svelte:head>
	<title>Review reply</title>
	<script src="/review.js" defer></script>
</svelte:head>

<h1>Review and send</h1>

<dl>
	<dt>To</dt>
	<dd data-testid="to">{r.envelope.to}</dd>
	<dt>From</dt>
	<dd data-testid="from">{r.envelope.from}</dd>
	<dt>Subject</dt>
	<dd data-testid="subject">{r.envelope.subject}</dd>
</dl>

{#if r.draft}
	<form
		id="review"
		data-draft-id={r.draft.id}
		data-revision-id={r.draft.revisionId}
		data-status={r.draft.status}
		data-mailbox-matches={r.mailboxMatches ? 'yes' : 'no'}
	>
		<p data-testid="revision">
			Revision {r.draft.n} by {r.draft.author === 'owner' ? 'you' : r.draft.author}{r.draft.ownerLocked ? ' (edited by you)' : ''}
		</p>
		<label for="body">Reply</label>
		<textarea id="body" name="body" rows="14" cols="80">{r.draft.body}</textarea>
		<p>
			<button type="button" id="save">Save edit</button>
			<button type="button" id="send" disabled={r.draft.status !== 'open' || !r.mailboxMatches}>Send to {r.envelope.to}</button>
		</p>
		<p id="status" role="status" aria-live="polite"></p>
	</form>
{:else}
	<p>No draft on this thread.</p>
{/if}

<h2>Messages</h2>
{#each r.messages as m (m.id)}
	<article data-direction={m.direction}>
		<p>{m.direction === 'out' ? 'Sent to' : 'From'} {m.direction === 'out' ? r.envelope.to : m.from} · {m.date}</p>
		<pre>{m.text}</pre>
	</article>
{/each}
