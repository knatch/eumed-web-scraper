'use strict';

module.exports = {
  // List page
  LIST_TABLE_ROW: 'table tbody tr, mat-row',
  LIST_COL_SRN: '[matcolumndef="srn"] .mat-cell, td.mat-column-srn',
  LIST_COL_NAME: '[matcolumndef="name"] .mat-cell, td.mat-column-name',
  LIST_COL_ABBREVIATED: '[matcolumndef="abbreviatedName"] .mat-cell, td.mat-column-abbreviatedName',
  LIST_COL_CITY: '[matcolumndef="cityName"] .mat-cell, td.mat-column-cityName',
  LIST_DETAIL_BUTTON: 'button[aria-label="View detail"]',
  LIST_NO_RESULTS: '.no-results, [class*="no-result"], mat-row:empty',

  // Detail page
  DETAIL_ADDRESS: 'app-actor-address, [class*="address"]',
  DETAIL_EMAIL: 'a[href^="mailto:"]',
  DETAIL_PHONE: 'a[href^="tel:"]',
  DETAIL_SECTION_CA: 'app-competent-authority, [class*="competent-authority"], mat-expansion-panel',

  // Network interception patterns (confirmed EUDAMED API paths)
  API_ACTORS_PATH: '/api/eos',
  API_ACTOR_DETAIL_PATH: '/api/eos/',
};
