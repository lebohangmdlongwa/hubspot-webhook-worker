import { createClient } from '@supabase/supabase-js';
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface Env {
	HUBSPOT_CLIENT_ID: string;
	HUBSPOT_CLIENT_SECRET: string;
	WIX_API_KEY: string;
	SUPABASE_URL: string;
	SUPABASE_SERVICE_ROLE_KEY: string;
}

const WIX_CONTACTS_API = 'https://www.wixapis.com/contacts/v4/contacts';
const WIX_EXTENDED_FIELDS_API = 'https://www.wixapis.com/contacts/v4/extended-fields';

function getSupabase(env: Env) {
	return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
}

function wixApiHeaders(env: Env, siteId: string): Record<string, string> {
	return {
		Authorization: env.WIX_API_KEY,
		'wix-site-id': siteId,
		'Content-Type': 'application/json',
	};
}

async function wixGetContact(env: Env, siteId: string, contactId: string) {
	const res = await fetch(`${WIX_CONTACTS_API}/${contactId}`, {
		headers: wixApiHeaders(env, siteId),
	});
	if (!res.ok) throw new Error(`wixGetContact ${res.status}: ${await res.text()}`);
	const { contact } = (await res.json()) as {
		contact: { id: string; revision: number; info: Record<string, unknown> };
	};
	return contact;
}

async function wixUpdateContact(env: Env, siteId: string, contactId: string, revision: number, info: Record<string, unknown>): Promise<void> {
	const headers = wixApiHeaders(env, siteId);
	const res = await fetch(`${WIX_CONTACTS_API}/${contactId}`, {
		method: 'PATCH',
		headers,
		body: JSON.stringify({ revision, info }),
	});
	if (res.status === 409) {
		const fresh = await wixGetContact(env, siteId, contactId);
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

async function wixCreateContact(env: Env, siteId: string, info: Record<string, unknown>): Promise<string | null> {
	const res = await fetch(WIX_CONTACTS_API, {
		method: 'POST',
		headers: wixApiHeaders(env, siteId),
		body: JSON.stringify({ info }),
	});
	if (res.status === 409) {
		const body = (await res.json()) as {
			details?: { applicationError?: { data?: { duplicateContactId?: string } } };
		};
		const existingId = body?.details?.applicationError?.data?.duplicateContactId;
		if (!existingId) throw new Error('409 but no duplicateContactId');
		const existing = await wixGetContact(env, siteId, existingId);
		await wixUpdateContact(env, siteId, existingId, existing.revision, info);
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
	const base = ['firstname', 'lastname', 'email', 'phone', 'company', 'jobtitle', 'city', 'country', 'zip', 'wix_sync_source', 'wix_sync_timestamp', 'wix_contact_id'];
	const all = [...new Set([...base, ...extraProps])];
	const res = await fetch(
		`https://api.hubapi.com/crm/v3/objects/contacts/${hsId}?properties=${all.join(',')}`,
		{ headers: { Authorization: `Bearer ${hsToken}` } },
	);
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

async function resolveExtendedFieldKey(env: Env, siteId: string, baseKey: string): Promise<string> {
	const cacheKey = `${siteId}:${baseKey}`;
	if (extFieldKeyCache.has(cacheKey)) return extFieldKeyCache.get(cacheKey)!;
	try {
		const res = await fetch(WIX_EXTENDED_FIELDS_API, { headers: wixApiHeaders(env, siteId) });
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
	} catch { /* fall back to baseKey */ }
	return baseKey;
}

async function buildWixInfo(env: Env, siteId: string, hsProperties: Record<string, string>, mappings: FieldMapping[]): Promise<Record<string, unknown>> {
	const applicable = mappings.filter((m) => m.direction === 'hubspot_to_wix' || m.direction === 'bidirectional');
	const info: Record<string, unknown> = {};
	const extItems: Record<string, string> = {};

	for (const m of applicable) {
		const raw = hsProperties[m.hubspotProp];
		if (!raw) continue;
		const value = applyTransform(raw, m.transform);

		if (m.wixField.startsWith('extendedFields.')) {
			const baseKey = m.wixField.slice('extendedFields.'.length);
			const actualKey = await resolveExtendedFieldKey(env, siteId, baseKey);
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
				info.company = { name: value };
				break;
			case 'info.jobTitle':
				info.jobTitle = value;
				break;
			case 'info.addresses[0].city':
				(info.addresses as any) ??= [{}];
				(info.addresses as any)[0].city = value;
				break;
			case 'info.addresses[0].country':
				(info.addresses as any) ??= [{}];
				(info.addresses as any)[0].country = value;
				break;
			case 'info.addresses[0].postalCode':
				(info.addresses as any) ??= [{}];
				(info.addresses as any)[0].postalCode = value;
				break;
		}
	}

	if (Object.keys(extItems).length) {
		info.extendedFields = { items: extItems };
	}

	return info;
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

	console.log('[webhook] events received', events.length, JSON.stringify(events.map(e => ({ eventId: e.eventId, type: e.subscriptionType, objectId: e.objectId, portalId: e.portalId, changeSource: e.changeSource }))));

	for (const event of events) {
		if (!event.subscriptionType?.startsWith('contact.')) {
			console.log('[webhook] skip non-contact event', event.subscriptionType);
			continue;
		}
		const hsId = String(event.objectId);

		const { error: insertErr } = await sb.from('processed_events').insert({ event_id: event.eventId, processed_at: new Date().toISOString() });
		if (insertErr) {
			if ((insertErr as any).code === '23505') {
				console.log('[webhook] skip: already processed', event.eventId);
				continue;
			} else {
				console.error('[webhook] processed_events insert error — processing anyway', event.eventId, insertErr.message);
			}
		}

		try {
			const { data: tokenRows } = await sb
				.from('hubspot_tokens')
				.select('instance_id, site_id')
				.eq('portal_id', event.portalId)
				.limit(1);
			const tokenRow = tokenRows?.[0] ?? null;
			console.log('[webhook] token lookup', JSON.stringify({ portalId: event.portalId, found: !!tokenRow }));

			if (!tokenRow) {
				console.warn('[webhook] no installation for portal', event.portalId);
				continue;
			}

			const instanceId: string = tokenRow.instance_id;
			const siteId: string = (tokenRow as any).site_id ?? instanceId;
			const syncId = crypto.randomUUID();

			const hsToken = await getHubSpotToken(env, instanceId);
			const mappings = await getFieldMappings(env, instanceId);
			const customHsProps = mappings
				.filter((m) => m.direction !== 'wix_to_hubspot')
				.map((m) => m.hubspotProp);

			const contact = await hsGetContact(hsToken, hsId, customHsProps);
			const hsProps = contact.properties;

			console.log('[webhook] processing', JSON.stringify({
				hsId,
				siteId,
				subscriptionType: event.subscriptionType,
				changeSource: event.changeSource,
				wix_sync_source: hsProps.wix_sync_source,
			}));

			const syncTs = parseInt(hsProps.wix_sync_timestamp ?? '0', 10);
			if (hsProps.wix_sync_source?.startsWith('wix_sync_') && Date.now() - syncTs < 60_000) {
				console.log('[webhook] skip: own write within 60s', JSON.stringify({ hsId, syncTs }));
				continue;
			}

			const { data: idMapRows } = await sb
				.from('contact_id_map')
				.select('wix_id, last_sync_source, last_synced_at')
				.eq('instance_id', instanceId)
				.eq('hubspot_id', hsId)
				.eq('entity_type', 'contact')
				.limit(1);
			const idMap = Array.isArray(idMapRows) ? idMapRows[0] ?? null : null;
			console.log('[webhook] idMap lookup', JSON.stringify({ found: !!idMap, wixId: idMap?.wix_id }));

			if (idMap) {
				const lastSyncMs = new Date(idMap.last_synced_at).getTime();
				if (idMap.last_sync_source === 'wix' && Date.now() - lastSyncMs < 30_000) {
					console.log('[webhook] skip: db timestamp guard', hsId);
					continue;
				}

				const wixContact = await wixGetContact(env, siteId, idMap.wix_id);
				const info = await buildWixInfo(env, siteId, hsProps, mappings);
				console.log('[webhook] built wix info', JSON.stringify({ keys: Object.keys(info) }));

				if (Object.keys(info).length) {
					await wixUpdateContact(env, siteId, idMap.wix_id, wixContact.revision, info);
					console.log('[webhook] wix contact updated', idMap.wix_id);
				} else {
					console.log('[webhook] skip: no mapped fields to write', hsId);
				}

				await sb.from('contact_id_map').upsert(
					{ instance_id: instanceId, wix_id: idMap.wix_id, hubspot_id: hsId, entity_type: 'contact', last_sync_source: 'hubspot', last_sync_id: syncId, last_synced_at: new Date().toISOString() },
					{ onConflict: 'instance_id,wix_id,entity_type' },
				);
				await sb.from('sync_log').insert({ instance_id: instanceId, direction: 'hubspot_to_wix', entity_type: 'contact', wix_id: idMap.wix_id, hubspot_id: hsId, status: 'success', sync_id: syncId, synced_at: new Date().toISOString() });
			} else {
				const existingWixId = hsProps.wix_contact_id;

				if (existingWixId) {
					console.log('[webhook] HubSpot contact has wix_contact_id, updating original Wix contact', JSON.stringify({ existingWixId, hsId }));
					const wixContact = await wixGetContact(env, siteId, existingWixId);
					const info = await buildWixInfo(env, siteId, hsProps, mappings);
					if (Object.keys(info).length) {
						await wixUpdateContact(env, siteId, existingWixId, wixContact.revision, info);
					}
					await sb.from('contact_id_map').upsert(
						{ instance_id: instanceId, wix_id: existingWixId, hubspot_id: hsId, entity_type: 'contact', last_sync_source: 'hubspot', last_sync_id: syncId, last_synced_at: new Date().toISOString() },
						{ onConflict: 'instance_id,wix_id,entity_type' },
					);
					await sb.from('sync_log').insert({ instance_id: instanceId, direction: 'hubspot_to_wix', entity_type: 'contact', wix_id: existingWixId, hubspot_id: hsId, status: 'success', sync_id: syncId, synced_at: new Date().toISOString() });
				} else if (hsProps.wix_sync_source?.startsWith('wix_sync_')) {
					console.log('[webhook] skip: Wix-origin contact without wix_contact_id', hsId);
				} else {
					const info = await buildWixInfo(env, siteId, hsProps, mappings);
					console.log('[webhook] no idMap — create path, info keys:', JSON.stringify(Object.keys(info)));
					if (!Object.keys(info).length) {
						console.log('[webhook] skip: no mapped fields for new contact', hsId);
						continue;
					}
					const newWixId = await wixCreateContact(env, siteId, info);
					console.log('[webhook] wix contact created', newWixId);
					if (!newWixId) continue;
					await sb.from('contact_id_map').upsert(
						{ instance_id: instanceId, wix_id: newWixId, hubspot_id: hsId, entity_type: 'contact', last_sync_source: 'hubspot', last_sync_id: syncId, last_synced_at: new Date().toISOString() },
						{ onConflict: 'instance_id,wix_id,entity_type' },
					);
					await sb.from('sync_log').insert({ instance_id: instanceId, direction: 'hubspot_to_wix', entity_type: 'contact', wix_id: newWixId, hubspot_id: hsId, status: 'success', sync_id: syncId, synced_at: new Date().toISOString() });
				}
			}
		} catch (err) {
			console.error('[webhook] event failed', event.eventId, String(err));
			try {
				const { data: tokenRows } = await sb.from('hubspot_tokens').select('instance_id').eq('portal_id', event.portalId).limit(1);
				const instanceId = tokenRows?.[0]?.instance_id;
				if (instanceId) {
					await sb.from('sync_log').insert({ instance_id: instanceId, direction: 'hubspot_to_wix', entity_type: 'contact', wix_id: null, hubspot_id: hsId, status: 'error', error_message: String(err), sync_id: null, synced_at: new Date().toISOString() });
				}
			} catch { /* suppress */ }
		}
	}

	return Response.json({ ok: true });
}

// ── Entry point ───────────────────────────────────────────────────

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

		return handleWebhook(req, env);
	},
} satisfies ExportedHandler<Env>;
