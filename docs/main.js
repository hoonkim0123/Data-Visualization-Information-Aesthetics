(async function () {
  // ========= Global State =========
  let isCountryView = false;
  let originalChartHTML = null;
  let countryData = null;

  // ========= Options / Responsive =========
  // Render Top-N franchises for performance and submission scope
  const TOP_N = 200; // change this number to render more/fewer franchises
  const MAX_SANE_SEASON = 100;
  const LONG_RUNNER_THRESHOLD = 25;

  const MIN_W = 680, MAX_W = 1600, SMALL_W = 900;
  const MIN_SEG_LABEL_W = 54;

  // ========= Label determination (neutral epsilon) =========
  const NEUTRAL_EPS = 0.03; // ±0.03로 좁혀 색 분포 확대
  function sentimentLabel(v){
    return v>=NEUTRAL_EPS ? "Positive" : (v<=-NEUTRAL_EPS ? "Negative" : "Neutral");
  }

  // ========= Helpers =========
  const parseDate = d => (d ? new Date(d) : null);
  const safeStr  = x => (x == null ? "" : String(x));
  const $  = (s)=>document.querySelector(s);
  function normKey(str){
    return (str||"").toString().toLowerCase()
      .normalize("NFKD").replace(/[\u0300-\u036f]/g,"")
      .replace(/&/g,"and").replace(/[^a-z0-9]+/g,"").trim();
  }

  // Generate a small set of normalization variants to improve matching
  function keyVariants(name){
    const out = new Set();
    if (!name) return [];
    const s = String(name).trim();
    function add(str){ if (str && str.toString().trim()) out.add(normKey(str)); }

    // base normalized
    add(s);
    // remove parenthetical year e.g. " (2011)"
    add(s.replace(/\(\s*\d{4}\s*\)/g, ""));
    // remove any parenthetical content
    add(s.replace(/\s*\([^\)]*\)\s*/g, " "));
    // remove leading articles (the, a, an)
    add(s.replace(/^(the|a|an)\s+/i, ""));
    // comma -> space variant
    add(s.replace(/,/g, " "));
    // cut at colon, translation markers, or double-slash (take left side)
    add(s.replace(/:\s.*$/ , ""));
    add(s.replace(/\/\/.*$/ , ""));
    // cut at dash/hyphen (common subtitle separators)
    add(s.replace(/[\u2013\u2014\-\–].*$/ , ""));
    // remove common suffix words like Part/Volume/Book/Series and trailing numbers
    add(s.replace(/\b(part|volume|book|series|episode|season|chapter)\b[\s\-:#_]*\w*/ig, ""));
    // remove trailing roman numerals or digits
    add(s.replace(/\b(?:[ivx]{1,6})\b\s*$/i, ""));
    add(s.replace(/\s+\d{1,4}\s*$/ , ""));
    // collapse multiple spaces
    Array.from(out).forEach(v => {
      add((v||"").replace(/\s+/g, " ").trim());
    });
    return Array.from(out).filter(Boolean);
  }

  // ========= Data load =========
  const tv = await d3.csv("data/NetflixTV_added.csv", d3.autoType);

  const SENT = new Map();
  const sentValsAll = [];
  await d3.csv("data/tmdb_sentiment_all.csv", d3.autoType).then(rows=>{
    for (const r of rows){
      const avg = +r.avg_score;
      if (!Number.isFinite(avg)) continue;
      const seasonN = +r.season;
      const variants = keyVariants(r.franchise);
      for (const v of variants){
        const key = `${v}__${seasonN}`;
        if (!SENT.has(key)) SENT.set(key, { avg, n:+r.n_episodes });
      }
      sentValsAll.push(avg);
    }
  });

  // (optional) Episodes / lexicon (for right-side snippet highlights)
  let EPIS = [];
  try{ EPIS = await d3.csv("data/episodes_all_top200.csv", d3.autoType); }catch(e){}
  let LEX = new Map();
  try{
    const lex = await d3.csv("data/lex_custom.csv", d3.autoType);
    for (const r of lex){
      const w = (r.word||r.term||r.token||"").toString().toLowerCase().trim();
      const s = +r.weight || +r.score || 0;
      if (w) LEX.set(w,s);
    }
  }catch(e){
    [["good",2],["great",3],["excellent",4],["love",3],["fun",2],
     ["bad",-2],["terrible",-4],["murder",-3],["kill",-3],["hate",-3]]
     .forEach(([w,s])=>LEX.set(w,s));
  }

  // ========= Preprocessing (franchise / season) =========
  function franchiseKey(d) {
    const simple = safeStr(d.Simple_Title).trim();
    if (simple) return simple;
    return safeStr(d.Title).replace(/Season\s*\d+|S\s*\d+/gi, "").replace(/\s+/g," ").trim();
  }
  function isSeasonLikeTitle(title){ return /(season\s*\d+|\bS\s*\d+\b)/i.test(safeStr(title)); }

  const EXCLUDE_TITLE_PATTERNS = [
    /behind\s+the/i, /making\s+of/i, /\bfeaturette\b/i, /\bspecial(s)?\b/i, /\bbonus\b/i,
    /\bafter\s*show\b/i, /\breunion\b/i, /\brecap\b/i, /\bpreview\b/i, /\bteaser\b/i,
    /\btrailer\b/i, /\bclip(s)?\b/i, /\bblooper(s)?\b/i, /\bouttake(s)?\b/i, /\bshorts?\b/i,
    /\ball[-\s]?stars?\b/i, /\bjunior\b/i, /\bkids\b/i, /\bspin[-\s]?off\b/i,
    /\bdocu(mentary)?\b/i, /\bhighlight(s)?\b/i, /:?\s*the\s*challenge\b/i,
    /\bmaking\s*film\b/i, /\bdirector'?s\s*cut\b/i, /\bextended\s*cut\b/i, /\bedited\s*version\b/i
  ];
  const EXCLUDE_WWE_RX = /(^raw:|\bwwe\b|\bsmackdown\b|\bnxt\b|\bwrestlemania\b|\broyal\s*rumble\b|\bpayback\b|\bbacklash\b|\bfastlane\b|\bcrown\s*jewel\b|\belimination\s*chamber\b|\bsummerslam\b|\bsurvivor\s*series\b)/i;

  function isCoreSeasonContent(row){
    const t = String(row.title||""), s = String(row.simple||"");
    if (EXCLUDE_WWE_RX.test(t) || EXCLUDE_WWE_RX.test(s)) return false;
    if (EXCLUDE_TITLE_PATTERNS.some(rx => rx.test(t)) || EXCLUDE_TITLE_PATTERNS.some(rx => rx.test(s))) return false;
    const hasValid = Number.isFinite(row.netSeason) && row.netSeason>=1 && row.netSeason<=MAX_SANE_SEASON;
    const looks = hasValid || isSeasonLikeTitle(t) || isSeasonLikeTitle(s);
    if (!looks) return false;
    if (Number.isFinite(row.netSeason) && row.netSeason>MAX_SANE_SEASON) return false;
    return true;
  }

  function baseRows(dataset){
    const out = [];
    for (const d of dataset) {
      const views = +d.Views || 0; if (views<=0) continue;
      const fr = franchiseKey(d); if (!fr) continue;
      const nSeason = +d.net_season;
      const row = {
        franchise: fr,
        title: safeStr(d.Title),
        simple: safeStr(d.Simple_Title),
        views, date: parseDate(d["Release Date"]),
        netSeason: Number.isFinite(nSeason) ? nSeason : null
      };
      if (!isCoreSeasonContent(row)) continue;
      out.push(row);
    }
    return out;
  }

  function assignSeasonIndex(rows) {
    const g = d3.group(rows, d => d.franchise);
    const out = [];
    for (const [fr, arr] of g) {
      const sane = arr.every(d => Number.isFinite(d.netSeason) && d.netSeason>=1 && d.netSeason<=MAX_SANE_SEASON);
      if (sane) {
        const uniq = Array.from(new Set(arr.map(d => d.netSeason))).sort((a,b)=>a-b);
        const remap = new Map(uniq.map((s,i)=>[s, i+1]));
        arr.forEach(d => out.push({ ...d, seasonIndex: remap.get(d.netSeason) }));
      } else {
        arr.sort((a,b) => (a.date&&b.date)? d3.ascending(a.date,b.date) : d3.ascending(a.title,b.title));
        arr.forEach((d,i)=> out.push({ ...d, seasonIndex: i+1 }));
      }
    }
    return out;
  }

  function summarize(rows){
    const reindexed = assignSeasonIndex(rows);
    const bySize = d3.rollups(reindexed, v => new Set(v.map(d => d.seasonIndex)).size, d => d.franchise);
    const tooLong = new Set(bySize.filter(([_,n]) => n > LONG_RUNNER_THRESHOLD).map(([fr]) => fr));
    const filtered = reindexed.filter(d => !tooLong.has(d.franchise));

    const byFr = d3.rollups(
      filtered,
      v => {
        const parts = d3.rollups(v, vv => d3.sum(vv, d => d.views), d => d.seasonIndex)
          .map(([s, sum]) => ({ s, v: sum })).sort((a,b)=>d3.ascending(a.s,b.s));
        const total = d3.sum(parts, d => d.v); if (!total) return null;
        const latest = d3.greatest(parts, d => d.s);
        const latestShare = latest ? latest.v / total : 0;
        return { total, latestShare, carryShare: 1 - latestShare, parts };
      },
      d => d.franchise
    )
    .map(([fr, obj]) => obj ? ({ franchise: fr, ...obj }) : null)
    .filter(Boolean)
    .sort((a,b)=>d3.descending(a.total,b.total));

    return byFr;
  }

  // ========= Color scale (interpolateRgbBasis, no gamma) =========
  const stops = d3.interpolateRgbBasis([
  "#b2182b",  // strong−
  "#d87474",  // mild−
  "#9aa0a6",  // darker neutral center
  "#7ccf93",  // mild+
  "#1a9850"   // strong+
  ]);

  const sentPool = sentValsAll.filter(Number.isFinite);
  const sSorted  = sentPool.length ? [...sentPool].sort(d3.ascending) : [-0.5,-0.2,0,0.2,0.5];
  const q05 = d3.quantileSorted(sSorted, 0.05);
  const q95 = d3.quantileSorted(sSorted, 0.95);
  const M   = Math.max(Math.abs(q05), Math.abs(q95), 0.12); // 최소 대비 ±0.12로 살짝 축소해 색 퍼짐 강화

  const color = d3.scaleDiverging(stops).domain([-M, 0, M]).clamp(true);

  // ========= Render setup =========
  const rows = baseRows(tv);
  // Use Top-N summarized dataset for submission (by total views)
  const DATA = summarize(rows).slice(0, TOP_N);

  // (debug) match rate
  {
    let f=0,t=0;
    for (const fr of DATA){ for (const p of fr.parts){ t++; if (SENT.has(`${normKey(fr.franchise)}__${+p.s}`)) f++; } }
    // sentiment join diagnostics removed for production build
  }

  const chartEl = document.getElementById("chart");
  const containerW = chartEl?.clientWidth || 980;
  // ensure chart container is a positioning context for inline popups
  try{ chartEl.style.position = chartEl.style.position || 'relative'; }catch(e){}
  const isSmall = containerW < SMALL_W;

  // Prevent horizontal page scrolling caused by SVG overflow
  if (chartEl) chartEl.style.overflowX = 'hidden';

  // Measure longest label width to avoid clipping on the left axis
  const axisFontSize = isSmall ? 12 : 14;
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = `${axisFontSize}px sans-serif`;
  const labelPadding = 16; // breathing room between label and axis
  let maxLabelWidth = 0;
  for (const row of DATA) {
    const w = ctx.measureText(row.franchise).width;
    if (w > maxLabelWidth) maxLabelWidth = w;
  }

  const minLeft = 32;
  // cap left margin to a tighter fraction of available width so chart gains more horizontal space
  // Add a small extra padding to the left margin to avoid clipping / glyph shifting across
  // different OS/browser font renderers. Bumped slightly to give more breathing room.
  const extraLeftPad = 18; // px — increased for extra left breathing
  const left = Math.min(Math.max(minLeft, Math.ceil(maxLabelWidth + labelPadding + extraLeftPad)), Math.floor(containerW * 0.22));
  const right = isSmall ? 18 : 160;
  const margin = { top:8, right, bottom:40, left };

  // layout values computed above (debug logging removed)

  // inner chart width (space for bars) — ensure non-negative
  const innerAvailable = Math.max(120, containerW - margin.left - margin.right - 20);
  const width = Math.max(MIN_W, Math.min(MAX_W, innerAvailable));
  // increase row height to make space for two-line labels and add breathing room
  const rowH = isSmall? 32: 40, barH = isSmall? 18: 20;
  const height = margin.top + margin.bottom + DATA.length * rowH;

  // leave a modest gap between axis labels and the bars to avoid overlap
  // increased gap for more consistent spacing across fonts/browsers
  const labelGap = isSmall ? 6 : 14;
  const x = d3.scaleLinear().domain([0, d3.max(DATA, d => d.total)]).nice()
    .range([margin.left + labelGap, margin.left + width]);
  const y = d3.scaleBand().domain(DATA.map(d => d.franchise))
    .range([margin.top, height - margin.bottom]).paddingInner(0.38);

  const svg = d3.select("#chart").html("").append("svg")
    .attr("width", Math.min(containerW, width + margin.left + margin.right))
    .attr("height", height)
    .style("max-width", "100%");

  // Keep CSS --label-gap in sync with the JS labelGap so pure-CSS spacing matches chart layout
  try{ document.querySelector('#chart svg')?.style.setProperty('--label-gap', `${labelGap}px`); }catch(e){}

  // NOTE: keep the right-side panel at a fixed top offset (CSS) —
  // avoid dynamic repositioning here so it does not appear to slide.

  svg.append("g")
    .attr("transform", `translate(0,${height - margin.bottom})`)
    .call(d3.axisBottom(x).ticks(6, "~s"))
    .call(sel => sel.selectAll("text").attr("fill","#cfcfcf").attr("font-size", isSmall? 11:13));
  svg.append("g")
    .attr("transform", `translate(${margin.left},0)`)
    .call(d3.axisLeft(y).tickSizeOuter(0))
    .call(sel => {
      // wrap long franchise names into two lines using tspans
      // Position tick text using explicit `x` so wrapping is consistent across browsers
      sel.selectAll("text")
        .attr("fill","#e6e6e6")
        .attr("font-size", isSmall? 12:14)
        .attr('text-anchor', "end")
        // make text positioning deterministic: set explicit x so tspans inherit a stable anchor
        // Use a negative x offset equal to `labelGap` so labels sit left of the axis tick.
        .attr('x', -labelGap)
        .each(function(d){
          const txt = String(d||"").trim();
          if (!txt) return;
          // measure text width and only wrap if it exceeds available label width
          const measured = ctx.measureText(txt).width;
          const avail = Math.max(60, margin.left - labelPadding - 20); // minimum sensible avail
          if (measured <= avail) { d3.select(this).text(txt).attr('x', -labelGap); return; }
          const words = txt.split(/\s+/);
          // choose split point that balances character counts
          let best = Math.ceil(words.length/2);
          let bestDiff = Infinity;
          for (let i=1;i<words.length;i++){
            const a = words.slice(0,i).join(' ').length;
            const b = words.slice(i).join(' ').length;
            const diff = Math.abs(a-b);
            if (diff < bestDiff){ bestDiff = diff; best = i; }
          }
          const line1 = words.slice(0,best).join(' ');
          const line2 = words.slice(best).join(' ');
          const el = d3.select(this).text('').attr('x', -labelGap);
          // first line: baseline at 0 (no vertical shift)
          el.append('tspan').attr('x', -labelGap).attr('dy', '0em').text(line1);
          // second line: place below using em units for consistent line-height
          el.append('tspan').attr('x', -labelGap).attr('dy', '1.15em').text(line2);
        });
    });

  // ========= Tooltip =========
  const tip = d3.select("#tooltip");
  let lastTipHtml = "";
  const showTip = (html, evt) => {
    if (!tip || !tip.node()) {
      console.warn('Tooltip element not found');
      return;
    }
    if (html !== lastTipHtml) {
      tip.html(html);
      lastTipHtml = html;
    }
    tip.style("display", "block")
       .style("opacity", "1")
       .style("left", (evt.clientX + 14) + "px")
       .style("top", (evt.clientY + 14) + "px");
  };
  const moveTip = (evt) => {
    // Only update position on frequent mousemove events
    if (tip && tip.node()) {
      tip.style("left", (evt.clientX + 14) + "px")
         .style("top", (evt.clientY + 14) + "px");
    }
  };
  const hideTip = () => {
    if (tip && tip.node()) {
      tip.style("display", "none").style("opacity", "0");
    }
    lastTipHtml = "";
  };

  // ========= Snippet panel =========
  const panel = d3.select("#episode-wall");
  // track pinned selection explicitly
  let pinnedFranchise = null;
  let pinnedSeason = null;

  function highlightText(text){
    return text.split(/(\b[^\W_]+\b)/g).map(tok=>{
      const w = tok.toLowerCase();
      const s = LEX.get(w) || 0;
      // Treat ±1 as strong enough to warrant bright highlighting per user request
      if (s >= 1)   return `<span class=\"hi-pos\">${tok}</span>`;
      if (s <= -1)  return `<span class=\"hi-neg\">${tok}</span>`;
      return tok;
    }).join("");
  }

  // Render brief metadata into the right-side panel (no full episode snippets here)
  function renderPanelMeta(franchise, season){
    // find season aggregate in DATA
    const frObj = DATA.find(f => f.franchise === franchise);
    const part = frObj?.parts?.find(p => +p.s === +season);
    const seasonView = part ? d3.format('.2s')(part.v) : '—';
    const key = `${normKey(franchise)}__${+season}`;
    const sent = SENT.get(key);
    const sVal = Number.isFinite(sent?.avg) ? +sent.avg : NaN;
    const label = Number.isFinite(sVal) ? sentimentLabel(sVal) : 'Unknown';

    // count available episode overviews (not rendered here)
    const epiCount = EPIS.length ? EPIS.filter(r => normKey(r.franchise)===normKey(franchise) && +r.season===+season && (r.overview||r.episode_overview)).length : 0;

    const html = [
      `<div style="font-weight:600;margin-bottom:8px">${franchise} — S${season}</div>`,
      `<div>Season viewing: <b>${seasonView}</b></div>`,
      `<div>Sentiment: <b>${label}</b> ${Number.isFinite(sVal) ? `(<span style="opacity:.85">${sVal>=0?'+':''}${d3.format('.2f')(sVal)}</span>)` : ''}</div>`,
      `<div>Episode overviews available: <b>${epiCount}</b></div>`,
      `<div style="margin-top:8px;color:#9a9a9a;font-size:12px">Episode details are shown in the inline season popup (click a season bar).</div>`
    ].join('');

    d3.select('#panel-snippets').html(html);
  }
  // ========= season popup =========
  let seasonPopup = null;
  function closeSeasonPopup(){
    if (seasonPopup){
      try{ seasonPopup._cleanup && seasonPopup._cleanup(); }catch(e){}
      seasonPopup.remove(); seasonPopup = null;
      try{ d3.selectAll('rect').classed('season-selected', false); }catch(e){}
    }
  }

  function createSeasonPopup(franchise, season, anchorEl, evt){
    closeSeasonPopup();
    // build popup container
    const rows = EPIS
      .filter(r => normKey(r.franchise)===normKey(franchise) && +r.season===+season)
      .map((r,i) => ({ i, title: r.name || r.title || (`Ep ${r.episode||i+1}`), text:(r.overview||r.episode_overview||""), score:(Number.isFinite(+r.score) ? +r.score : (Number.isFinite(+r.sentiment) ? +r.sentiment : NaN)) }));

    const popup = document.createElement('div');
    popup.className = 'season-popup';
    // basic styling (kept compact) — override with CSS if desired
    Object.assign(popup.style, {
      position: 'absolute',
      zIndex: 9999,
      background: '#0f0f10',
      color: '#e6e6e6',
      border: '1px solid rgba(255,255,255,0.06)',
      borderRadius: '6px',
      padding: '10px',
      boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
      minWidth: '320px',
      maxWidth: '680px',
      maxHeight: '60vh',
      overflow: 'auto',
      fontSize: '13px',
    });

    // ensure popup accepts pointer events so text selection and copying work reliably
    // interactive children (buttons/links) are already set to pointer-events:auto
    try{ popup.style.pointerEvents = 'auto'; }catch(e){}

    // header
    const hdr = document.createElement('div'); hdr.style.fontWeight='600'; hdr.style.marginBottom='8px';
    hdr.textContent = `${franchise} — S${season}`;
    popup.appendChild(hdr);

    // episodes container (horizontal wrap)
    const epRow = document.createElement('div');
    Object.assign(epRow.style, { display:'flex', flexWrap:'wrap', gap:'6px', marginBottom:'8px' });
    if (rows.length===0){
      const msg = document.createElement('div'); msg.textContent = 'No episode data available.'; popup.appendChild(msg);
    } else {
      // determine if this season has any episode-level sentiment values
      const hasEpisodeSentiment = rows.some(rr => Number.isFinite(rr.score));
      rows.forEach((r, idx)=>{
        const btn = document.createElement('button');
        btn.type='button';
        btn.textContent = r.title || `Ep ${idx+1}`;
        // default styling
        Object.assign(btn.style, { background:'transparent', color:'#e6e6e6', border:'1px solid rgba(255,255,255,0.06)', padding:'6px 8px', borderRadius:'4px', cursor:'pointer', fontSize:'12px' });
        // make this interactive even though the popup container lets clicks pass through
        try{ btn.style.pointerEvents = 'auto'; }catch(e){}
        // if season has episode-level sentiment, color each episode by its score
        if (hasEpisodeSentiment){
          const sc = Number.isFinite(r.score) ? r.score : 0;
          const fill = color(sc) || '#444';
          // compute simple luminance to pick readable text color
          try{
            const c = d3.color(fill);
            const lum = (0.299*(c.r||0) + 0.587*(c.g||0) + 0.114*(c.b||0));
            btn.style.background = fill;
            btn.style.color = lum > 160 ? '#111' : '#fff';
            btn.style.border = '1px solid rgba(255,255,255,0.06)';
          }catch(e){ btn.style.background = fill; }
        }
        btn.addEventListener('click', (ev)=>{
          ev.stopPropagation();
          // show overview below
          const ov = popup.querySelector('.season-popup-overview');
          const txt = r.text || 'No overview available.';
          if (ov) ov.innerHTML = `<div style="font-weight:600;margin-bottom:6px">${r.title}</div><div class=\"overview-body\">${highlightText(txt)}</div>`;
        });
        epRow.appendChild(btn);
      });
      popup.appendChild(epRow);

      const overview = document.createElement('div');
      overview.className = 'season-popup-overview';
      Object.assign(overview.style, { marginTop:'6px', paddingTop:'8px', borderTop:'1px solid rgba(255,255,255,0.03)', color:'#dcdcdc' });
      overview.innerHTML = '<div style="opacity:0.8">Select an episode to view its TMDB overview here.</div>';
      try{ overview.style.pointerEvents = 'auto'; }catch(e){}
      popup.appendChild(overview);
    }

    // append to chart container and position inline below the clicked bar
    chartEl.appendChild(popup);
    seasonPopup = popup;
    // prevent clicks inside the popup from closing it via body click handlers
    try{ popup.addEventListener('click', (e)=>{ e.stopPropagation(); }); }catch(e){}
    try{
      const rect = anchorEl.getBoundingClientRect();
      const chartRect = chartEl.getBoundingClientRect();
      // compute top relative to chart container so popup appears immediately below the bar
      const top = Math.round(rect.bottom - chartRect.top + 8 + (chartEl.scrollTop || 0));
      // align popup to chart left margin (use left margin computed in JS layout)
      const left = Math.max(8, margin.left + 6);
      // set style and sizing; allow popup to scroll internally if it's tall
      popup.style.position = 'absolute';
      popup.style.left = left + 'px';
      popup.style.top = top + 'px';
      popup.style.maxHeight = '60vh';
      popup.style.overflow = 'auto';
      // width: keep within chart area, subtract some padding
      const availW = Math.max(320, Math.min(chartRect.width - left - 16, 900));
      popup.style.width = availW + 'px';
    }catch(e){
      // fallback: position near top-left of chart
      popup.style.left = (margin.left + 12) + 'px'; popup.style.top = '12px';
    }

    // note: popup container has pointer-events disabled so clicks pass through to underlying chart.
    // interactive children (buttons/links) explicitly enable pointer-events so they remain usable.
    // allow closing via Escape
    const onKey = (ev)=>{ if (ev.key==='Escape') closeSeasonPopup(); };
    window.addEventListener('keydown', onKey);
    // close on scroll or resize to avoid stale positioning
    const onScrollResize = ()=> closeSeasonPopup();
    window.addEventListener('scroll', onScrollResize, true);
    window.addEventListener('resize', onScrollResize);
    // cleanup when removed
    popup._cleanup = ()=>{
      try{ window.removeEventListener('keydown', onKey); }catch(e){}
      try{ window.removeEventListener('scroll', onScrollResize, true); }catch(e){}
      try{ window.removeEventListener('resize', onScrollResize); }catch(e){}
    };
  }

  // ===== Center modal overlay (Netflix/YouTube style) =====

  function closeSeasonOverlay(){
    try{ document.getElementById('season-overlay').classList.remove('active'); }catch(e){}
    const modal = document.querySelector('#season-overlay .season-modal');
    if (modal){ try{ modal._cleanup && modal._cleanup(); }catch(e){}; modal.remove(); }
    // restore body scroll if it was prevented
    try{ document.body.style.overflow = ''; }catch(e){}
    try{ d3.selectAll('rect').classed('season-selected', false); }catch(e){}
  }

  function openSeasonOverlay(franchise, season){
    // remove any inline popups
    try{ closeSeasonPopup(); }catch(e){}
    closeSeasonOverlay();
    const root = document.getElementById('season-overlay');
    if (!root) return;
    root.classList.add('active');
    // prevent body scroll while modal is open
    document.body.style.overflow = 'hidden';

    const modal = document.createElement('div');
    modal.className = 'season-modal';

    // header
    const hdr = document.createElement('div'); hdr.className = 'modal-head';
    const title = document.createElement('div'); title.className = 'modal-title'; title.textContent = `${franchise} — S${season}`;
    const closeBtn = document.createElement('button'); closeBtn.className = 'modal-close'; closeBtn.innerHTML = '✕';
    closeBtn.addEventListener('click', (e)=>{ e.stopPropagation(); closeSeasonOverlay(); });
    hdr.appendChild(title); hdr.appendChild(closeBtn);
    modal.appendChild(hdr);

    // episodes row
    const rows = EPIS.filter(r => normKey(r.franchise)===normKey(franchise) && +r.season===+season)
      .map((r,i)=>({ i, id: r.episode || i+1, title: r.name||r.title||`Ep ${r.episode||i+1}`, text: r.overview||r.episode_overview||'', score:(Number.isFinite(+r.score) ? +r.score : (Number.isFinite(+r.sentiment) ? +r.sentiment : NaN)) }));
    // openSeasonOverlay: rows prepared (debug logging removed)
    const epRow = document.createElement('div'); epRow.className = 'ep-row';
    // color pills if any episode contains sentiment
    const hasEpisodeSentiment = rows.some(rr => Number.isFinite(rr.score));
    rows.forEach(r=>{
      const btn = document.createElement('button'); btn.className = 'ep-pill';
      // label only (chip removed per user request)
      const lbl = document.createElement('span'); lbl.textContent = r.title; btn.appendChild(lbl);
      if (hasEpisodeSentiment){
        const sc = Number.isFinite(r.score) ? r.score : 0;
        const fill = color(sc) || '#444';
        try{
          const c = d3.color(fill);
          const lum = (0.299*(c.r||0) + 0.587*(c.g||0) + 0.114*(c.b||0));
          btn.style.background = fill;
          btn.style.color = lum > 160 ? '#111' : '#fff';
        }catch(e){ btn.style.background = fill; }
      }
      btn.addEventListener('click', (ev)=>{
        ev.stopPropagation();
        // mark this pill as selected and clear others
        modal.querySelectorAll('.ep-pill.selected').forEach(x=>x.classList.remove('selected'));
        btn.classList.add('selected');
        const ov = modal.querySelector('.ep-overview');
        ov.innerHTML = `<div style="font-weight:600;margin-bottom:8px">${r.title}</div><div class=\"overview-body\">${highlightText(r.text || 'No overview available.')}</div>`;
      });
      epRow.appendChild(btn);
    });
    modal.appendChild(epRow);

    const ov = document.createElement('div'); ov.className = 'ep-overview'; ov.innerHTML = '<div style="opacity:0.85">Select an episode to view its TMDB overview here.</div>';
    modal.appendChild(ov);

    // backdrop click closes
    root.addEventListener('click', function onRootClick(ev){
      if (ev.target === root) { closeSeasonOverlay(); root.removeEventListener('click', onRootClick); }
    });

    // ESC closes
    const onKey = (ev)=>{ if (ev.key==='Escape') closeSeasonOverlay(); };
    window.addEventListener('keydown', onKey);
    modal._cleanup = ()=> window.removeEventListener('keydown', onKey);

    // prevent anchor navigation inside modal overviews
    modal.addEventListener('click', (e)=>{
      const a = e.target.closest && e.target.closest('a');
      if (a){ e.preventDefault(); e.stopPropagation(); }
    });

    root.appendChild(modal);
    // update right panel metadata too
    try{ renderPanelMeta(franchise, season); }catch(e){}
  }
  // keep checkbox behavior (if present) but do not hide the panel entirely — toggle handler removed (no #snipToggle in HTML)

DATA.forEach(d => {
  const cy = y(d.franchise);
  let acc = 0;
  
  d.parts.forEach(p => {
    const x0 = x(acc), x1 = x(acc + p.v), w = Math.max(0, x1 - x0);

    const key  = `${normKey(d.franchise)}__${+p.s}`;
    const sent = SENT.get(key);
    let sVal = Number.isFinite(sent?.avg) ? +sent.avg : 0;
    const fill = color(sVal) || "#c0c0c0";
    const label = sentimentLabel(sVal);

    svg.append("rect")
      .attr("x", x0).attr("y", cy + (y.bandwidth()-barH)/2)
      .attr("width", w).attr("height", barH)
      .attr("fill", fill)
      .attr("data-franchise", d.franchise)
      .style("cursor", "pointer")  // ← 클릭 가능 표시
      // ✅ 클릭: Episode Snippets 고정
      .on("click", (evt)=>{
        evt.stopPropagation();
        pinnedFranchise = d.franchise;
        pinnedSeason = p.s;
        // clear any previous visual selection first
        try{ d3.selectAll('rect').classed('season-selected', false); }catch(e){}
        // open the inline season popup (prefer inline over modal overlay)
        try{ createSeasonPopup(d.franchise, p.s, evt.currentTarget, evt); }catch(e){ console.warn(e); }
        // mark this season bar as selected and bring to front AFTER closing/creating popups
        try{ d3.select(evt.currentTarget).classed('season-selected', true).raise(); }catch(e){}
      })
      // ✅ Hover: 툴팁만 표시
      .on("mouseenter", (evt)=>{
        console.log('Season bar hover triggered for:', d.franchise, 'Season:', p.s);
        const sDisp = `${sVal>=0?"+":""}${d3.format(".2f")(sVal)}`;
        const seasonView = d3.format(".2s")(p.v);
        const html = `
          <div style="font-weight:600;margin-bottom:2px">${d.franchise}</div>
          <div>Season <b>S${p.s}</b> · Viewing <b>${seasonView}</b></div>
          <div>Sentiment <b>${label}</b> <span style="opacity:.85">(${sDisp})</span>${sent? (' · Episodes ' + sent.n) : ''}</div>
          <div>New <b>${d3.format(".0%")(d.latestShare)}</b> · Lib <b>${d3.format(".0%")(d.carryShare)}</b></div>`;
        console.log('Calling showTip with HTML:', html);
        showTip(html, evt);
        // show brief season metadata in the right panel while hovering (if not pinned)
        if (!pinnedFranchise && !pinnedSeason) {
          try{ renderPanelMeta(d.franchise, p.s); }catch(e){}
        }
      })
      .on("mousemove", (evt)=> moveTip(evt))
      .on("mouseleave", ()=>{ 
        hideTip(); 
        // clear panel metadata when not pinned (hover-only display)
        if (!pinnedFranchise && !pinnedSeason) d3.select('#panel-snippets').html('');
      });

    acc += p.v;
  });

  // Total
  svg.append("text")
    .attr("x", margin.left + width - 8)
    .attr("y", cy + y.bandwidth()/2)
    .attr("text-anchor","end")
    .attr("dominant-baseline","middle")
    .attr("font-size", isSmall? 10 : 11)
    .attr("fill","#a8a8a8")
    .text(d3.format(".2s")(d.total));
});
// ========= Global click handler to unpin selection =========
d3.select("body").on("click", (event)=>{
  // Unpin any pinned selection when clicking outside chart elements,
  // but keep the right panel visible and show the default instruction.
    if (pinnedFranchise || pinnedSeason) {
    pinnedFranchise = null;
    pinnedSeason = null;
    // clear right-panel metadata when nothing is pinned
    d3.select('#panel-snippets').html('');
    // close any open inline popup or overlay
    try{ closeSeasonPopup(); }catch(e){}
    try{ closeSeasonOverlay(); }catch(e){}
    try{ d3.selectAll('rect').classed('season-selected', false); }catch(e){}
  }
});

  // explanatory copy moved into right panel (index.html). No auto-insert into header.

  // ========= COUNTRY VIEW TOGGLE =========
  const toggleBtn = document.getElementById('toggle-country-btn');
  const chartContainer = document.getElementById('chart');

  // Create separate container for country view
  const countryChartContainer = document.createElement('div');
  countryChartContainer.id = 'country-chart-container';
  countryChartContainer.style.display = 'none';
  chartContainer.parentNode.insertBefore(countryChartContainer, chartContainer.nextSibling);

  // Store original franchise chart HTML on first render
  originalChartHTML = chartContainer.innerHTML;

  // Load country data
  async function loadCountryData() {
    if (countryData) return countryData;
    try {
      const response = await fetch('./data/country_segments_top5.json');
      if (!response.ok) {
        throw new Error(`Failed to load: ${response.status}`);
      }
      countryData = await response.json();
      console.log('Country data loaded:', countryData);
      return countryData;
    } catch (error) {
      console.error('Error loading country data:', error);
      throw error;
    }
  }

  // Render country bar chart
  async function renderCountryView() {
    try {
      const data = await loadCountryData();
      const countriesObj = data.countries;
      console.log('renderCountryView started, countries:', countriesObj);

      // Country code to full name mapping
      const countryNames = {
        'USA': 'United States',
        'KOR': 'South Korea',
        'GBR': 'United Kingdom',
        'JPN': 'Japan',
        'COL': 'Colombia',
        'ESP': 'Spain',
        'AUS': 'Australia',
        'CAN': 'Canada',
        'MEX': 'Mexico',
        'DEU': 'Germany'
      };

      // Convert object to array with code
      const countries = Object.keys(countriesObj)
        .map(code => ({
          code: code,
          name: countryNames[code] || code,
          total_views: countriesObj[code].total_views,
          weighted_sentiment: countriesObj[code].weighted_sentiment,
          total_titles: countriesObj[code].total_titles,
          segments: countriesObj[code].segments
        }));

      console.log('Countries array:', countries);

      countryChartContainer.innerHTML = '';

    // Get container width - account for padding and border
    const containerWidth = countryChartContainer.offsetWidth || 600;
    
    const rowHeight = 60;
    const totalHeight = rowHeight * countries.length;
    const leftMargin = 80;
    const rightMargin = 60;

    // Use the same color scale as franchise chart
    const sentPool = countries.map(d => d.weighted_sentiment).filter(Number.isFinite);
    const sSorted = sentPool.length ? [...sentPool].sort(d3.ascending) : [-0.5, -0.2, 0, 0.2, 0.5];
    const q05 = d3.quantileSorted(sSorted, 0.05);
    const q95 = d3.quantileSorted(sSorted, 0.95);
    const M = Math.max(Math.abs(q05), Math.abs(q95), 0.12);

    const stops = d3.interpolateRgbBasis([
      "#b2182b",  // strong negative (red)
      "#d87474",  // mild negative
      "#9aa0a6",  // neutral (gray)
      "#7ccf93",  // mild positive
      "#1a9850"   // strong positive (green)
    ]);

    const colorScale = d3.scaleDiverging(stops).domain([-M, 0, M]).clamp(true);

    // Sentiment color function
    function getSentimentColor(sentiment) {
      return colorScale(sentiment);
    }

    // SVG container
    const svg = d3.select('#country-chart-container')
      .append('svg')
      .attr('width', containerWidth)
      .attr('height', totalHeight + 40)
      .style('max-width', '100%')
      .append('g')
      .attr('transform', `translate(${leftMargin}, 20)`);

    const maxViews = d3.max(countries, d => d.total_views);
    const barWidth = containerWidth - leftMargin - rightMargin;

    // Tooltip
    const tooltip = document.getElementById('tooltip');

    // Render each country as a row
    const rows = svg.selectAll('.country-row')
      .data(countries)
      .enter()
      .append('g')
      .attr('class', 'country-row')
      .attr('transform', (d, i) => `translate(0, ${i * rowHeight})`);

    // Country label
    rows.append('text')
      .attr('class', 'country-label')
      .attr('x', -12)
      .attr('y', rowHeight / 2)
      .attr('dominant-baseline', 'middle')
      .attr('text-anchor', 'end')
      .attr('font-size', '14px')
      .attr('font-weight', '600')
      .attr('fill', '#d9d9d9')
      .text(d => d.code);

    // Bar
    rows.append('rect')
      .attr('class', 'country-bar')
      .attr('x', 0)
      .attr('y', rowHeight * 0.2)
      .attr('width', d => (d.total_views / maxViews) * barWidth)
      .attr('height', rowHeight * 0.6)
      .style('fill', d => getSentimentColor(d.weighted_sentiment))
      .style('stroke', 'rgba(255, 255, 255, 0.15)')
      .style('stroke-width', '1px')
      .style('cursor', 'pointer')
      .style('transition', 'all 0.15s')
      .on('mouseenter', function(event, d) {
        console.log('Bar hover triggered:', d);
        d3.select(this)
          .style('filter', 'brightness(1.2)')
          .style('stroke', 'rgba(255, 255, 255, 0.3)')
          .style('stroke-width', '1px');

        // Get top franchise for this country
        const countryInfo = data.countries[d.code];
        console.log('Country info:', countryInfo);
        let topFranchiseText = 'N/A';
        if (countryInfo && countryInfo.segments && countryInfo.segments.length > 0) {
          const topSegment = countryInfo.segments[0];
          topFranchiseText = `${topSegment.title} (${(topSegment.views / 1e6).toFixed(0)}M)`;
        }

        if (tooltip) {
          tooltip.innerHTML = `
            <strong>${d.name}</strong><br/>
            Views: ${(d.total_views / 1e9).toFixed(2)}B<br/>
            Titles: ${d.total_titles}<br/>
            Sentiment: ${d.weighted_sentiment.toFixed(3)}<br/>
            <br/>
            <em>Top franchise:</em><br/>
            ${topFranchiseText}
          `;
          tooltip.style.left = (event.pageX + 10) + 'px';
          tooltip.style.top = (event.pageY - 10) + 'px';
          tooltip.style.display = 'block';
          tooltip.style.opacity = '1';
        }
      })
      .on('mousemove', function(event) {
        if (tooltip) {
          tooltip.style.left = (event.pageX + 10) + 'px';
          tooltip.style.top = (event.pageY - 10) + 'px';
        }
      })
      .on('mouseleave', function() {
        d3.select(this)
          .style('filter', 'none')
          .style('stroke', 'none');
        if (tooltip) {
          tooltip.style.opacity = '0';
          tooltip.style.display = 'none';
        }
      });

    // Value label on bar
    rows.append('text')
      .attr('class', 'country-value')
      .attr('x', d => (d.total_views / maxViews) * barWidth + 6)
      .attr('y', rowHeight / 2)
      .attr('dominant-baseline', 'middle')
      .attr('font-size', '12px')
      .attr('fill', '#a8a8a8')
      .text(d => (d.total_views / 1e9).toFixed(1) + 'B');
    } catch (error) {
      console.error('Error rendering country view:', error);
      chartContainer.innerHTML = '<p style="color: #cc4c02; padding: 20px;">Error loading country data</p>';
    }
  }

  // Toggle handler
  toggleBtn.addEventListener('click', async () => {
    if (isCountryView) {
      // Switch back to franchise view - reload page to restore hover events
      window.location.reload();
      
    } else {
      // Switch to country view - show container FIRST before rendering
      chartContainer.style.display = 'none';
      countryChartContainer.style.display = 'block';
      
      // Render country chart if not already rendered
      if (!countryChartContainer.querySelector('svg')) {
        await renderCountryView();
      }
      
      // Update panel content for country view
      const panelTitle = document.getElementById('panel-title');
      const panelNote = document.querySelector('.panel-note');
      const panelRead = document.querySelector('#panel-read');
      
      if (panelTitle) panelTitle.textContent = 'Production by Country';
      if (panelNote) panelNote.textContent = 'Data: Top 10 production countries aggregated from What We Watched — A Netflix Engagement Report 2025 Jan - Jun. Mapped to production metadata from TMDB.';
      if (panelRead) panelRead.innerHTML = `
        <strong>How to read</strong>
        <p>Each row = country ranked by total viewing hours.</p>
        <p>Bar color = weighted average narrative sentiment of titles produced in that country.</p>
        <p>Hover = top franchise produced in that country.</p>
        <br/>
        <em style="color: #8f9498; font-size: 12px;">Note: "Production country" ≠ "consumption region". This shows where content is made, not where it's watched.</em>
      `;
      
      toggleBtn.classList.add('active');
      isCountryView = true;
      toggleBtn.textContent = '← Back to Franchises';
    }
  });

})();
