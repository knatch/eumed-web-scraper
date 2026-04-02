'use strict';

/**
 * ISO 3166-1 alpha-2 country code to full country name mapping.
 * Covers all EU/EEA member states plus common countries that appear
 * in the EUDAMED Economic Operators registry.
 */
const COUNTRY_NAMES = {
  // EU member states
  AT: 'Austria',
  BE: 'Belgium',
  BG: 'Bulgaria',
  HR: 'Croatia',
  CY: 'Cyprus',
  CZ: 'Czechia',
  DK: 'Denmark',
  EE: 'Estonia',
  FI: 'Finland',
  FR: 'France',
  DE: 'Germany',
  GR: 'Greece',
  HU: 'Hungary',
  IE: 'Ireland',
  IT: 'Italy',
  LV: 'Latvia',
  LT: 'Lithuania',
  LU: 'Luxembourg',
  MT: 'Malta',
  NL: 'Netherlands',
  PL: 'Poland',
  PT: 'Portugal',
  RO: 'Romania',
  SK: 'Slovakia',
  SI: 'Slovenia',
  ES: 'Spain',
  SE: 'Sweden',

  // EEA / EFTA
  IS: 'Iceland',
  LI: 'Liechtenstein',
  NO: 'Norway',
  CH: 'Switzerland',

  // Common non-EU countries in EUDAMED
  US: 'United States',
  GB: 'United Kingdom',
  CA: 'Canada',
  AU: 'Australia',
  NZ: 'New Zealand',
  JP: 'Japan',
  KR: 'South Korea',
  CN: 'China',
  TW: 'Taiwan',
  HK: 'Hong Kong',
  SG: 'Singapore',
  IN: 'India',
  IL: 'Israel',
  TR: 'Turkey',
  BR: 'Brazil',
  MX: 'Mexico',
  AR: 'Argentina',
  CO: 'Colombia',
  CL: 'Chile',
  ZA: 'South Africa',
  AE: 'United Arab Emirates',
  SA: 'Saudi Arabia',
  MY: 'Malaysia',
  TH: 'Thailand',
  VN: 'Vietnam',
  PH: 'Philippines',
  ID: 'Indonesia',
  RU: 'Russia',
  UA: 'Ukraine',
  EG: 'Egypt',
  NG: 'Nigeria',
  KE: 'Kenya',
  PA: 'Panama',
  CR: 'Costa Rica',
  PE: 'Peru',
  EC: 'Ecuador',
  DO: 'Dominican Republic',
  GT: 'Guatemala',
  UY: 'Uruguay',
  PY: 'Paraguay',
  BO: 'Bolivia',
  VE: 'Venezuela',
  CU: 'Cuba',
  JM: 'Jamaica',
  TT: 'Trinidad and Tobago',
  BD: 'Bangladesh',
  PK: 'Pakistan',
  LK: 'Sri Lanka',
  NP: 'Nepal',
  MM: 'Myanmar',
  KH: 'Cambodia',
  LA: 'Laos',
  BN: 'Brunei',
  MN: 'Mongolia',
  KZ: 'Kazakhstan',
  UZ: 'Uzbekistan',
  GE: 'Georgia',
  AM: 'Armenia',
  AZ: 'Azerbaijan',
  BY: 'Belarus',
  MD: 'Moldova',
  RS: 'Serbia',
  BA: 'Bosnia and Herzegovina',
  ME: 'Montenegro',
  MK: 'North Macedonia',
  AL: 'Albania',
  XK: 'Kosovo',
};

/**
 * Returns the full country name for a given ISO 3166-1 alpha-2 code.
 * Falls back to the code itself if no mapping is found.
 *
 * @param {string} code - Two-letter country code (e.g. "US", "DE")
 * @returns {string} Full country name or the original code if unmapped
 */
function countryName(code) {
  if (!code) return '';
  const upper = code.toUpperCase().trim();
  return COUNTRY_NAMES[upper] || upper;
}

module.exports = { countryName, COUNTRY_NAMES };
