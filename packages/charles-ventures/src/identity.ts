// SPDX-License-Identifier: AGPL-3.0-or-later
// Companies House lookup — a venture's official identity (charles#16). Given a UK Companies
// House registration number, fetch the official record and map it to a flat identity profile the
// brain reads back. Public data, free REST API, key-as-username basic auth — the lightest venture
// integration (no OAuth), so the proving ground for the pattern (docs/003).
//
// `external_ref` parity: the CH number is the venture's opaque public handle, not a secret. The API
// key (one per eidan instance, from the free CH developer hub) is the only credential, read from
// EIDAN_COMPANIES_HOUSE_KEY by the tool layer — never stored on the venture.
//
// The network call is injected (`fetcher`) so the mapping logic is unit-tested against canned
// payloads without a key or a socket.

export const CH_API_BASE = 'https://api.company-information.service.gov.uk';

// UK CH number: 8 digits, or a 2-letter nation/type prefix + 6-8 digits (SC Scotland, NI
// N.Ireland, OC/SO LLP, etc.). Loose on purpose — if CH rejects it the lookup surfaces a clean
// error rather than pre-judging.
const CH_NUMBER_RE = /^(SC|NI|OC|SO|NC|R|FC|GE|GS|GN|GI|AC|SA)?[0-9]{6,8}$/;

// The CH json fields we lift into the venture's identity profile. Flat, named, stable — the brain
// reads these back, so the shape is part of the contract.
const PROFILE_FIELDS = [
  'company_number',
  'company_name',
  'company_status',
  'type',
  'date_of_creation',
  'jurisdiction',
] as const;

/** A lookup failed in a way worth showing the operator verbatim. */
export class CompaniesHouseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompaniesHouseError';
  }
}

// A fetcher takes (normalisedNumber, apiKey) and returns the raw CH json, or throws
// CompaniesHouseError. Injectable so tests skip the network.
export type Fetcher = (number: string, apiKey: string) => Promise<Record<string, unknown>>;

/** Trim/upcase a CH number and validate its shape, or throw. Strips spaces ("SC 123456"). */
export function normaliseChNumber(number: string): string {
  const cleaned = String(number ?? '').replace(/\s+/g, '').toUpperCase();
  if (!cleaned) throw new CompaniesHouseError('registration_number is required');
  if (!CH_NUMBER_RE.test(cleaned)) {
    throw new CompaniesHouseError(
      `'${cleaned}' doesn't look like a UK Companies House number ` +
        '(8 digits, or SC/NI/OC + 6 digits). Check Companies House WebCheck.',
    );
  }
  return cleaned;
}

/** Default fetcher: GET the CH company endpoint (key as basic-auth user, blank password). */
async function httpFetch(number: string, apiKey: string): Promise<Record<string, unknown>> {
  const auth = Buffer.from(`${apiKey}:`).toString('base64');
  let resp: Response;
  try {
    resp = await fetch(`${CH_API_BASE}/company/${number}`, {
      headers: { authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (exc) {
    throw new CompaniesHouseError(
      `Companies House request failed: ${exc instanceof Error ? exc.message : String(exc)}`,
    );
  }
  if (resp.status === 401) throw new CompaniesHouseError('Companies House rejected the API key');
  if (resp.status === 404) throw new CompaniesHouseError(`no company found for ${number}`);
  if (resp.status !== 200) throw new CompaniesHouseError(`Companies House returned HTTP ${resp.status}`);
  return (await resp.json()) as Record<string, unknown>;
}

/** A single human-readable registered-office line from CH's address dict. */
function addressLine(raw: Record<string, unknown>): string | null {
  const addr = (raw['registered_office_address'] as Record<string, unknown>) ?? {};
  const parts = ['address_line_1', 'address_line_2', 'locality', 'postal_code', 'country']
    .map((k) => addr[k])
    .filter((p): p is string => typeof p === 'string' && p.length > 0);
  return parts.length ? parts.join(', ') : null;
}

/** Map a raw CH company payload to the venture identity profile. */
function profile(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PROFILE_FIELDS) out[k] = raw[k] ?? null;
  out['registered_office'] = addressLine(raw);
  out['sic_codes'] = raw['sic_codes'] ?? [];
  out['source'] = 'companies_house';
  return out;
}

/**
 * Resolve a CH number to a venture identity profile. Validates the number, fetches the record (real
 * HTTP unless `fetcher` is injected), and maps it to the flat profile shape. Throws
 * CompaniesHouseError with an operator-facing message on any failure.
 */
export async function lookupCompany(
  number: string,
  opts: { apiKey: string; fetcher?: Fetcher },
): Promise<Record<string, unknown>> {
  const normalised = normaliseChNumber(number);
  const fetch_ = opts.fetcher ?? httpFetch;
  const raw = await fetch_(normalised, opts.apiKey);
  if (typeof raw !== 'object' || raw === null || !raw['company_number']) {
    throw new CompaniesHouseError(`unexpected Companies House response for ${normalised}`);
  }
  return profile(raw);
}
