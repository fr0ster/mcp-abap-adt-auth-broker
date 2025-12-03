/**
 * Tests for XsuaaServiceKeyParser class
 */

import { XsuaaServiceKeyParser } from '../../parsers/XsuaaServiceKeyParser';

describe('XsuaaServiceKeyParser', () => {
  let parser: XsuaaServiceKeyParser;

  beforeEach(() => {
    parser = new XsuaaServiceKeyParser();
  });

  describe('canParse', () => {
    it('should return true for valid XSUAA format', () => {
      const rawData = {
        url: 'https://example.authentication.eu10.hana.ondemand.com',
        clientid: 'sb-example-12345!t123',
        clientsecret: 'example-secret-key-12345$example-hash=',
      };

      expect(parser.canParse(rawData)).toBe(true);
    });

    it('should return false for ABAP format (with nested uaa object)', () => {
      const rawData = {
        uaa: {
          url: 'https://uaa.test.com',
          clientid: 'client123',
          clientsecret: 'secret123',
        },
      };

      expect(parser.canParse(rawData)).toBe(false);
    });

    it('should return false if url is missing', () => {
      const rawData = {
        clientid: 'client123',
        clientsecret: 'secret123',
      };

      expect(parser.canParse(rawData)).toBe(false);
    });

    it('should return false if clientid is missing', () => {
      const rawData = {
        url: 'https://uaa.test.com',
        clientsecret: 'secret123',
      };

      expect(parser.canParse(rawData)).toBe(false);
    });

    it('should return false if clientsecret is missing', () => {
      const rawData = {
        url: 'https://uaa.test.com',
        clientid: 'client123',
      };

      expect(parser.canParse(rawData)).toBe(false);
    });

    it('should return false for null or undefined', () => {
      expect(parser.canParse(null)).toBe(false);
      expect(parser.canParse(undefined)).toBe(false);
    });

    it('should return false for non-object types', () => {
      expect(parser.canParse('string')).toBe(false);
      expect(parser.canParse(123)).toBe(false);
      expect(parser.canParse([])).toBe(false);
    });
  });

  describe('parse', () => {
    it('should parse valid XSUAA service key', () => {
      const rawData = {
        url: 'https://example.authentication.eu10.hana.ondemand.com',
        clientid: 'sb-example-12345!t123',
        clientsecret: 'example-secret-key-12345$example-hash=',
        tenantmode: 'shared',
      };

      const result = parser.parse(rawData);

      expect(result).toEqual({
        uaa: {
          url: 'https://example.authentication.eu10.hana.ondemand.com',
          clientid: 'sb-example-12345!t123',
          clientsecret: 'example-secret-key-12345$example-hash=',
        },
        url: 'https://example.authentication.eu10.hana.ondemand.com',
        abap: undefined,
      });
    });

    it('should preserve abap.url if present', () => {
      const rawData = {
        url: 'https://uaa.test.com',
        clientid: 'client123',
        clientsecret: 'secret123',
        abap: {
          url: 'https://abap.test.com',
        },
      };

      const result = parser.parse(rawData);

      if (result && typeof result === 'object') {
        const sk = result as { abap?: { url?: string } };
        expect(sk.abap?.url).toBe('https://abap.test.com');
      }
    });

    it('should preserve optional fields', () => {
      const rawData = {
        url: 'https://uaa.test.com',
        clientid: 'client123',
        clientsecret: 'secret123',
        sap_url: 'https://sap.test.com',
        client: '001',
        sap_client: '001',
        language: 'EN',
      };

      const result = parser.parse(rawData);

      if (result && typeof result === 'object') {
        const sk = result as { sap_url?: string; client?: string; sap_client?: string; language?: string };
        expect(sk.sap_url).toBe('https://sap.test.com');
        expect(sk.client).toBe('001');
        expect(sk.sap_client).toBe('001');
        expect(sk.language).toBe('EN');
      }
    });

    it('should throw error if cannot parse', () => {
      const rawData = {
        uaa: {
          url: 'https://uaa.test.com',
          clientid: 'client123',
          clientsecret: 'secret123',
        },
      };

      expect(() => parser.parse(rawData)).toThrow('Service key does not match XSUAA format');
    });

    it('should throw error if url is missing', () => {
      const rawData = {
        clientid: 'client123',
        clientsecret: 'secret123',
      };

      expect(() => parser.parse(rawData)).toThrow('Service key does not match XSUAA format');
    });
  });
});

