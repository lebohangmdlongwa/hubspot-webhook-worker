import { createClient } from '@supabase/supabase-js';

export interface Env {
	HUBSPOT_CLIENT_ID: string;
	HUBSPOT_CLIENT_SECRET: string;
	WIX_CLIENT_ID: string;
	WIX_CLIENT_SECRET: string;
	SUPABASE_URL: string;
	SUPABASE_SERVICE_ROLE_KEY: string;
	// Cloudflare Queue — each sync page (Phase 1 or Phase 2) is processed as an
	// independent queue message with its own CPU budget and wall-clock limit.
	// Create the queue first: `npx wrangler queues create hubspot-sync-queue`
	SYNC_QUEUE: Queue<{ jobId: string }>;
}

const WIX_CONTACTS_API = 'https://www.wixapis.com/contacts/v4/contacts';
const WIX_EXTENDED_FIELDS_API = 'https://www.wixapis.com/contacts/v4/extended-fields';

function getSupabase(env: Env) {
	return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}

// Per-instance token cache — keyed by instanceId so each installed site gets its own scoped token.
const wixTokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getWixAccessToken(env: Env, instanceId: string): Promise<string> {
	const cached = wixTokenCache.get(instanceId);
	if (cached && Date.now() < cached.expiresAt - 60_000) return cached.token;

	const res = await fetch('https://www.wixapis.com/oauth2/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			grant_type: 'client_credentials',
			client_id: env.WIX_CLIENT_ID,
			client_secret: env.WIX_CLIENT_SECRET,
			instance_id: instanceId,
		}),
	});
	if (!res.ok) throw new Error(`Wix token exchange failed: ${res.status} ${await res.text()}`);
	const data = (await res.json()) as { access_token?: string; expires_in?: number };
	const token = data.access_token ?? '';
	if (!token) throw new Error('Wix token exchange returned no access_token');
	wixTokenCache.set(instanceId, { token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 });
	return token;
}

async function wixApiHeaders(env: Env, instanceId: string, siteId: string): Promise<Record<string, string>> {
	const token = await getWixAccessToken(env, instanceId);
	return {
		Authorization: `Bearer ${token}`,
		'wix-site-id': siteId,
		'Content-Type': 'application/json',
	};
}

async function wixGetContact(env: Env, instanceId: string, siteId: string, contactId: string) {
	const res = await fetch(`${WIX_CONTACTS_API}/${contactId}`, {
		headers: await wixApiHeaders(env, instanceId, siteId),
	});
	if (!res.ok) throw new Error(`wixGetContact ${res.status}: ${await res.text()}`);
	const { contact } = (await res.json()) as {
		contact: { id: string; revision: number; info: Record<string, unknown> };
	};
	return contact;
}

async function wixUpdateContact(
	env: Env,
	instanceId: string,
	siteId: string,
	contactId: string,
	revision: number,
	info: Record<string, unknown>,
): Promise<void> {
	const headers = await wixApiHeaders(env, instanceId, siteId);
	const res = await fetch(`${WIX_CONTACTS_API}/${contactId}`, {
		method: 'PATCH',
		headers,
		body: JSON.stringify({ revision, info }),
	});
	if (res.status === 409) {
		const errText = await res.text();
		let errBody: any = {};
		try {
			errBody = JSON.parse(errText);
		} catch {}
		if (errBody?.details?.applicationError?.data?.duplicatePhone) {
			// Wix enforces unique primary phone numbers — another contact owns this phone.
			// Retry without the phones field so other fields (name, email, etc.) still update.
			const { phones: _p, ...infoNoPhone } = info as any;
			const retry = await fetch(`${WIX_CONTACTS_API}/${contactId}`, {
				method: 'PATCH',
				headers,
				body: JSON.stringify({ revision, info: infoNoPhone }),
			});
			if (!retry.ok) throw new Error(`wixUpdateContact retry ${retry.status}: ${await retry.text()}`);
			return;
		}
		// Assume INVALID_REVISION — re-fetch and retry with the live revision.
		const fresh = await wixGetContact(env, instanceId, siteId, contactId);
		const retry = await fetch(`${WIX_CONTACTS_API}/${contactId}`, {
			method: 'PATCH',
			headers,
			body: JSON.stringify({ revision: fresh.revision, info }),
		});
		if (!retry.ok) throw new Error(`wixUpdateContact retry ${retry.status}: ${await retry.text()}`);
		return;
	}
	if (!res.ok) throw new Error(`wixUpdateContact ${res.status}: ${await res.text()}`);
}

async function wixCreateContact(env: Env, instanceId: string, siteId: string, info: Record<string, unknown>): Promise<string | null> {
	const res = await fetch(WIX_CONTACTS_API, {
		method: 'POST',
		headers: await wixApiHeaders(env, instanceId, siteId),
		body: JSON.stringify({ info }),
	});
	if (res.status === 409) {
		const body = (await res.json()) as {
			details?: { applicationError?: { data?: { duplicateContactId?: string } } };
		};
		const existingId = body?.details?.applicationError?.data?.duplicateContactId;
		if (!existingId) throw new Error('409 but no duplicateContactId');
		const existing = await wixGetContact(env, instanceId, siteId, existingId);
		await wixUpdateContact(env, instanceId, siteId, existingId, existing.revision, info);
		return existingId;
	}
	if (!res.ok) throw new Error(`wixCreateContact ${res.status}: ${await res.text()}`);
	const data = (await res.json()) as { contact?: { id?: string } };
	return data.contact?.id ?? null;
}

async function getHubSpotToken(env: Env, instanceId: string): Promise<string> {
	const sb = getSupabase(env);
	const { data, error } = await sb
		.from('hubspot_tokens')
		.select('access_token, refresh_token, expires_at')
		.eq('instance_id', instanceId)
		.single();

	if (error || !data) throw new Error(`No HubSpot token for ${instanceId}`);
	if (Date.now() < data.expires_at - 5 * 60 * 1000) return data.access_token;

	const params = new URLSearchParams({
		grant_type: 'refresh_token',
		client_id: env.HUBSPOT_CLIENT_ID,
		client_secret: env.HUBSPOT_CLIENT_SECRET,
		refresh_token: data.refresh_token,
	});
	const res = await fetch('https://api.hubspot.com/oauth/v1/token', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: params.toString(),
	});
	if (!res.ok) throw new Error(`HubSpot refresh failed: ${res.status}`);
	const tokens = (await res.json()) as {
		access_token: string;
		refresh_token: string;
		expires_in: number;
	};
	await sb
		.from('hubspot_tokens')
		.update({
			access_token: tokens.access_token,
			refresh_token: tokens.refresh_token,
			expires_at: Date.now() + tokens.expires_in * 1000,
		})
		.eq('instance_id', instanceId);
	return tokens.access_token;
}

async function hsGetContact(hsToken: string, hsId: string, extraProps: string[] = []): Promise<{ properties: Record<string, string> }> {
	const base = [
		'firstname',
		'lastname',
		'email',
		'phone',
		'company',
		'jobtitle',
		'city',
		'country',
		'zip',
		'wix_sync_source',
		'wix_sync_timestamp',
		'wix_contact_id',
	];
	const all = [...new Set([...base, ...extraProps])];
	const res = await fetch(`https://api.hubapi.com/crm/v3/objects/contacts/${hsId}?properties=${all.join(',')}`, {
		headers: { Authorization: `Bearer ${hsToken}` },
	});
	if (!res.ok) throw new Error(`hsGetContact ${res.status}`);
	return res.json() as Promise<{ properties: Record<string, string> }>;
}

type FieldMapping = {
	wixField: string;
	hubspotProp: string;
	direction: string;
	transform?: string;
};

function applyTransform(value: string, transform?: string): string {
	if (transform === 'lowercase') return value.toLowerCase();
	if (transform === 'trim') return value.trim();
	return value;
}

async function getFieldMappings(env: Env, instanceId: string): Promise<FieldMapping[]> {
	const { data } = await getSupabase(env).from('contact_field_mappings').select('mappings').eq('instance_id', instanceId).single();
	const saved: FieldMapping[] = data?.mappings ?? [];
	const defaults: FieldMapping[] = [
		{ wixField: 'info.name.first', hubspotProp: 'firstname', direction: 'bidirectional' },
		{ wixField: 'info.name.last', hubspotProp: 'lastname', direction: 'bidirectional' },
		{ wixField: 'info.emails[0].email', hubspotProp: 'email', direction: 'bidirectional' },
		{ wixField: 'info.phones[0].phone', hubspotProp: 'phone', direction: 'bidirectional' },
		{ wixField: 'info.company.name', hubspotProp: 'company', direction: 'bidirectional' },
	];
	return saved.length ? saved : defaults;
}

// Per-isolate cache: "siteId:baseKey" → resolved Wix extended field key
const extFieldKeyCache = new Map<string, string>();

async function resolveExtendedFieldKey(env: Env, instanceId: string, siteId: string, baseKey: string): Promise<string> {
	const cacheKey = `${siteId}:${baseKey}`;
	if (extFieldKeyCache.has(cacheKey)) return extFieldKeyCache.get(cacheKey)!;
	try {
		const res = await fetch(WIX_EXTENDED_FIELDS_API, { headers: await wixApiHeaders(env, instanceId, siteId) });
		if (!res.ok) return baseKey;
		const data = (await res.json()) as { fields?: { key: string }[] };
		for (const field of data.fields ?? []) {
			const k = field.key;
			const dashIdx = k.lastIndexOf('-');
			if (dashIdx > 0 && k.length - dashIdx - 1 >= 20 && k.slice(0, dashIdx) === baseKey) {
				extFieldKeyCache.set(cacheKey, k);
				return k;
			}
		}
	} catch {
		/* fall back to baseKey */
	}
	return baseKey;
}

async function buildWixInfo(
	env: Env,
	instanceId: string,
	siteId: string,
	hsProperties: Record<string, string>,
	mappings: FieldMapping[],
): Promise<Record<string, unknown>> {
	const applicable = mappings.filter((m) => m.direction === 'hubspot_to_wix' || m.direction === 'bidirectional');
	const info: Record<string, unknown> = {};
	const extItems: Record<string, string> = {};

	for (const m of applicable) {
		const raw = hsProperties[m.hubspotProp];
		if (!raw) continue;
		const value = applyTransform(raw, m.transform);

		if (m.wixField.startsWith('extendedFields.')) {
			const baseKey = m.wixField.slice('extendedFields.'.length);
			const actualKey = await resolveExtendedFieldKey(env, instanceId, siteId, baseKey);
			extItems[actualKey] = value;
			continue;
		}

		switch (m.wixField) {
			case 'info.name.first':
				(info.name as any) ??= {};
				(info.name as any).first = value;
				break;
			case 'info.name.last':
				(info.name as any) ??= {};
				(info.name as any).last = value;
				break;
			case 'info.emails[0].email':
				info.emails = { items: [{ email: value, tag: 'MAIN' }] };
				break;
			case 'info.phones[0].phone':
				info.phones = { items: [{ phone: value, tag: 'MAIN' }] };
				break;
			case 'info.company.name':
				info.company = value;
				break;
			case 'info.jobTitle':
				info.jobTitle = value;
				break;
			case 'info.addresses[0].addressLine':
				if (!info.addresses) info.addresses = { items: [{ tag: 'HOME', address: {} }] };
				(info.addresses as any).items[0].address.addressLine = value;
				break;
			case 'info.addresses[0].city':
				if (!info.addresses) info.addresses = { items: [{ tag: 'HOME', address: {} }] };
				(info.addresses as any).items[0].address.city = value;
				break;
			case 'info.addresses[0].country':
				if (!info.addresses) info.addresses = { items: [{ tag: 'HOME', address: {} }] };
				(info.addresses as any).items[0].address.country = value;
				break;
			case 'info.addresses[0].postalCode':
				if (!info.addresses) info.addresses = { items: [{ tag: 'HOME', address: {} }] };
				(info.addresses as any).items[0].address.postalCode = value;
				break;
		}
	}

	if (Object.keys(extItems).length) {
		info.extendedFields = { items: extItems };
	}

	return info;
}

// ── On-demand full sync (cron-driven) ────────────────────────────

function getWixFieldValue(contact: any, wixField: string): string | null {
	const path = wixField
		.replace('info.', '')
		.replace(/\[(\d+)\]/g, '.$1')
		.split('.');
	let val: any = contact.info ?? contact;
	for (const key of path) {
		if (val == null) return null;
		// Wix REST API wraps list fields in { items: [...] } — unwrap when the key is a numeric index
		if (val?.items != null && /^\d+$/.test(key)) {
			val = val.items[parseInt(key, 10)];
		} else {
			val = val[key];
		}
	}
	if (val == null || typeof val === 'object') return null;
	return String(val).trim() || null;
}

function buildInfoFromHsContact(hsContact: { properties: Record<string, string> }, hsToWixMaps: FieldMapping[]): Record<string, unknown> {
	const info: Record<string, unknown> = {};
	for (const m of hsToWixMaps) {
		const raw = hsContact.properties[m.hubspotProp];
		if (raw === null || raw === undefined || typeof raw === 'object') continue;
		const coerced = String(raw).trim();
		if (!coerced) continue;
		const value = applyTransform(coerced, m.transform);
		const parts = m.wixField
			.replace('info.', '')
			.replace(/\[(\d+)\]/g, '.$1')
			.split('.');
		if (parts[0] === 'name') {
			(info.name as any) ??= {};
			(info.name as any)[parts[1]] = value;
		} else if (parts[0] === 'emails') {
			info.emails = { items: [{ email: value, tag: 'MAIN' }] };
		} else if (parts[0] === 'phones') {
			info.phones = { items: [{ phone: value, tag: 'MAIN' }] };
		} else if (parts[0] === 'company') {
			info.company = value;
		} else if (parts[0] === 'jobTitle') {
			info.jobTitle = value;
		} else if (parts[0] === 'addresses') {
			const field = parts[2];
			if (field) {
				if (field === 'country' && !/^[A-Za-z]{2}$/.test(value)) continue;
				if (!info.addresses) info.addresses = { items: [{ tag: 'HOME', address: {} }] };
				((info.addresses as any).items[0].address as Record<string, string>)[field] = value;
			}
		}
	}
	return info;
}

// Reads HS token (refreshing if needed) + site_id in one Supabase query.
async function getHubSpotConfig(env: Env, instanceId: string): Promise<{ hsToken: string; siteId: string }> {
	const sb = getSupabase(env);
	const { data } = await sb
		.from('hubspot_tokens')
		.select('access_token, refresh_token, expires_at, site_id')
		.eq('instance_id', instanceId)
		.single();
	if (!data) throw new Error(`No HubSpot token for ${instanceId}`);

	let token: string = data.access_token;
	if (Date.now() >= (data.expires_at as number) - 5 * 60 * 1000) {
		const params = new URLSearchParams({
			grant_type: 'refresh_token',
			client_id: env.HUBSPOT_CLIENT_ID,
			client_secret: env.HUBSPOT_CLIENT_SECRET,
			refresh_token: data.refresh_token,
		});
		const res = await fetch('https://api.hubapi.com/oauth/v1/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: params.toString(),
		});
		if (!res.ok) throw new Error(`HubSpot token refresh ${res.status}`);
		const tokens = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
		await sb
			.from('hubspot_tokens')
			.update({
				access_token: tokens.access_token,
				refresh_token: tokens.refresh_token,
				expires_at: Date.now() + tokens.expires_in * 1000,
			})
			.eq('instance_id', instanceId);
		token = tokens.access_token;
	}

	return { hsToken: token, siteId: (data as any).site_id ?? instanceId };
}

const PHASE1_PAGE_SIZE = 100;
const HS_BATCH_SIZE = 100;
const HS_PAGE_SIZE = 25;

async function processPhase1Tick(env: Env, supabase: any, job: any): Promise<void> {
	const syncRunId = crypto.randomUUID();
	console.log('[sync-worker] Phase1: tick start', { jobId: job.id, cursor: job.phase1_cursor ?? 'start' });
	await supabase.from('sync_jobs').update({ status: 'running_phase1', updated_at: new Date().toISOString() }).eq('id', job.id);

	const wixToken = await getWixAccessToken(env, job.instance_id);
	const { hsToken } = await getHubSpotConfig(env, job.instance_id);
	const mappings = await getFieldMappings(env, job.instance_id);
	const wixToHsMaps = mappings.filter((m) => m.direction === 'wix_to_hubspot' || m.direction === 'bidirectional');

	if (wixToHsMaps.length === 0) {
		console.log('[sync-worker] Phase1: no wix_to_hubspot mappings — skipping to Phase 2', { jobId: job.id });
		await supabase
			.from('sync_jobs')
			.update({ phase1_done: true, phase1_cursor: null, status: 'running_phase2', updated_at: new Date().toISOString() })
			.eq('id', job.id);
		return;
	}

	const res = await fetch('https://www.wixapis.com/contacts/v4/contacts/query', {
		method: 'POST',
		headers: { Authorization: `Bearer ${wixToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({
			cursorPaging: {
				limit: PHASE1_PAGE_SIZE,
				...(job.phase1_cursor ? { cursor: job.phase1_cursor } : {}),
			},
		}),
	});
	if (!res.ok) throw new Error(`Wix contacts query ${res.status}: ${await res.text()}`);

	const { contacts, metadata } = (await res.json()) as {
		contacts: any[];
		metadata?: { cursors?: { next?: string } };
	};

	const inputs: { properties: Record<string, string> }[] = [];
	const wixIds: string[] = [];
	const syncLogBatch: any[] = [];
	// Shared stamp for this tick — webhook handler checks startsWith('wix_sync_') + within 60s.
	const syncSourceStamp = `wix_sync_${Date.now()}`;

	for (const contact of contacts) {
		const props: Record<string, string> = {};
		for (const m of wixToHsMaps) {
			const value = getWixFieldValue(contact, m.wixField);
			if (value) props[m.hubspotProp] = value;
		}

		if (!props['email']) {
			syncLogBatch.push({
				instance_id: job.instance_id,
				direction: 'wix_to_hubspot',
				entity_type: 'contact',
				wix_id: contact.id,
				hubspot_id: null,
				status: 'skipped',
				skip_reason: 'no_email',
				error_message: null,
				sync_id: syncRunId,
			});
			continue;
		}

		props['wix_contact_id'] = contact.id;
		// Mark as own-write so the HubSpot webhook handler skips these changes
		// and doesn't update the Wix contact (which would bump its revision and
		// cause INVALID_REVISION failures when Phase 2 PATCHes the same contacts).
		props['wix_sync_source'] = syncSourceStamp;
		inputs.push({ properties: props });
		wixIds.push(contact.id);
	}

	if (inputs.length > 0) {
		for (let i = 0; i < inputs.length; i += HS_BATCH_SIZE) {
			const batch = inputs.slice(i, i + HS_BATCH_SIZE);
			const batchWixIds = wixIds.slice(i, i + HS_BATCH_SIZE);
			// HubSpot batch upsert: idProperty must be per-input (not top-level).
			// id = the value of idProperty that HubSpot matches on; email is the unique key.
			const hsRes = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/batch/upsert', {
				method: 'POST',
				headers: { Authorization: `Bearer ${hsToken}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({
					inputs: batch.map(({ properties }) => ({
						idProperty: 'email',
						id: properties['email'],
						properties,
					})),
				}),
			});
			const batchStatus = hsRes.ok ? 'success' : 'error';
			const batchError = hsRes.ok ? null : await hsRes.text();
			if (!hsRes.ok) console.error('[sync-worker] Phase 1 batch upsert error', { status: hsRes.status, err: batchError });
			for (const wixId of batchWixIds) {
				syncLogBatch.push({
					instance_id: job.instance_id,
					direction: 'wix_to_hubspot',
					entity_type: 'contact',
					wix_id: wixId,
					hubspot_id: null,
					status: batchStatus,
					skip_reason: null,
					error_message: batchError,
					sync_id: syncRunId,
				});
			}
		}
	}

	if (syncLogBatch.length > 0) await supabase.from('sync_log').insert(syncLogBatch);

	const nextCursor = metadata?.cursors?.next;
	const stats = {
		...(job.stats ?? {}),
		phase1Processed: ((job.stats as any)?.phase1Processed ?? 0) + contacts.length,
	};

	if (nextCursor) {
		console.log('[sync-worker] Phase1: tick done — more pages remain', { jobId: job.id, processed: contacts.length, nextCursor });
		await supabase.from('sync_jobs').update({ phase1_cursor: nextCursor, stats, updated_at: new Date().toISOString() }).eq('id', job.id);
	} else {
		console.log('[sync-worker] Phase1: all pages done — marking phase1_done', {
			jobId: job.id,
			processed: contacts.length,
			totalStats: stats,
		});
		await supabase
			.from('sync_jobs')
			.update({ phase1_done: true, phase1_cursor: null, status: 'running_phase2', stats, updated_at: new Date().toISOString() })
			.eq('id', job.id);
	}
}

async function processPhase2Tick(env: Env, supabase: any, job: any): Promise<void> {
	const syncRunId = crypto.randomUUID();
	console.log('[sync-worker] Phase2: tick start', { jobId: job.id, cursor: job.phase2_cursor ?? 'start' });
	await supabase.from('sync_jobs').update({ status: 'running_phase2', updated_at: new Date().toISOString() }).eq('id', job.id);

	const wixToken = await getWixAccessToken(env, job.instance_id);
	const { hsToken } = await getHubSpotConfig(env, job.instance_id);
	const mappings = await getFieldMappings(env, job.instance_id);
	const hsToWixMaps = mappings.filter((m) => m.direction === 'hubspot_to_wix' || m.direction === 'bidirectional');

	if (hsToWixMaps.length === 0) {
		console.log('[sync-worker] Phase2: no hubspot_to_wix mappings — marking done', { jobId: job.id });
		await supabase
			.from('sync_jobs')
			.update({ phase2_done: true, phase2_cursor: null, status: 'done', updated_at: new Date().toISOString() })
			.eq('id', job.id);
		return;
	}

	const extraProps = hsToWixMaps.map((m) => m.hubspotProp).join(',');
	const hsUrl = new URL('https://api.hubapi.com/crm/v3/objects/contacts');
	hsUrl.searchParams.set('limit', String(HS_PAGE_SIZE));
	hsUrl.searchParams.set('properties', `email,firstname,lastname,phone,wix_contact_id,${extraProps}`);
	if (job.phase2_cursor) hsUrl.searchParams.set('after', job.phase2_cursor);

	const hsRes = await fetch(hsUrl.toString(), { headers: { Authorization: `Bearer ${hsToken}` } });
	if (!hsRes.ok) throw new Error(`HubSpot contacts fetch ${hsRes.status}: ${await hsRes.text()}`);

	const { results: hsContacts, paging } = (await hsRes.json()) as {
		results: any[];
		paging?: { next?: { after?: string } };
	};

	const hsIds = hsContacts.map((c: any) => c.id);
	const knownWixIds = hsContacts
		.map((c: any) => (c.properties['wix_contact_id'] as string | undefined)?.trim())
		.filter((id): id is string => !!id);

	let idMapQuery = supabase.from('contact_id_map').select('wix_id, hubspot_id').eq('instance_id', job.instance_id);

	if (knownWixIds.length > 0) {
		idMapQuery = idMapQuery.or(`hubspot_id.in.(${hsIds.join(',')}),wix_id.in.(${knownWixIds.join(',')})`);
	} else {
		idMapQuery = idMapQuery.in('hubspot_id', hsIds);
	}

	const { data: idMapRows } = await idMapQuery;

	const idMapByHsId = new Map<string, string>(
		(idMapRows ?? []).filter((r: any) => hsIds.includes(r.hubspot_id)).map((r: any) => [r.hubspot_id as string, r.wix_id as string]),
	);
	// Covers the full wix_id space: includes rows where the claiming HS contact
	// may be on a completely different page (not in hsIds).
	const idMapByWixId = new Map<string, string>((idMapRows ?? []).map((r: any) => [r.wix_id as string, r.hubspot_id as string]));

	// Bulk-prefetch Wix revisions: 1 fetch replaces N individual GETs
	const prefetchIds: string[] = [];
	for (const c of hsContacts) {
		const wixId = idMapByHsId.get(c.id) ?? (c.properties['wix_contact_id'] as string | undefined)?.trim();
		if (wixId) prefetchIds.push(wixId);
	}

	const wixRevisionMap = new Map<string, string>();
	if (prefetchIds.length > 0) {
		const qRes = await fetch('https://www.wixapis.com/contacts/v4/contacts/query', {
			method: 'POST',
			headers: { Authorization: `Bearer ${wixToken}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({
				filter: { id: { $in: prefetchIds } },
				paging: { limit: prefetchIds.length },
			}),
		});
		if (!qRes.ok) throw new Error(`Wix bulk revision prefetch ${qRes.status}: ${await qRes.text()}`);
		const { contacts: found } = (await qRes.json()) as { contacts?: { id: string; revision?: string | number }[] };
		for (const fc of found ?? []) wixRevisionMap.set(fc.id, String(fc.revision ?? '1'));
	}

	let created = 0,
		updated = 0,
		skipped = 0;
	// All Supabase writes collected here and flushed AFTER the loop as single batch calls.
	const idMapBatch: any[] = [];
	const syncLogBatch: any[] = [];
	// Dedup map for HS contacts with no email AND no wix_contact_id (per-tick scope).
	const noEmailNoWixIdByName = new Map<string, string>();

	// Pre-stamp all existing idMap rows with last_sync_source='hubspot' BEFORE PATCHing Wix.
	// The Wix contact.updated event fires milliseconds after each PATCH — the bounce guard
	// in wix-contact-sync.ts checks last_synced_at; without pre-stamping the guard sees
	// stale data and lets the echo through, causing a redundant Wix→HubSpot write.
	const preStampWixIds = [...idMapByHsId.values()];
	if (preStampWixIds.length > 0) {
		const now = new Date().toISOString();
		await supabase
			.from('contact_id_map')
			.update({ last_sync_source: 'hubspot', last_synced_at: now })
			.eq('instance_id', job.instance_id)
			.in('wix_id', preStampWixIds);
	}

	for (const hsContact of hsContacts) {
		try {
			const info = buildInfoFromHsContact(hsContact, hsToWixMaps);
			if (Object.keys(info).length === 0) {
				skipped++;
				console.log('[sync-worker] Phase2: skipped contact', {
					hsId: hsContact.id,
					reason: 'no_mapped_values',
					email: hsContact.properties['email'] ?? null,
					firstname: hsContact.properties['firstname'] ?? null,
					jobId: job.id,
				});
				syncLogBatch.push({
					instance_id: job.instance_id,
					direction: 'hubspot_to_wix',
					entity_type: 'contact',
					wix_id: idMapByHsId.get(hsContact.id) ?? null,
					hubspot_id: hsContact.id,
					status: 'skipped',
					skip_reason: 'no_mapped_values',
					error_message: null,
					sync_id: syncRunId,
				});
				continue;
			}

			const existingWixId = idMapByHsId.get(hsContact.id);
			const knownWixId = (hsContact.properties['wix_contact_id'] as string | undefined)?.trim() || undefined;
			const hsEmail = (hsContact.properties['email'] as string | undefined)?.trim() || undefined;
			const hsFirst = ((hsContact.properties['firstname'] as string | undefined) ?? '').trim();
			const hsLast = ((hsContact.properties['lastname'] as string | undefined) ?? '').trim();
			const wixHeaders = { Authorization: `Bearer ${wixToken}`, 'Content-Type': 'application/json' };
			let resolvedWixId: string | null = null;

			const nameKey = !existingWixId && !hsEmail && !knownWixId && (hsFirst || hsLast) ? `${hsFirst}|${hsLast}`.toLowerCase() : null;

			if (existingWixId) {
				const revision = wixRevisionMap.get(existingWixId);
				if (revision == null) {
					// Stale id_map entry — Wix contact was deleted; recreate it
					const r = await fetch('https://www.wixapis.com/contacts/v4/contacts', {
						method: 'POST',
						headers: wixHeaders,
						body: JSON.stringify({ info }),
					});
					if (!r.ok) throw new Error(`Wix POST ${r.status}: ${await r.text()}`);
					const { contact: newC } = (await r.json()) as { contact?: { id?: string } };
					resolvedWixId = newC?.id ?? null;
					created++;
				} else {
					const r = await fetch(`https://www.wixapis.com/contacts/v4/contacts/${existingWixId}`, {
						method: 'PATCH',
						headers: wixHeaders,
						body: JSON.stringify({ revision, info }),
					});
					if (r.status === 409) {
						const errText409 = await r.text();
						let errBody409: any = {};
						try {
							errBody409 = JSON.parse(errText409);
						} catch {}
						if (errBody409?.details?.applicationError?.data?.duplicatePhone) {
							// Wix enforces unique primary phone numbers — retry without phones.
							const { phones: _p, ...infoNoPhone } = info as any;
							const retry = await fetch(`https://www.wixapis.com/contacts/v4/contacts/${existingWixId}`, {
								method: 'PATCH',
								headers: wixHeaders,
								body: JSON.stringify({ revision, info: infoNoPhone }),
							});
							if (!retry.ok) throw new Error(`Wix PATCH ${retry.status}: ${await retry.text()}`);
						} else {
							// Assume INVALID_REVISION — re-fetch and retry with the live revision.
							const freshGet = await fetch(`https://www.wixapis.com/contacts/v4/contacts/${existingWixId}`, { headers: wixHeaders });
							if (!freshGet.ok) throw new Error(`Wix GET fresh ${freshGet.status}: ${await freshGet.text()}`);
							const { contact: freshC } = (await freshGet.json()) as { contact?: { revision?: string | number } };
							const freshRevision = String(freshC?.revision ?? revision);
							const retry = await fetch(`https://www.wixapis.com/contacts/v4/contacts/${existingWixId}`, {
								method: 'PATCH',
								headers: wixHeaders,
								body: JSON.stringify({ revision: freshRevision, info }),
							});
							if (!retry.ok) throw new Error(`Wix PATCH ${retry.status}: ${await retry.text()}`);
						}
					} else if (!r.ok) {
						throw new Error(`Wix PATCH ${r.status}: ${await r.text()}`);
					}
					resolvedWixId = existingWixId;
					updated++;
				}
			} else if (knownWixId) {
				// Guard: if another HS contact already claimed this Wix ID in contact_id_map, skip
				const claimedByHsId = idMapByWixId.get(knownWixId);
				if (claimedByHsId && claimedByHsId !== hsContact.id) {
					skipped++;
					console.log('[sync-worker] Phase2: skipped contact', {
						hsId: hsContact.id,
						reason: 'wix_id_claimed_by_other_hs_contact',
						knownWixId,
						claimedByHsId,
						jobId: job.id,
					});
					syncLogBatch.push({
						instance_id: job.instance_id,
						direction: 'hubspot_to_wix',
						entity_type: 'contact',
						wix_id: knownWixId,
						hubspot_id: hsContact.id,
						status: 'skipped',
						skip_reason: 'wix_id_claimed_by_other_hs_contact',
						error_message: null,
						sync_id: syncRunId,
					});
					continue;
				}

				if (wixRevisionMap.has(knownWixId)) {
					// Fetch a fresh revision — the bulk-prefetched value may be stale
					// by the time we reach this contact in the loop (Wix internal updates
					// or delayed HubSpot webhooks can bump the revision between prefetch
					// and PATCH). This path is only taken by contacts NOT in contact_id_map,
					// so it affects at most a handful of contacts per tick (never all 25).
					const freshGet = await fetch(`https://www.wixapis.com/contacts/v4/contacts/${knownWixId}`, {
						headers: wixHeaders,
					});
					if (!freshGet.ok) throw new Error(`Wix GET ${freshGet.status}: ${await freshGet.text()}`);
					const { contact: freshC } = (await freshGet.json()) as { contact?: { revision?: string | number } };
					const revision = String(freshC?.revision ?? wixRevisionMap.get(knownWixId));
					const r = await fetch(`https://www.wixapis.com/contacts/v4/contacts/${knownWixId}`, {
						method: 'PATCH',
						headers: wixHeaders,
						body: JSON.stringify({ revision, info }),
					});
					if (!r.ok) throw new Error(`Wix PATCH ${r.status}: ${await r.text()}`);
					resolvedWixId = knownWixId;
					updated++;
				}
				// knownWixId not in wixRevisionMap → Wix contact deleted; fall through to CREATE
			}

			if (!resolvedWixId) {
				// Name-based dedup for no-email / no-wix_contact_id contacts
				if (nameKey && noEmailNoWixIdByName.has(nameKey)) {
					const dupeWixId = noEmailNoWixIdByName.get(nameKey)!;
					console.log('[sync-worker] Phase2: skipped contact', {
						hsId: hsContact.id,
						reason: 'hs_no_key_duplicate_mapped_to_existing',
						nameKey,
						dupeWixId,
						jobId: job.id,
					});
					idMapBatch.push({
						instance_id: job.instance_id,
						wix_id: dupeWixId,
						hubspot_id: hsContact.id,
						entity_type: 'contact',
						last_sync_source: 'hubspot',
					});
					syncLogBatch.push({
						instance_id: job.instance_id,
						direction: 'hubspot_to_wix',
						entity_type: 'contact',
						wix_id: dupeWixId,
						hubspot_id: hsContact.id,
						status: 'skipped',
						skip_reason: 'hs_no_key_duplicate_mapped_to_existing',
						error_message: null,
						sync_id: syncRunId,
					});
					skipped++;
					continue;
				}

				const r = await fetch('https://www.wixapis.com/contacts/v4/contacts', {
					method: 'POST',
					headers: wixHeaders,
					body: JSON.stringify({ info }),
				});

				if (!r.ok) {
					const errText = await r.text();

					if (r.status === 409) {
						try {
							const errBody = JSON.parse(errText) as { details?: { applicationError?: { data?: { duplicateContactId?: string } } } };
							const dupId = errBody?.details?.applicationError?.data?.duplicateContactId;
							if (dupId) {
								const getR = await fetch(`https://www.wixapis.com/contacts/v4/contacts/${dupId}`, { headers: wixHeaders });
								if (getR.ok) {
									const { contact: dup } = (await getR.json()) as { contact?: { revision?: string | number } };
									const patchR = await fetch(`https://www.wixapis.com/contacts/v4/contacts/${dupId}`, {
										method: 'PATCH',
										headers: wixHeaders,
										body: JSON.stringify({ revision: String(dup?.revision ?? '1'), info }),
									});
									if (!patchR.ok) throw new Error(`Wix PATCH dup ${patchR.status}: ${await patchR.text()}`);
									resolvedWixId = dupId;
									updated++;
								} else {
									skipped++;
								}
							} else {
								skipped++;
							}
						} catch {
							skipped++;
						}
					} else if (errText.includes('StringValue') && (info as any).phones) {
						// StringValue error from a bad phone number — retry without phones field
						const { phones: _p, ...infoNoPhone } = info as any;
						const retryR = await fetch('https://www.wixapis.com/contacts/v4/contacts', {
							method: 'POST',
							headers: wixHeaders,
							body: JSON.stringify({ info: infoNoPhone }),
						});
						if (!retryR.ok) throw new Error(`Wix POST retry ${retryR.status}: ${await retryR.text()}`);
						const { contact: newC } = (await retryR.json()) as { contact?: { id?: string } };
						resolvedWixId = newC?.id ?? null;
						if (resolvedWixId) {
							created++;
							if (nameKey) noEmailNoWixIdByName.set(nameKey, resolvedWixId);
						}
					} else {
						throw new Error(`Wix POST ${r.status}: ${errText}`);
					}
				} else {
					const { contact: newC } = (await r.json()) as { contact?: { id?: string } };
					resolvedWixId = newC?.id ?? null;
					if (resolvedWixId) {
						created++;
						if (nameKey) noEmailNoWixIdByName.set(nameKey, resolvedWixId);
					}
				}
			}

			if (resolvedWixId) {
				idMapBatch.push({
					instance_id: job.instance_id,
					wix_id: resolvedWixId,
					hubspot_id: hsContact.id,
					entity_type: 'contact',
					last_sync_source: 'hubspot',
					last_synced_at: new Date().toISOString(),
				});
				syncLogBatch.push({
					instance_id: job.instance_id,
					direction: 'hubspot_to_wix',
					entity_type: 'contact',
					wix_id: resolvedWixId,
					hubspot_id: hsContact.id,
					status: 'success',
					skip_reason: null,
					error_message: null,
					sync_id: syncRunId,
				});
			}
		} catch (err) {
			console.error('[sync-worker] Phase 2 contact error', { hsId: hsContact.id, err: String(err) });
			syncLogBatch.push({
				instance_id: job.instance_id,
				direction: 'hubspot_to_wix',
				entity_type: 'contact',
				wix_id: idMapByHsId.get(hsContact.id) ?? null,
				hubspot_id: hsContact.id,
				status: 'error',
				skip_reason: null,
				error_message: String(err),
				sync_id: syncRunId,
			});
			skipped++;
		}
	}

	// Flush all writes as batch calls after the loop
	// Deduplicate by conflict key before upserting — two HS contacts can legitimately
	// resolve to the same Wix ID in one tick (e.g. both have wix_contact_id set to the
	// same value). PostgreSQL's ON CONFLICT DO UPDATE rejects duplicate conflict keys
	// within the same batch with error 21000; deduplication prevents this.
	const dedupedIdMapBatch = Array.from(new Map(idMapBatch.map((r: any) => [`${r.instance_id}|${r.wix_id}|${r.entity_type}`, r])).values());
	console.log('[sync-worker] Phase2: loop done — flushing writes', {
		jobId: job.id,
		idMapBatch: idMapBatch.length,
		deduped: dedupedIdMapBatch.length,
		syncLogBatch: syncLogBatch.length,
		created,
		updated,
		skipped,
	});
	if (dedupedIdMapBatch.length > 0) {
		const { error: upsertErr } = await supabase
			.from('contact_id_map')
			.upsert(dedupedIdMapBatch, { onConflict: 'instance_id,wix_id,entity_type' });
		if (upsertErr) {
			console.error('[sync-worker] Phase2: contact_id_map upsert failed', {
				jobId: job.id,
				code: upsertErr.code,
				message: upsertErr.message,
				details: upsertErr.details,
				hint: upsertErr.hint,
				sampleRow: dedupedIdMapBatch[0],
			});
			throw new Error(`contact_id_map upsert failed: ${upsertErr.message} (code: ${upsertErr.code})`);
		}
		console.log('[sync-worker] Phase2: contact_id_map upserted', { count: dedupedIdMapBatch.length, jobId: job.id });
	}
	if (syncLogBatch.length > 0) {
		await supabase.from('sync_log').insert(syncLogBatch);
	}

	// Batch wix_sync_source stamps + wix_contact_id for newly created contacts (1 HubSpot call)
	if (idMapBatch.length > 0) {
		const stampTs = Date.now();
		const stampInputs = idMapBatch.map(({ hubspot_id, wix_id }: any) => {
			const isNew = !idMapByHsId.has(hubspot_id);
			return {
				id: hubspot_id,
				properties: {
					wix_sync_source: `wix_sync_${stampTs}`,
					...(isNew ? { wix_contact_id: wix_id } : {}),
				},
			};
		});
		try {
			await fetch('https://api.hubapi.com/crm/v3/objects/contacts/batch/update', {
				method: 'POST',
				headers: { Authorization: `Bearer ${hsToken}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ inputs: stampInputs }),
			});
		} catch (e) {
			// Non-fatal — next webhook event will go through isOwnWrite() check
			console.warn('[sync-worker] wix_sync_source batch stamp failed', String(e));
		}
	}

	const nextCursor = paging?.next?.after;
	const prevStats = (job.stats as any) ?? {};
	const stats = {
		...prevStats,
		phase2Created: (prevStats.phase2Created ?? 0) + created,
		phase2Updated: (prevStats.phase2Updated ?? 0) + updated,
		phase2Skipped: (prevStats.phase2Skipped ?? 0) + skipped,
	};

	if (nextCursor) {
		console.log('[sync-worker] Phase2: tick done — more pages remain', { jobId: job.id, nextCursor, stats });
		await supabase
			.from('sync_jobs')
			.update({ phase2_cursor: nextCursor, status: 'running_phase2', stats, updated_at: new Date().toISOString() })
			.eq('id', job.id);
	} else {
		console.log('[sync-worker] Phase2: all pages done — marking job done', { jobId: job.id, stats });
		await supabase
			.from('sync_jobs')
			.update({ phase2_done: true, phase2_cursor: null, status: 'done', stats, updated_at: new Date().toISOString() })
			.eq('id', job.id);
	}
}

// Fires the next sync tick as an independent HTTP request so it runs with its own
// Enqueues a sync tick message. The queue consumer processes it in a fully
// independent Worker invocation with its own CPU budget — no parent context sharing.
async function enqueueSyncTick(env: Env, jobId: string): Promise<void> {
	await env.SYNC_QUEUE.send({ jobId });
	console.log('[sync-worker] enqueueSyncTick: queued', { jobId });
}

// Processes exactly one tick (one Phase 1 page OR one Phase 2 page) for a job,
// then enqueues the next tick if more work remains.
async function runSyncTick(env: Env, jobId: string): Promise<void> {
	const supabase = getSupabase(env);
	const { data: job } = await supabase.from('sync_jobs').select('*').eq('id', jobId).maybeSingle();
	if (!job) {
		console.error('[sync-worker] runSyncTick: job not found', { jobId });
		return;
	}
	if (job.status === 'done' || job.status === 'failed') {
		console.log('[sync-worker] runSyncTick: job already terminal — skipping', { jobId, status: job.status });
		return;
	}

	console.log('[sync-worker] runSyncTick: processing', {
		jobId: job.id,
		status: job.status,
		phase1_done: job.phase1_done,
		phase2_done: job.phase2_done,
		cursor: job.phase2_cursor ?? null,
	});

	try {
		if (!job.phase1_done) {
			await processPhase1Tick(env, supabase, job);
			// Always enqueue next — processPhase1Tick sets phase1_done when complete,
			// so the next tick will naturally move to Phase 2.
			await enqueueSyncTick(env, jobId);
		} else if (!job.phase2_done) {
			await processPhase2Tick(env, supabase, job);
			// Re-fetch to check whether this was the last Phase 2 page
			const { data: updated } = await supabase.from('sync_jobs').select('phase2_done').eq('id', jobId).maybeSingle();
			if (!updated?.phase2_done) {
				await enqueueSyncTick(env, jobId);
			} else {
				console.log('[sync-worker] runSyncTick: Phase 2 complete', { jobId });
			}
		} else {
			await supabase.from('sync_jobs').update({ status: 'done', updated_at: new Date().toISOString() }).eq('id', job.id);
			console.log('[sync-worker] runSyncTick: job done', { jobId });
		}
	} catch (err) {
		console.error('[sync-worker] runSyncTick: error', { jobId, err: String(err) });
		await supabase
			.from('sync_jobs')
			.update({ status: 'failed', error: String(err), updated_at: new Date().toISOString() })
			.eq('id', jobId);
	}
}

// ── / — HubSpot CRM subscription webhook ─────────────────────────

async function handleWebhook(req: Request, env: Env): Promise<Response> {
	const rawBody = await req.text();

	let events: Array<{
		eventId: number;
		portalId: number;
		subscriptionType: string;
		objectId: number;
		changeSource?: string;
	}>;
	try {
		const parsed = JSON.parse(rawBody);
		events = Array.isArray(parsed) ? parsed : [parsed];
	} catch {
		return new Response('Invalid JSON', { status: 400 });
	}

	const sb = getSupabase(env);

	const contactEvents = events.filter((e) => e.subscriptionType?.startsWith('contact.'));
	console.log(
		'[webhook] events received',
		events.length,
		'contact:',
		contactEvents.length,
		JSON.stringify(
			events.map((e) => ({
				eventId: e.eventId,
				type: e.subscriptionType,
				objectId: e.objectId,
				portalId: e.portalId,
				changeSource: e.changeSource,
			})),
		),
	);
	if (!contactEvents.length) return Response.json({ ok: true });

	// ── Batch read 1: dedup check — one IN query instead of N inserts ────────
	const allEventIds = contactEvents.map((e) => e.eventId);
	const { data: alreadyDone } = await sb.from('processed_events').select('event_id').in('event_id', allEventIds);
	const processedSet = new Set((alreadyDone ?? []).map((r: any) => Number(r.event_id)));
	const freshEvents = contactEvents.filter((e) => !processedSet.has(e.eventId));
	for (const e of contactEvents.filter((e) => processedSet.has(e.eventId))) {
		console.log('[webhook] skip: already processed', e.eventId);
	}
	if (!freshEvents.length) return Response.json({ ok: true });

	// ── Batch read 2: token lookup for all portals at once ───────────────────
	const portalIds = [...new Set(freshEvents.map((e) => e.portalId))];
	const { data: tokenRows } = await sb.from('hubspot_tokens').select('portal_id, instance_id, site_id').in('portal_id', portalIds);
	const tokenByPortal = new Map((tokenRows ?? []).map((r: any) => [Number(r.portal_id), r]));

	const eventsWithInstall = freshEvents.filter((e) => tokenByPortal.has(e.portalId));
	for (const pid of [...new Set(freshEvents.filter((e) => !tokenByPortal.has(e.portalId)).map((e) => e.portalId))]) {
		console.warn('[webhook] no installation for portal', pid);
	}

	// ── Batch read 3: field mappings — one query per distinct instanceId ──────
	const instanceIds = [...new Set(eventsWithInstall.map((e) => tokenByPortal.get(e.portalId)!.instance_id))];
	const mappingsByInstance = new Map<string, FieldMapping[]>();
	await Promise.all(
		instanceIds.map(async (iid) => {
			mappingsByInstance.set(iid, await getFieldMappings(env, iid));
		}),
	);

	// Deduplicate by objectId — HubSpot batches many propertyChange events for the
	// same contact; we only need to fetch and update that contact once.
	const latestByObjectId = new Map<number, (typeof eventsWithInstall)[0]>();
	for (const e of eventsWithInstall) latestByObjectId.set(e.objectId, e);
	const deduped = [...latestByObjectId.values()];
	console.log('[webhook] unique contacts to process', deduped.length, '(from', eventsWithInstall.length, 'events)');

	// ── Batch read 4: idMap for all HubSpot contact IDs at once ─────────────
	const idMapByKey = new Map<string, { wix_id: string; hubspot_id: string; last_sync_source: string; last_synced_at: string }>();
	await Promise.all(
		instanceIds.map(async (iid) => {
			const hsIds = deduped.filter((e) => tokenByPortal.get(e.portalId)!.instance_id === iid).map((e) => String(e.objectId));
			if (!hsIds.length) return;
			const { data } = await sb
				.from('contact_id_map')
				.select('wix_id, hubspot_id, last_sync_source, last_synced_at')
				.eq('instance_id', iid)
				.in('hubspot_id', hsIds)
				.eq('entity_type', 'contact');
			for (const row of data ?? []) idMapByKey.set(`${iid}:${row.hubspot_id}`, row as any);
		}),
	);

	// ── Phase 2: fetch HubSpot contact data + apply bounce guards ────────────
	// One hsGetContact per unique contact (unavoidable), token cached per instanceId.
	const hsTokenCache2 = new Map<string, string>();

	type WorkItem = {
		event: (typeof deduped)[0];
		instanceId: string;
		siteId: string;
		mappings: FieldMapping[];
		syncId: string;
		hsProps: Record<string, string>;
		idMap: { wix_id: string; hubspot_id: string; last_sync_source: string; last_synced_at: string } | null;
	};
	const workItems: WorkItem[] = [];
	const syncLogBatch: any[] = [];
	const now = Date.now();

	for (const event of deduped) {
		const hsId = String(event.objectId);
		const tokenRow = tokenByPortal.get(event.portalId)!;
		const instanceId: string = tokenRow.instance_id;
		const siteId: string = tokenRow.site_id ?? instanceId;
		const mappings = mappingsByInstance.get(instanceId) ?? [];
		const syncId = crypto.randomUUID();
		const idMap = idMapByKey.get(`${instanceId}:${hsId}`) ?? null;

		try {
			if (event.subscriptionType === 'contact.deletion') {
				console.log('[webhook] contact deleted in HubSpot — removing sync records', hsId);
				await Promise.all([
					sb.from('contact_id_map').delete().eq('instance_id', instanceId).eq('hubspot_id', hsId).eq('entity_type', 'contact'),
					sb.from('sync_log').delete().eq('instance_id', instanceId).eq('hubspot_id', hsId),
				]);
				continue;
			}

			let hsToken = hsTokenCache2.get(instanceId);
			if (!hsToken) {
				hsToken = await getHubSpotToken(env, instanceId);
				hsTokenCache2.set(instanceId, hsToken);
			}

			const customHsProps = mappings.filter((m) => m.direction !== 'wix_to_hubspot').map((m) => m.hubspotProp);
			const contact = await hsGetContact(hsToken, hsId, customHsProps);
			const hsProps = contact.properties;

			console.log(
				'[webhook] processing',
				JSON.stringify({
					hsId,
					siteId,
					subscriptionType: event.subscriptionType,
					changeSource: event.changeSource,
					wix_sync_source: hsProps.wix_sync_source,
				}),
			);

			const syncTs = parseInt(hsProps.wix_sync_timestamp ?? '0', 10);
			if (hsProps.wix_sync_source?.startsWith('wix_sync_') && now - syncTs < 60_000) {
				console.log('[webhook] skip: own write within 60s', JSON.stringify({ hsId, syncTs }));
				continue;
			}
			if (idMap) {
				const lastSyncMs = new Date(idMap.last_synced_at).getTime();
				if (idMap.last_sync_source === 'wix' && now - lastSyncMs < 30_000) {
					console.log('[webhook] skip: db timestamp guard', hsId);
					continue;
				}
			}
			console.log('[webhook] idMap lookup', JSON.stringify({ found: !!idMap, wixId: idMap?.wix_id }));
			workItems.push({ event, instanceId, siteId, mappings, syncId, hsProps, idMap });
		} catch (err) {
			console.error('[webhook] event failed', event.eventId, String(err));
			syncLogBatch.push({
				instance_id: instanceId,
				direction: 'hubspot_to_wix',
				entity_type: 'contact',
				wix_id: null,
				hubspot_id: hsId,
				status: 'error',
				error_message: String(err),
				sync_id: null,
				synced_at: new Date().toISOString(),
			});
		}
	}

	// ── Phase 3: pre-stamp idMaps for contacts we'll update — one batch upsert ─
	// Stamping BEFORE the Wix API calls ensures wix-contact-sync sees
	// last_sync_source='hubspot' before the contact.updated event fires.
	const existingToUpdate = workItems.filter((w) => w.idMap);
	if (existingToUpdate.length) {
		await sb.from('contact_id_map').upsert(
			existingToUpdate.map((w) => ({
				instance_id: w.instanceId,
				wix_id: w.idMap!.wix_id,
				hubspot_id: String(w.event.objectId),
				entity_type: 'contact',
				last_sync_source: 'hubspot',
				last_sync_id: w.syncId,
				last_synced_at: new Date().toISOString(),
			})),
			{ onConflict: 'instance_id,wix_id,entity_type' },
		);
	}

	// Batch reverse-map lookup for contacts that have wix_contact_id set but no idMap
	const needsReverseCheck = workItems.filter((w) => !w.idMap && w.hsProps.wix_contact_id);
	const reverseMapByWixId = new Map<string, string>(); // wixId → hubspotId
	if (needsReverseCheck.length) {
		const wixIds = needsReverseCheck.map((w) => w.hsProps.wix_contact_id!);
		// Each instanceId may differ — group and query
		const reverseInstanceIds = [...new Set(needsReverseCheck.map((w) => w.instanceId))];
		await Promise.all(
			reverseInstanceIds.map(async (iid) => {
				const ids = needsReverseCheck.filter((w) => w.instanceId === iid).map((w) => w.hsProps.wix_contact_id!);
				const { data } = await sb
					.from('contact_id_map')
					.select('wix_id, hubspot_id')
					.eq('instance_id', iid)
					.in('wix_id', ids)
					.eq('entity_type', 'contact');
				for (const row of data ?? []) reverseMapByWixId.set(row.wix_id, row.hubspot_id);
			}),
		);
	}

	// ── Phase 4: Wix API calls (2 per contact — GET revision + PATCH/POST) ────
	const idMapNewBatch: any[] = [];

	for (const w of workItems) {
		const { event, instanceId, siteId, mappings, syncId, hsProps, idMap } = w;
		const hsId = String(event.objectId);

		try {
			if (idMap) {
				const wixContact = await wixGetContact(env, instanceId, siteId, idMap.wix_id);
				const info = await buildWixInfo(env, instanceId, siteId, hsProps, mappings);
				console.log('[webhook] built wix info', JSON.stringify({ keys: Object.keys(info) }));
				if (Object.keys(info).length) {
					await wixUpdateContact(env, instanceId, siteId, idMap.wix_id, wixContact.revision, info);
					console.log('[webhook] wix contact updated', idMap.wix_id);
				} else {
					console.log('[webhook] skip: no mapped fields to write', hsId);
				}
				syncLogBatch.push({
					instance_id: instanceId,
					direction: 'hubspot_to_wix',
					entity_type: 'contact',
					wix_id: idMap.wix_id,
					hubspot_id: hsId,
					status: 'success',
					sync_id: syncId,
					synced_at: new Date().toISOString(),
				});
			} else {
				const existingWixId = hsProps.wix_contact_id;
				if (existingWixId) {
					const ownerHsId = reverseMapByWixId.get(existingWixId);
					if (!ownerHsId) {
						console.log('[webhook] skip: sync link was manually removed', JSON.stringify({ existingWixId, hsId }));
						syncLogBatch.push({
							instance_id: instanceId,
							direction: 'hubspot_to_wix',
							entity_type: 'contact',
							wix_id: existingWixId,
							hubspot_id: hsId,
							status: 'skipped',
							sync_id: syncId,
							synced_at: new Date().toISOString(),
						});
						continue;
					}
					if (ownerHsId !== hsId) {
						console.log(
							'[webhook] skip: wix_contact_id claimed by another HS contact',
							JSON.stringify({ existingWixId, hsId, claimedBy: ownerHsId }),
						);
						syncLogBatch.push({
							instance_id: instanceId,
							direction: 'hubspot_to_wix',
							entity_type: 'contact',
							wix_id: existingWixId,
							hubspot_id: hsId,
							status: 'skipped',
							sync_id: syncId,
							synced_at: new Date().toISOString(),
						});
						continue;
					}
					console.log(
						'[webhook] HubSpot contact has wix_contact_id, updating original Wix contact',
						JSON.stringify({ existingWixId, hsId }),
					);
					await sb
						.from('contact_id_map')
						.upsert(
							{
								instance_id: instanceId,
								wix_id: existingWixId,
								hubspot_id: hsId,
								entity_type: 'contact',
								last_sync_source: 'hubspot',
								last_sync_id: syncId,
								last_synced_at: new Date().toISOString(),
							},
							{ onConflict: 'instance_id,wix_id,entity_type' },
						);
					const wixContact = await wixGetContact(env, instanceId, siteId, existingWixId);
					const info = await buildWixInfo(env, instanceId, siteId, hsProps, mappings);
					if (Object.keys(info).length) {
						await wixUpdateContact(env, instanceId, siteId, existingWixId, wixContact.revision, info);
					}
					syncLogBatch.push({
						instance_id: instanceId,
						direction: 'hubspot_to_wix',
						entity_type: 'contact',
						wix_id: existingWixId,
						hubspot_id: hsId,
						status: 'success',
						sync_id: syncId,
						synced_at: new Date().toISOString(),
					});
				} else if (hsProps.wix_sync_source?.startsWith('wix_sync_')) {
					console.log('[webhook] skip: Wix-origin contact without wix_contact_id', hsId);
				} else {
					const info = await buildWixInfo(env, instanceId, siteId, hsProps, mappings);
					console.log('[webhook] no idMap — create path, info keys:', JSON.stringify(Object.keys(info)));
					if (!Object.keys(info).length) {
						console.log('[webhook] skip: no mapped fields for new contact', hsId);
						continue;
					}
					const newWixId = await wixCreateContact(env, instanceId, siteId, info);
					console.log('[webhook] wix contact created', newWixId);
					if (!newWixId) continue;
					idMapNewBatch.push({
						instance_id: instanceId,
						wix_id: newWixId,
						hubspot_id: hsId,
						entity_type: 'contact',
						last_sync_source: 'hubspot',
						last_sync_id: syncId,
						last_synced_at: new Date().toISOString(),
					});
					syncLogBatch.push({
						instance_id: instanceId,
						direction: 'hubspot_to_wix',
						entity_type: 'contact',
						wix_id: newWixId,
						hubspot_id: hsId,
						status: 'success',
						sync_id: syncId,
						synced_at: new Date().toISOString(),
					});
				}
			}
		} catch (err) {
			console.error('[webhook] event failed', event.eventId, String(err));
			syncLogBatch.push({
				instance_id: instanceId,
				direction: 'hubspot_to_wix',
				entity_type: 'contact',
				wix_id: idMap?.wix_id ?? null,
				hubspot_id: hsId,
				status: 'error',
				error_message: String(err),
				sync_id: null,
				synced_at: new Date().toISOString(),
			});
		}
	}

	// ── Batch writes (3 subrequests max regardless of event count) ───────────
	await Promise.all([
		sb.from('processed_events').upsert(
			freshEvents.map((e) => ({ event_id: e.eventId, processed_at: new Date().toISOString() })),
			{ onConflict: 'event_id', ignoreDuplicates: true },
		),
		syncLogBatch.length ? sb.from('sync_log').insert(syncLogBatch) : null,
		idMapNewBatch.length ? sb.from('contact_id_map').upsert(idMapNewBatch, { onConflict: 'instance_id,wix_id,entity_type' }) : null,
	]);

	return Response.json({ ok: true });
}

// ── OAuth callback HTML ───────────────────────────────────────────

const OAUTH_CALLBACK_HTML = `<!DOCTYPE html>
<html>
  <head>
    <title>Connecting HubSpot…</title>
    <style>
      body {
        font-family: sans-serif;
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100vh;
        margin: 0;
        background: #f5f5f5;
        color: #333;
      }
    </style>
  </head>
  <body>
    <p>Connecting HubSpot… this window will close automatically.</p>
    <script>
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');
      const error = params.get('error');

      if (code && window.opener) {
        window.opener.postMessage({ type: 'hs-oauth-code', code }, '*');
        window.close();
      } else if (error) {
        document.querySelector('p').textContent =
          'HubSpot authorization failed: ' + error + '. You can close this window.';
      } else {
        document.querySelector('p').textContent =
          'Something went wrong. You can close this window.';
      }
    </script>
  </body>
</html>`;

// ── Entry point ───────────────────────────────────────────────────

export default {
	async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(req.url);

		if (req.method === 'GET' && url.pathname === '/hubspot-callback') {
			return new Response(OAUTH_CALLBACK_HTML, {
				headers: { 'Content-Type': 'text/html;charset=UTF-8' },
			});
		}

		if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

		// Immediately enqueue a sync job created by the Wix dashboard trigger.
		// The jobId is validated against Supabase before enqueueing — no additional
		// secret needed because UUIDs are unguessable and we verify existence.
		if (url.pathname === '/trigger-job') {
			try {
				const { jobId } = (await req.json()) as { jobId?: string };
				if (!jobId) return new Response('Missing jobId', { status: 400 });
				const supabase = getSupabase(env);
				const { data: job } = await supabase.from('sync_jobs').select('id, status').eq('id', jobId).maybeSingle();
				if (!job) return new Response('Job not found', { status: 404 });
				if (job.status !== 'pending') return new Response('Job already started', { status: 409 });
				await env.SYNC_QUEUE.send({ jobId });
				console.log('[sync-worker] trigger-job: enqueued', { jobId });
				return new Response('OK');
			} catch (err) {
				return new Response(String(err), { status: 500 });
			}
		}

		return handleWebhook(req, env);
	},

	// Queue consumer — each message is one sync tick (one Phase 1 or Phase 2 page).
	// max_batch_size=1 in wrangler.jsonc ensures each message gets its own invocation
	// with a full CPU budget, so no tick is squeezed into another tick's budget.
	async queue(batch: MessageBatch<{ jobId: string }>, env: Env): Promise<void> {
		for (const message of batch.messages) {
			const { jobId } = message.body;
			console.log('[sync-worker] queue: processing message', { jobId });
			await runSyncTick(env, jobId);
			message.ack();
		}
	},

	// Cron stall-recovery — runs every minute and re-queues any job that is pending
	// (just created, not yet picked up) or stalled (queue message was dropped).
	async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
		const supabase = getSupabase(env);
		const stalledBefore = new Date(Date.now() - 120_000).toISOString();
		const { data: job } = await supabase
			.from('sync_jobs')
			.select('id, status')
			.or(`status.eq.pending,and(status.like.running%,updated_at.lt.${stalledBefore})`)
			.order('created_at', { ascending: true })
			.limit(1)
			.maybeSingle();
		if (job) {
			console.log('[sync-worker] cron: re-queuing job', { jobId: job.id, status: job.status });
			await enqueueSyncTick(env, job.id);
		} else {
			console.log('[sync-worker] cron: no pending/stalled jobs');
		}
	},
} satisfies ExportedHandler<Env>;
