'use strict';
// A 15-row spot log whose numbers can be counted by hand. Used by the Competitor Brief test and to write the sample payload.
const HEADER = 'Product_Group,Advertiser,Product,Advt_Theme,Channel,Program,Dd,Mn,Yr,Day,Prog_time,Advt_time,AdPos,TotAds,BrkNo,PosinBrk,AdsinBrk,Lng,Dur,Cost';
// AdPos is the position in the programme here (numeric), TotAds the ads in the programme.
const ROWS = [
  // Me: 4 commercials + 1 value addition (-BB) + 1 zero-cost spot
  'Biscuits,Me,P,Theme A,TV - Derana TV,News,5,1,2026,Mon,19:00,19:45:00,1,10,1,1,5,Sinhala,30,1000',
  'Biscuits,Me,P,Theme A,TV - Derana TV,News,6,1,2026,Tue,19:00,19:45:00,5,10,2,3,5,Sinhala,30,1000',
  'Biscuits,Me,P,Theme A,FM Derana,Show,12,1,2026,Mon,08:00,08:10:00,9,10,3,5,5,Sinhala,15,500',
  'Biscuits,Me,P,Theme B,TV - Sirasa TV,Drama,5,2,2026,Thu,21:00,21:30:00,2,10,1,2,4,Tamil,20,1500',
  'Biscuits,Me,P,Summer -BB,TV - Derana TV,News,6,2,2026,Fri,19:00,19:50:00,1,10,1,1,5,Sinhala,5,500',
  'Biscuits,Me,P,Theme A,TV - Derana TV,News,7,2,2026,Sat,19:00,19:55:00,3,10,1,1,5,Sinhala,30,0',
  // Rival: heavy on Sirasa in prime, first in break
  'Biscuits,Rival,P,Rival Theme,TV - Sirasa TV,Drama,5,1,2026,Mon,21:00,21:10:00,1,10,1,1,4,Sinhala,30,3000',
  'Biscuits,Rival,P,Rival Theme,TV - Sirasa TV,Drama,6,1,2026,Tue,21:00,21:10:00,1,10,1,1,4,Sinhala,30,3000',
  'Biscuits,Rival,P,Rival Theme,TV - Sirasa TV,Drama,7,1,2026,Wed,21:00,21:10:00,2,10,2,1,4,Sinhala,30,3000',
  'Biscuits,Rival,P,Rival Theme,TV - Sirasa TV,Drama,8,1,2026,Thu,21:00,21:10:00,9,10,2,1,4,Sinhala,15,3000',
  'Biscuits,Rival,P,Rival Theme,TV - Sirasa TV,Drama,9,1,2026,Fri,21:00,21:10:00,1,10,1,1,4,Sinhala,30,3000',
  'Biscuits,Rival,P,Rival Theme,TV - Sirasa TV,Drama,10,1,2026,Sat,21:00,21:10:00,1,10,1,4,4,Sinhala,30,3000',
  'Biscuits,Rival,P,Rival Theme,Lankadeepa,,11,1,2026,Sun,,,,,,,,Sinhala,,2000',
  // Third advertiser, only in March (we have no spend in March)
  'Biscuits,Third,P,Third Theme,TV - Hiru TV,Morning Show,3,3,2026,Tue,07:00,07:10:00,1,10,1,1,3,English,10,2000',
  'Biscuits,Third,P,Third Theme,TV - Hiru TV,Morning Show,4,3,2026,Wed,07:00,07:10:00,1,10,1,1,3,English,10,2000',
];

// The dashboard's filters for it: Me against Rival and Third, first quarter of 2026.
const F = { from: '2026-01-01', to: '2026-03-31', pg: 'Biscuits', mine: ['Me'], comps: ['Rival', 'Third'], medium: 'All' };

module.exports = { HEADER, ROWS, F };
