'use strict';
const fs   = require('fs');
const path = require('path');
const DATA_DIR   = process.env.DATA_DIR ?? path.join(__dirname, '../data');
const LEADS_FILE = path.join(DATA_DIR, 'leads_persist.json');
const PHONES = [
  '972509900001','972509900002','972509900003','972509900004',
  '972509900005','972509900006','972509900007','972509900008',
];
let data;
try { data = JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')); }
catch { data = { leads: {} }; }
let changed = 0, notFound = 0;
for (const phone of PHONES) {
  if (data.leads?.[phone]) {
    data.leads[phone].status = 'opted_out';
    if (!data.leads[phone].meta) data.leads[phone].meta = {};
    data.leads[phone].meta.optedOutAt  = new Date().toISOString();
    data.leads[phone].meta.optedOutMsg = 'synthetic_test_phone_automated_cleanup';
    changed++;
  } else { notFound++; }
}
const tmp = LEADS_FILE + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
fs.renameSync(tmp, LEADS_FILE);
console.log('opted_out:', changed, '| not_found:', notFound);
