// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CompaniesHouseError,
  normaliseChNumber,
  lookupCompany,
} from './identity.js';

describe('CompaniesHouseError', () => {
  it('is an Error with name "CompaniesHouseError"', () => {
    const err = new CompaniesHouseError('test error');
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'CompaniesHouseError');
    assert.equal(err.message, 'test error');
  });

  it('can be caught as an Error', () => {
    try {
      throw new CompaniesHouseError('test');
    } catch (e) {
      assert.ok(e instanceof Error);
      assert.ok(e instanceof CompaniesHouseError);
    }
  });
});

describe('normaliseChNumber', () => {
  it('accepts standard 8-digit UK company numbers', () => {
    assert.equal(normaliseChNumber('12345678'), '12345678');
  });

  it('upcases and strips whitespace from prefixed numbers', () => {
    assert.equal(normaliseChNumber('sc 123456'), 'SC123456');
    assert.equal(normaliseChNumber('  ni 654321  '), 'NI654321');
  });

  it('accepts various UK entity prefixes', () => {
    const validPrefixes = ['SC', 'NI', 'OC', 'SO', 'NC', 'R', 'FC', 'GE', 'GS', 'GN', 'GI', 'AC', 'SA'];
    for (const prefix of validPrefixes) {
      assert.equal(normaliseChNumber(`${prefix}123456`).startsWith(prefix), true);
    }
  });

  it('throws error for empty or null input', () => {
    try {
      normaliseChNumber('');
      assert.fail('should throw');
    } catch (err) {
      assert.ok(err instanceof CompaniesHouseError);
      assert.ok((err as Error).message.includes('required'));
    }
    try {
      normaliseChNumber('   ');
      assert.fail('should throw');
    } catch (err) {
      assert.ok(err instanceof CompaniesHouseError);
    }
  });

  it('throws error for numbers too short', () => {
    try {
      normaliseChNumber('12345');
      assert.fail('should throw');
    } catch (err) {
      assert.ok(err instanceof CompaniesHouseError);
      assert.ok((err as Error).message.includes('Companies House number'));
    }
  });

  it('throws error for numbers too long', () => {
    try {
      normaliseChNumber('123456789');
      assert.fail('should throw');
    } catch (err) {
      assert.ok(err instanceof CompaniesHouseError);
    }
  });

  it('throws error for invalid prefixes', () => {
    try {
      normaliseChNumber('XX123456');
      assert.fail('should throw');
    } catch (err) {
      assert.ok(err instanceof CompaniesHouseError);
    }
  });

  it('throws error for non-numeric suffix', () => {
    try {
      normaliseChNumber('1234567a');
      assert.fail('should throw');
    } catch (err) {
      assert.ok(err instanceof CompaniesHouseError);
    }
  });
});

describe('lookupCompany', () => {
  it('normalises the number and fetches company profile', async () => {
    const mockCompanyData = {
      company_number: '12345678',
      company_name: 'Test Company Ltd',
      company_status: 'active',
      type: 'private-unlimited-company',
      date_of_creation: '2020-01-01',
      jurisdiction: 'england-wales',
      registered_office_address: {
        address_line_1: '123 Main Street',
        locality: 'London',
        postal_code: 'SW1A 1AA',
        country: 'England',
      },
      sic_codes: ['62.01'],
    };

    const mockFetcher = async (number: string, apiKey: string) => {
      assert.equal(number, '12345678');
      return mockCompanyData;
    };

    const result = await lookupCompany('12345678', {
      apiKey: 'test-key',
      fetcher: mockFetcher,
    });

    assert.equal(result.company_number, '12345678');
    assert.equal(result.company_name, 'Test Company Ltd');
    assert.equal(result.source, 'companies_house');
  });

  it('builds registered office address from address fields', async () => {
    const mockFetcher = async () => ({
      company_number: '12345678',
      registered_office_address: {
        address_line_1: '123 Main',
        address_line_2: 'Suite 100',
        locality: 'London',
        postal_code: 'SW1A 1AA',
        country: 'England',
      },
    });

    const result = await lookupCompany('12345678', {
      apiKey: 'test-key',
      fetcher: mockFetcher,
    });

    assert.ok((result.registered_office as string).includes('123 Main'));
    assert.ok((result.registered_office as string).includes('Suite 100'));
    assert.ok((result.registered_office as string).includes('London'));
  });

  it('returns null for missing optional fields', async () => {
    const mockFetcher = async () => ({
      company_number: '12345678',
    });

    const result = await lookupCompany('12345678', {
      apiKey: 'test-key',
      fetcher: mockFetcher,
    });

    assert.equal(result.company_name, null);
    assert.equal(result.company_status, null);
  });

  it('returns empty array for missing sic_codes', async () => {
    const mockFetcher = async () => ({
      company_number: '12345678',
    });

    const result = await lookupCompany('12345678', {
      apiKey: 'test-key',
      fetcher: mockFetcher,
    });

    assert.deepEqual(result.sic_codes, []);
  });

  it('throws error for invalid number', async () => {
    try {
      await lookupCompany('invalid', {
        apiKey: 'test-key',
        fetcher: async () => ({}),
      });
      assert.fail('should throw');
    } catch (err) {
      assert.ok(err instanceof CompaniesHouseError);
    }
  });

  it('throws error for empty fetcher response', async () => {
    const mockFetcher = async () => ({});

    try {
      await lookupCompany('12345678', {
        apiKey: 'test-key',
        fetcher: mockFetcher,
      });
      assert.fail('should throw');
    } catch (err) {
      assert.ok(err instanceof CompaniesHouseError);
      assert.ok((err as Error).message.includes('unexpected'));
    }
  });

  it('throws error if fetcher returns non-object', async () => {
    const mockFetcher = async () => null;

    try {
      await lookupCompany('12345678', {
        apiKey: 'test-key',
        fetcher: mockFetcher as any,
      });
      assert.fail('should throw');
    } catch (err) {
      assert.ok(err instanceof CompaniesHouseError);
    }
  });

  it('passes API key to fetcher', async () => {
    let passedKey = '';
    const mockFetcher = async (number: string, apiKey: string) => {
      passedKey = apiKey;
      return { company_number: '12345678' };
    };

    await lookupCompany('12345678', {
      apiKey: 'my-secret-key',
      fetcher: mockFetcher,
    });

    assert.equal(passedKey, 'my-secret-key');
  });
});
