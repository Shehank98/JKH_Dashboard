# Competitor data in the media planning tool

The Live Dashboard can hand its competitor numbers straight to the media planning tool, so planners see
what rivals buy: channels, programmes, which break and which slot in the break, ad lengths, days and hours,
and how they spread money over the weeks.

* **Dashboard:** Export, **Send to planning tool** (opens the planning tool and sends the data), or
  **Competitor data for planning tool (JSON)** (the same data as a file).
* The data follows the dashboard filters: category, period, medium, channel, daypart, ad type, my advertiser
  and competitors. Every advertiser in the category is included; each row names its advertiser, and
  `advertisers[].role` says `mine`, `competitor` or `other`.
* Browser to browser: the dashboard sends it with `postMessage` to the planning tool's address only, and the
  planning tool accepts it only from the dashboard's address. Neither server sees it.

## 1. Add the receiver to the planning tool

1. Copy [`ooc-competitor-import.js`](ooc-competitor-import.js) to `public/js/competitor-import.js`.
2. In it, set `OOC_ALLOWED_ORIGINS` to the dashboard's address, for example `https://jkh-dashboard.up.railway.app`.
3. In `public/js/app.js`:

```js
import { initCompetitorImport, importCompetitorFile } from './competitor-import.js';
import { idbGet, idbSet } from './store.js';

let COMP = await idbGet('competitorIntel');          // last data received, kept in this browser
async function onCompetitorData(p) {
  COMP = p;
  await idbSet('competitorIntel', p);
  setTab('competitors');                              // a new "Competitors" tab that draws the charts below
  toast(`Competitor data: ${p.filters.category}, ${p.filters.from} to ${p.filters.to}`);
}
initCompetitorImport({ onData: onCompetitorData });
// Optional button: <input type="file" accept=".json"> → importCompetitorFile(file, onCompetitorData)
```

4. On the dashboard's Railway service, `PLANNING_TOOL_URL` sets where **Send to planning tool** goes
   (default `https://media-planing-v2-copy-production.up.railway.app`).

The dashboard opens `PLANNING_TOOL_URL/#competitors`, waits for `{type:'ooc:ready'}`, sends
`{type:'ooc:competitor-intel', version:1, payload}` and waits for `{type:'ooc:received', ok:true}`
(or `ok:false, error`). It gives up after 30 seconds and suggests the JSON file.

## 2. The data (format `ogilvy-orbit-chub/competitor-intel`, version 1)

Spend is whole LKR at rate card; shares are percentages (0 to 100). Length buckets: `5s 10s 15s 20s 30s 30s+`.
Positions in a break: `First, Second, Middle, Second last, Last, Only ad, Unknown`. Breaks in a programme:
`Start, Mid, End, Unknown` (Press has no breaks, so it shows as Unknown). Days `Mon` to `Sun`, hours 0 to 23.

| Key | One row per | Fields |
|---|---|---|
| `filters`, `totals` | (object) | category, from, to, months, medium, channel, daypart, adType, mine, competitors / spend, spots, advertisers |
| `advertisers` | advertiser | rank, name, role |
| `summary` | advertiser | spend, sos, spots, sov, avgCostPerSpot, acd, activeMonths, activeWeeks, channels, programmes, campaigns, tvShare, radioShare, pressShare, valueAdditionsShare, firstSpot, lastSpot |
| `channels` | advertiser × channel | medium, channel, spend, spots, shareOfAdvertiser, shareOfChannel |
| `programmes` | advertiser × channel × programme (TV and Radio, top 200 per advertiser) | medium, channel, programme, spend, spots, shareOfAdvertiser, avgDuration, usualHour, airDays[], months, firstSpot, lastSpot, breaks{Start,Mid,End,Unknown}, positions{First…Unknown} |
| `breakPositions` | advertiser × break × position | breakInProgramme, positionInBreak, spots, spend, shareOfSpots |
| `breakNumbers` | advertiser × break number | breakNo (`1` to `9`, `10+`), spots, spend |
| `durations` | advertiser × medium × length | medium (TV/Radio), length, spots, spend |
| `hours` | advertiser × day × hour | day, dayIndex (0 = Mon), hour, spots, spend |
| `dayparts` | advertiser × daypart | daypart, time, spots, spend, shareOfAdvertiser |
| `months` | advertiser × month | month (`YYYY-MM`), spend, spots, sos |
| `weeks` | advertiser × week | weekStart (Monday, `YYYY-MM-DD`), spend, spots |
| `campaigns` | advertiser × campaign (top 25) | campaign, type (Commercial / Value Addition), spend, spots, shareOfAdvertiser, firstSpot, lastSpot, channels[] |
| `warnings` | message | e.g. data loaded before programmes were kept: load the file again in the dashboard |

## 3. Charts to add (Chart.js, as the planning tool already uses)

Show a competitor picker (default: the competitors, with mine for comparison) and the period from `filters`.
Colour "mine" in the dashboard orange and keep one colour per advertiser across every chart.

| # | Chart | Answers | Chart.js | Data |
|---|---|---|---|---|
| 1 | **Competitor scorecards** | How big is each rival? | KPI tiles | `summary`: sos, spend, spots, acd, activeWeeks, channels, programmes |
| 2 | **Share of spend ranking** | Who leads the category? | horizontal `bar` | `summary`: advertiser vs sos (mine highlighted) |
| 3 | **Channel split per advertiser** | Where does each rival put its money? | horizontal `bar`, `stacked`, 100% | `channels`: one bar per advertiser, one segment per channel, value shareOfAdvertiser (top 6 channels + Other) |
| 4 | **Who owns each channel** | Which channels a rival dominates | `bar`, stacked | `channels`: one bar per channel, segments per advertiser, value shareOfChannel |
| 5 | **Top programmes bought** | Which programmes rivals buy | horizontal `bar` + table | `programmes` for one advertiser: top 15 by spend; label `channel · programme`; table adds spots, usualHour, airDays, avgDuration |
| 6 | **Competitor programmes vs our ratings** | Do rivals buy high or low TVR programmes? | `scatter` / `bubble` | join `programmes` (channel + programme) to the planning tool's own ratings rows (use its programme-name matching): x = average TVR, y = competitor spots, radius = spend |
| 7 | **Break in programme** | Start, mid or end breaks? | horizontal `bar`, stacked, 100% | `breakPositions` summed by breakInProgramme per advertiser (share of spots) |
| 8 | **Position in break** | Do they pay for first or last in break? | horizontal `bar`, stacked, 100% | `breakPositions` summed by positionInBreak per advertiser; show "First + Last %" as the premium figure |
| 9 | **Break number** | Early or late breaks in the programme? | `bar`, grouped | `breakNumbers`: x = breakNo, one series per advertiser, y = spots |
| 10 | **Ad length mix + ACD** | What lengths do they run? | horizontal `bar`, stacked, 100%, TV / Radio toggle | `durations` by length per advertiser; ACD from `summary.acd` in the label |
| 11 | **Day × hour heatmap** | When do rivals air, next to our audience? | grid of cells (like Explore's heatmap) | `hours` for one advertiser: rows = day, columns = hour, colour = spots; show beside the TVR heatmap for the same hours |
| 12 | **Daypart split** | Prime or daytime? | `doughnut` or stacked `bar` | `dayparts`: shareOfAdvertiser |
| 13 | **Weekly flighting** | Burst, pulse or always on? | `line` (filled) | `weeks`: x = weekStart, y = spend, one line per advertiser; gaps are dark weeks |
| 14 | **Monthly share of spend** | Who wins each month? | `line` | `months`: x = month, y = sos per advertiser |
| 15 | **Campaign timeline** | Which creatives ran when | horizontal floating `bar` (data `[firstSpot, lastSpot]`, time axis) | `campaigns` of one advertiser, colour by type |

Useful planner read-outs to put under the charts: a rival's top 3 channels and their share, its top 5
programmes, its % of spots in Start / Mid / End breaks and in First / Last position, its main ad length and ACD,
its peak day and hour, and the weeks it was dark.
