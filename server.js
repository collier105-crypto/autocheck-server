const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const VERSION = "V55";

/* =========================================================
   AUTOCHECK+ SERVER V51
   ========================================================= */

app.get("/", (_, res) => {
  res.json({ ok: true, app: "AutoCheck+", version: VERSION });
});

app.get("/health", (_, res) => {
  res.json({ ok: true, status: "online", version: VERSION });
});

function cleanText(s) {
  return String(s || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&euro;/gi, "€")
    .replace(/&#x20;/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function numberFrom(v) {
  if (v == null) return null;
  const digits = String(v).replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function sourceName(host) {
  if (host.includes("2ememain") || host.includes("2dehands")) return "2ememain";
  if (host.includes("autoscout24")) return "AutoScout24";
  if (host.includes("facebook")) return "Facebook Marketplace";
  if (host.includes("leboncoin")) return "Leboncoin";
  if (host.includes("gocar")) return "Gocar";
  return host || "Inconnue";
}

function normalizeWords(text) {
  return cleanText(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(word => word.length >= 2);
}

function meta(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const r1 = new RegExp(
    `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`,
    "i"
  );
  const r2 = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`,
    "i"
  );
  return (html.match(r1) || html.match(r2) || [])[1] || "";
}

function findVehicleJsonLd(html) {
  const blocks = [
    ...String(html || "").matchAll(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    )
  ];

  function inspect(obj) {
    if (!obj || typeof obj !== "object") return null;
    if (
      obj.brand ||
      obj.model ||
      obj.vehicleConfiguration ||
      obj.mileageFromOdometer ||
      obj.offers
    ) return obj;

    if (Array.isArray(obj["@graph"])) {
      for (const item of obj["@graph"]) {
        const found = inspect(item);
        if (found) return found;
      }
    }
    return null;
  }

  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block[1]);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const found = inspect(item);
          if (found) return found;
        }
      } else {
        const found = inspect(parsed);
        if (found) return found;
      }
    } catch {}
  }
  return null;
}


function detectPowertrain(text) {
  const t = cleanText(text || "").toLowerCase().replace(/[-_/]/g, " ");
  let fuel = "";
  if (/\b(diesel|tdi|hdi|dci|cdti|crdi|jtd|multijet)\b/i.test(t)) fuel = "Diesel";
  else if (/\b(essence|benzine|petrol|tsi|tfsi|mpi|fsi)\b/i.test(t)) fuel = "Essence";

  let engine = "";
  const m = t.match(/\b([0-9][.,][0-9])\s*(?:l|litre|liter|tdi|tsi|tfsi|hdi|dci|cdti|crdi|jtd|diesel|essence|benzine)?\b/i);
  if (m) {
    const n = Number(m[1].replace(",", "."));
    if (n >= 0.8 && n <= 8.0) engine = n.toFixed(1);
  }
  return { fuel, engine };
}

function normalizeVehicle(ld, html) {
  ld = ld || {};
  const offers = Array.isArray(ld.offers) ? ld.offers[0] || {} : ld.offers || {};
  const brand = typeof ld.brand === "object" ? ld.brand?.name : ld.brand;
  const title = ld.name || meta(html, "og:title") || "";
  const description = ld.description || meta(html, "og:description") || "";
  const blob = cleanText(`${title} ${description}`);

  const model =
    cleanText([brand, ld.model || ld.vehicleConfiguration].filter(Boolean).join(" ")) ||
    cleanText(title);

  const year =
    numberFrom(ld.vehicleModelDate) ||
    numberFrom((blob.match(/\b(?:19|20)\d{2}\b/) || [])[0]);

  const km =
    numberFrom(ld.mileageFromOdometer?.value) ||
    numberFrom((blob.match(/([\d .]{2,})\s*km\b/i) || [])[1]);

  const price =
    numberFrom(offers.price) ||
    numberFrom(
      (blob.match(/(?:€|EUR)\s*([\d .]+)|([\d .]+)\s*(?:€|EUR)/i) || [])
        .slice(1)
        .find(Boolean)
    );

  const detected = detectPowertrain(`${title} ${description}`);
  return {
    model,
    year,
    km,
    price,
    fuel: cleanText(ld.fuelType || detected.fuel || ""),
    engine: detected.engine,
    power: cleanText(ld.vehicleEngine?.enginePower?.value || ""),
    gearbox: cleanText(ld.vehicleTransmission || ""),
    title: cleanText(title),
    description: cleanText(description)
  };
}

/* V44 : détection indicative de défauts dans le texte public de l'annonce.
   Les montants sont des réserves estimatives, pas des devis. */
function detectDefects(text) {
  const t = cleanText(text || "").toLowerCase();
  const rules = [
    { re: /(vliegwiel|volant moteur|dual mass|bi[- ]?masse)/i, label: "Volant moteur", min: 800, max: 1500 },
    { re: /(koppeling|embrayage|clutch)/i, label: "Embrayage", min: 650, max: 1200 },
    { re: /(turbo).*(defect|kapot|bruit|noise|probleem|probl[eè]me|hs)|(?:defect|kapot|hs).*(turbo)/i, label: "Turbo à contrôler", min: 700, max: 1500 },
    { re: /(roetfilter|fap|dpf).*(defect|verstopt|bouch|probleem|probl[eè]me|hs)|(?:defect|verstopt|bouch|hs).*(roetfilter|fap|dpf)/i, label: "FAP/DPF à contrôler", min: 400, max: 1400 },
    { re: /(distributie|distribution).*(te doen|à faire|vervangen|remplacer|urgent)/i, label: "Distribution", min: 500, max: 900 },
    { re: /(carrosserieschade|schade carrosserie|d[eé]g[aâ]ts? carrosserie|carrosserie.*endommag)/i, label: "Dégâts carrosserie", min: 300, max: 1200 },
    { re: /(dakhemel.*los|hemelbekleding.*los|ciel de toit.*d[eé]coll)/i, label: "Ciel de toit", min: 150, max: 400 },
    { re: /(motor.*maakt geluid|moteur.*bruit|engine.*noise)/i, label: "Bruit moteur à diagnostiquer", min: 300, max: 1500 }
  ];
  const found = [];
  for (const r of rules) {
    if (r.re.test(t) && !found.some(x => x.label === r.label)) {
      found.push({ label: r.label, min: r.min, max: r.max, estimate: Math.round((r.min + r.max) / 2 / 50) * 50 });
    }
  }
  return found;
}

async function fetchPage(url, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",
        "accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "fr-BE,fr;q=0.9,nl;q=0.8,en;q=0.7",
        "cache-control": "no-cache"
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================
   ANALYSE D'UNE ANNONCE
   ========================================================= */

app.post("/api/analyse", async (req, res) => {
  const url = req.body?.url?.trim();

  if (!url) {
    return res.status(400).json({ ok: false, error: "Lien d'annonce manquant" });
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ ok: false, error: "Lien invalide" });
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return res.status(400).json({ ok: false, error: "Protocole non autorisé" });
  }

  const host = hostOf(url);

  try {
    const html = await fetchPage(url);
    const ld = findVehicleJsonLd(html);
    const data = normalizeVehicle(ld, html);
    const defects = detectDefects(`${data.title || ""} ${data.description || ""}`);
    const repair_estimate = defects.reduce((sum, x) => sum + (x.estimate || 0), 0);
    const extracted = !!(data.model || data.year || data.km || data.price);

    return res.json({
      ok: true,
      version: VERSION,
      source: sourceName(host),
      source_host: host,
      source_url: url,
      ...data,
      defects,
      repair_estimate,
      market_value: null,
      comparables: [],
      extraction_status: extracted ? "extracted" : "no_public_data",
      message: extracted
        ? "Données publiques récupérées."
        : "Aucune donnée structurée exploitable."
    });
  } catch (e) {
    return res.json({
      ok: true,
      version: VERSION,
      source: sourceName(host),
      source_host: host,
      source_url: url,
      model: "",
      year: null,
      km: null,
      price: null,
      fuel: "",
      power: "",
      gearbox: "",
      market_value: null,
      comparables: [],
      extraction_status: "blocked_or_unavailable",
      message: `Lecture impossible : ${e.message}`
    });
  }
});

function make2ememainSearch(model, target = {}) {
  let query = cleanText(model).replace(/\b\d{4}\b/g, "").replace(/\s+/g, " ").trim();
  if (!query) return null;
  if (target.engine && !query.toLowerCase().includes(String(target.engine).toLowerCase())) query += ` ${target.engine}`;
  if (String(target.fuel || "").toLowerCase().includes("diesel") && !/\b(tdi|diesel)\b/i.test(query)) query += " TDI";
  return (
    "https://www.2ememain.be/l/autos/q/" +
    encodeURIComponent(query).replace(/%20/g, "%2B") +
    "/"
  );
}

function extractLinks2ememain(html) {
  const links = [];
  const seen = new Set();
  const regex = /href=["']([^"']+)["']/gi;
  let match;

  while ((match = regex.exec(html))) {
    let href = String(match[1] || "")
      .replace(/&amp;/g, "&")
      .replace(/\\u002F/g, "/")
      .replace(/\\u0026/g, "&");

    if (!href.includes("/v/") && !href.includes("/a/")) continue;

    try {
      const full = new URL(href, "https://www.2ememain.be").href;
      if (seen.has(full)) continue;
      seen.add(full);
      links.push(full);
    } catch {}
  }
  return links;
}

function extract2ememain(html, target, limit) {
  const results = [];
  const seen = new Set();

  const text = String(html || "")
    .replace(/\\u20ac/gi, "€")
    .replace(/\\u002F/gi, "/")
    .replace(/\\u0026/gi, "&")
    .replace(/&euro;/gi, "€")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#x20;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\r|\n|\t/g, " ")
    .replace(/\s+/g, " ");

  function addResult(title, price, year, km, url = "") {
    title = cleanText(title)
      .replace(/Sauvegarder dans Mes Favoris/gi, "")
      .replace(/Image:/gi, "")
      .replace(/Détails/gi, "")
      .trim();

    price = numberFrom(price);
    year = numberFrom(year);
    km = numberFrom(km);

    if (!price || price < 250 || price > 200000) return;
    if (!year || year < 1980 || year > new Date().getFullYear() + 1) return;
    if (!km || km < 500 || km > 700000) return;

    const key = `${price}-${year}-${km}`;
    if (seen.has(key)) return;
    seen.add(key);

    results.push({ site: "2ememain", title, price, year, km, url });
  }

  const pattern1 =
    /(.{8,350}?)€\s*([\d.\s]+)(?:,-)?.{0,400}?\b((?:19|20)\d{2})\b.{0,250}?([\d.\s]+)\s*km/gi;
  let match;

  while ((match = pattern1.exec(text)) && results.length < 400) {
    addResult(match[1], match[2], match[3], match[4]);
  }

  const pattern2 =
    /(.{8,350}?)\b((?:19|20)\d{2})\b.{0,250}?([\d.\s]+)\s*km.{0,400}?€\s*([\d.\s]+)(?:,-)?/gi;

  while ((match = pattern2.exec(text)) && results.length < 450) {
    addResult(match[1], match[4], match[2], match[3]);
  }

  const blocks = text.split(/(?=€\s*[\d.\s]+(?:,-)?)/i);

  for (const block of blocks) {
    if (results.length >= 500) break;
    const p = block.match(/€\s*([\d.\s]+)(?:,-)?/i);
    const y = block.match(/\b((?:19|20)\d{2})\b/);
    const k = block.match(/([\d.\s]+)\s*km\b/i);
    if (!p || !y || !k) continue;
    addResult(block.substring(0, 300), p[1], y[1], k[1]);
  }

  return rankComparables(results, target, limit);
}

function comparableFromPage(html, url) {
  const ld = findVehicleJsonLd(html);
  const data = normalizeVehicle(ld, html);

  if (!data.price || !data.year || !data.km) return null;

  const pt = detectPowertrain(`${data.title || ""} ${data.description || ""} ${url || ""}`);
  return {
    site: "2ememain",
    title: data.title || data.model || cleanText(meta(html, "og:title")),
    model: data.model,
    description: data.description || "",
    price: data.price,
    year: data.year,
    km: data.km,
    fuel: data.fuel || pt.fuel,
    engine: data.engine || pt.engine,
    power: data.power || "",
    gearbox: data.gearbox,
    url
  };
}

function rankComparables(items, target, limit) {
  const seen = new Set();
  const unique = [];

  for (const item of items) {
    if (!item || !item.price || !item.year || !item.km) continue;

    const cleanUrl = String(item.url || "").split("?")[0].replace(/\/$/, "").toLowerCase();
    const key = cleanUrl || `${item.price}-${item.year}-${item.km}`;

    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({ ...item });
  }

  const targetWords = normalizeWords(target.model);

  for (const item of unique) {
    const itemText = normalizeWords(`${item.title || ""} ${item.model || ""}`);
    let matchingWords = 0;

    for (const word of targetWords) {
      if (itemText.includes(word)) matchingWords++;
    }

    const yearDifference = target.year ? Math.abs(item.year - target.year) : 0;
    const kmDifference = target.km ? Math.abs(item.km - target.km) : 0;

    const pt = detectPowertrain(`${item.title || ""} ${item.description || ""} ${item.url || ""} ${item.fuel || ""} ${item.engine || ""}`);
    item.fuel = item.fuel || pt.fuel;
    item.engine = item.engine || pt.engine;

    const targetFuel = String(target.fuel || "").toLowerCase();
    const itemFuel = String(item.fuel || "").toLowerCase();
    const fuelMatch = !!(targetFuel && itemFuel && targetFuel === itemFuel);
    const fuelConflict = !!(targetFuel && itemFuel && targetFuel !== itemFuel);
    const engineMatch = !!(target.engine && item.engine && String(target.engine) === String(item.engine));
    const engineConflict = !!(target.engine && item.engine && String(target.engine) !== String(item.engine));

    let score = yearDifference * 25000 + kmDifference - matchingWords * 150000;
    if (fuelMatch) score -= 180000;
    if (engineMatch) score -= 260000;
    if (fuelConflict) score += 500000;
    if (engineConflict) score += 650000;

    item.powertrain_match =
      fuelMatch && engineMatch ? "exact" :
      (fuelMatch || engineMatch) && !fuelConflict && !engineConflict ? "partial" :
      (fuelConflict || engineConflict) ? "conflict" : "unknown";
    item._matchingWords = matchingWords;
    item._score = score;
  }

  let candidates = unique.filter(
    item => item._matchingWords >= Math.min(2, targetWords.length)
  );

  if (candidates.length < 5) {
    candidates = unique.filter(item => item._matchingWords >= 1);
  }

  if (!candidates.length) candidates = unique;

  let filtered = candidates.filter(item => {
    if (target.year && Math.abs(item.year - target.year) > 7) return false;
    if (
      target.km &&
      Math.abs(item.km - target.km) > Math.max(170000, target.km * 1.0)
    ) return false;
    return true;
  });

  if (!filtered.length) filtered = candidates;

  const compatible = filtered.filter(item => item.powertrain_match !== "conflict");
  if (compatible.length >= 3) filtered = compatible;

  filtered.sort((a, b) => a._score - b._score);

  return filtered.slice(0, limit).map(item => {
    delete item._score;
    delete item._matchingWords;
    return item;
  });
}

function median(values) {
  const numbers = values
    .filter(n => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);

  if (!numbers.length) return null;
  const middle = Math.floor(numbers.length / 2);
  if (numbers.length % 2) return numbers[middle];
  return Math.round((numbers[middle - 1] + numbers[middle]) / 2);
}

function average(values) {
  const numbers = values.filter(n => Number.isFinite(n) && n > 0);
  if (!numbers.length) return null;
  return Math.round(numbers.reduce((sum, n) => sum + n, 0) / numbers.length);
}

/* =========================================================
   RECHERCHE MULTI-SITES V55
   - jusqu'à 30 résultats renvoyés
   - jusqu'à 40 pages d'annonces individuelles vérifiées
   - concurrence limitée pour éviter un traitement trop long
   ========================================================= */

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (true) {
      const i = index++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch {
        results[i] = null;
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );

  await Promise.all(workers);
  return results.filter(Boolean);
}

function targetQueries(target) {
  const base=cleanText(target.model||"");
  const e=cleanText(target.engine||"");
  const diesel=String(target.fuel||"").toLowerCase().includes("diesel");
  const y=target.year||"";
  const qs=[
    [base,e,diesel?"TDI":"",y].filter(Boolean).join(" "),
    [base,e,diesel?"TDI":""].filter(Boolean).join(" "),
    [base.replace(/\bVolkswagen\b/i,"").trim(),e,diesel?"TDI":"",y].filter(Boolean).join(" ")
  ];
  // Golf 6 / Golf VI aliases when the source URL/model exposes the generation.
  const raw=`${base} ${target.source_url||""}`.toLowerCase();
  if(/\bgolf[\s_-]*6\b/.test(raw) || /\bgolf[\s_-]*vi\b/.test(raw)){
    qs.push(["Volkswagen Golf 6",e,diesel?"TDI":"",y].filter(Boolean).join(" "));
    qs.push(["Volkswagen Golf VI",e,diesel?"TDI":""].filter(Boolean).join(" "));
  }
  return [...new Set(qs.map(cleanText).filter(Boolean))];
}

async function search2ememain(target, limit) {
  const queries=targetQueries(target);
  const pages=await mapWithConcurrency(queries,3,async q=>{
    const searchUrl=make2ememainSearch(q,{});
    const html=await fetchPage(searchUrl,15000);
    return {q,searchUrl,html};
  });
  let merged=[], urls=[], links=[];
  for(const p of pages){
    urls.push(p.searchUrl);
    merged.push(...extract2ememain(p.html,target,Math.max(limit,30)));
    links.push(...extractLinks2ememain(p.html));
  }
  links=[...new Set(links)].slice(0,60);
  const detailed=await mapWithConcurrency(links,5,async link=>{
    const detailHtml=await fetchPage(link,10000);
    const c=comparableFromPage(detailHtml,link);
    if(c)c.site="2ememain";
    return c;
  });
  merged.push(...detailed);
  return {searchUrl:urls,comparables:rankComparables(merged,target,limit),queries};
}

function slugifyPart(v) {
  return cleanText(v || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function makeAutoScoutSearch(target) {
  const parts = cleanText(target.model).split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  const make = slugifyPart(parts[0]);
  const model = slugifyPart(parts.slice(1).join("-"));
  let variant = "";
  if (target.engine && String(target.fuel || "").toLowerCase().includes("diesel")) {
    variant = `/ve_${String(target.engine).replace(".", "-")}-tdi`;
  }
  return `https://www.autoscout24.be/fr/lst/${make}/${model}${variant}`;
}

function extractLinksByHost(html, base, pathNeedle) {
  const links=[],seen=new Set(),rx=/href=["']([^"']+)["']/gi;
  let m;
  while((m=rx.exec(String(html||"")))){
    let href=String(m[1]||"").replace(/&amp;/g,"&").replace(/\\u002F/g,"/");
    if(!href.includes(pathNeedle)) continue;
    try{
      const u=new URL(href,base).href;
      if(!seen.has(u)){seen.add(u);links.push(u)}
    }catch{}
  }
  return links;
}

function comparableFromGenericPage(html, url, site) {
  const ld=findVehicleJsonLd(html);
  const data=normalizeVehicle(ld,html);
  if(!data.price || !data.year || !data.km) return null;
  const pt=detectPowertrain(`${data.title||""} ${data.description||""} ${url||""}`);
  return {
    site,
    title:data.title||data.model||cleanText(meta(html,"og:title")),
    model:data.model,
    description:data.description||"",
    price:data.price, year:data.year, km:data.km,
    fuel:data.fuel||pt.fuel, engine:data.engine||pt.engine,
    power:data.power||"", gearbox:data.gearbox||"", url
  };
}

async function searchAutoScout(target, limit) {
  const urls=[];
  const direct=makeAutoScoutSearch(target); if(direct)urls.push(direct);
  for(const q of targetQueries(target)) urls.push(`https://www.autoscout24.be/fr/lst?search=${encodeURIComponent(q)}`);
  const pages=await mapWithConcurrency([...new Set(urls)],3,async searchUrl=>({searchUrl,html:await fetchPage(searchUrl,15000)}));
  let links=[];
  for(const p of pages) links.push(...extractLinksByHost(p.html,"https://www.autoscout24.be","/offres/"),...extractLinksByHost(p.html,"https://www.autoscout24.be","/aanbod/"));
  links=[...new Set(links)].slice(0,50);
  const detailed=await mapWithConcurrency(links,4,async link=>{
    const h=await fetchPage(link,10000);
    return comparableFromGenericPage(h,link,"AutoScout24");
  });
  return {searchUrl:pages.map(p=>p.searchUrl),comparables:rankComparables(detailed,target,limit),queries:targetQueries(target)};
}

function makeGocarSearch(target){
  const q=[target.model,target.engine,String(target.fuel||"").toLowerCase().includes("diesel")?"TDI":""]
    .filter(Boolean).join(" ");
  return `https://gocar.be/fr/voitures?search=${encodeURIComponent(q)}`;
}

async function searchGocar(target, limit){
  const urls=targetQueries(target).map(q=>`https://gocar.be/fr/voitures?search=${encodeURIComponent(q)}`);
  const pages=await mapWithConcurrency([...new Set(urls)],3,async searchUrl=>({searchUrl,html:await fetchPage(searchUrl,15000)}));
  let links=[];
  for(const p of pages) links.push(...extractLinksByHost(p.html,"https://gocar.be","/fr/voitures/"));
  links=[...new Set(links)].slice(0,40);
  const detailed=await mapWithConcurrency(links,4,async link=>{
    const h=await fetchPage(link,10000);
    return comparableFromGenericPage(h,link,"Gocar");
  });
  return {searchUrl:pages.map(p=>p.searchUrl),comparables:rankComparables(detailed,target,limit),queries:targetQueries(target)};
}

/* =========================================================
   API COMPARABLES V55
   ========================================================= */

app.post("/api/comparables", async (req, res) => {
  const { model, year, km, price, limit, url, fuel, engine } = req.body || {};

  if (!model) {
    return res.status(400).json({
      ok: false,
      error: "Le modèle est nécessaire pour rechercher les comparables."
    });
  }

  const maxResults = Math.min(
    Math.max(Number(limit) || 30, 1),
    30
  );

  const targetPt = detectPowertrain(`${model || ""} ${url || ""} ${fuel || ""} ${engine || ""}`);
  const target = {
    model: cleanText(model),
    year: numberFrom(year),
    km: numberFrom(km),
    price: numberFrom(price),
    fuel: cleanText(fuel || targetPt.fuel || ""),
    engine: cleanText(engine || targetPt.engine || ""),
    source_url: cleanText(url || "")
  };

  try {
    const settled = await Promise.allSettled([
      search2ememain(target, maxResults),
      searchAutoScout(target, maxResults),
      searchGocar(target, maxResults)
    ]);

    const names=["2ememain","AutoScout24","Gocar"];
    const providerStatus={};
    let merged=[];
    const searchUrls={};

    settled.forEach((r,i)=>{
      if(r.status==="fulfilled"){
        providerStatus[names[i]]={ok:true,count:r.value.comparables.length,queries:r.value.queries||[]};
        searchUrls[names[i]]=r.value.searchUrl;
        merged.push(...r.value.comparables);
      }else{
        providerStatus[names[i]]={ok:false,count:0,error:String(r.reason?.message||r.reason||"indisponible")};
      }
    });

    const comparables=rankComparables(merged,target,maxResults);
    const prices=comparables.map(item=>item.price).filter(Boolean);
    const medianValue=median(prices), averageValue=average(prices);

    return res.json({
      ok:true, version:VERSION, vehicle:target,
      provider:"multi-sites",
      providers:providerStatus,
      search_urls:searchUrls,
      requested_results:maxResults,
      results_count:comparables.length,
      comparables,
      market_value:medianValue,
      median_value:medianValue,
      average_value:averageValue,
      confidence:comparables.length>=5?"good":comparables.length>=3?"medium":"low",
      search_status:comparables.length?"results_found":"no_results",
      message:comparables.length
        ? `${comparables.length} comparable(s) multi-sites trouvé(s).`
        : "Aucun comparable exploitable trouvé sur les sources disponibles."
    });
  } catch (e) {
    return res.json({
      ok:true, version:VERSION, vehicle:target, provider:"multi-sites",
      requested_results:maxResults, results_count:0, comparables:[],
      market_value:null, median_value:null, average_value:null,
      confidence:"none", search_status:"provider_unavailable",
      message:`Recherche multi-sites indisponible : ${e.message}`
    });
  }
});

/* =========================================================
   SERVEUR
   ========================================================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`AutoCheck+ ${VERSION} server ready on ${PORT}`);
});
