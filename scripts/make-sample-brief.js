'use strict';
// Writes docs/planner-brief/sample-brief.json: the Competitor Brief for the 15-row demo spot log (scripts/planner-brief-fixture.js).
// Run: npm run sample:brief
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ingestFile } = require('../server/ingest');
const { plannerBrief } = require('../server/plannerBrief');
const { HEADER, ROWS, F } = require('./planner-brief-fixture');

(async () => {
  const tmp = path.join(os.tmpdir(), `cas-sample-brief-${process.pid}.csv`);
  fs.writeFileSync(tmp, [HEADER, ...ROWS].join('\n'));
  const ds = await ingestFile(tmp, 'demo-spot-log.csv');
  fs.rmSync(tmp);
  const brief = plannerBrief(ds, F);
  const out = path.join(__dirname, '..', 'docs', 'planner-brief', 'sample-brief.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(brief, null, 2) + '\n');
  console.log('Wrote', path.relative(process.cwd(), out), (fs.statSync(out).size / 1024).toFixed(1), 'KB');
})().catch(e => { console.error(e); process.exit(1); });
