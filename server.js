const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const VERSION = "V35";

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

function sourceName(h) {
  if (h.includes("2ememain") || h.includes("2dehands"))
    return "2ememain";
  if (h.includes("autoscout24"))
    return "AutoScout24";
  if (h.includes("facebook"))
    return "Facebook Marketplace";
  if (h.includes("leboncoin"))
    return "Leboncoin";
  if (h.includes("gocar"))
    return "Gocar";

  return h || "Inconnue";
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
    ...html.matchAll(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    )
  ];

  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block[1]);

      const inspect = obj => {
        if (!obj || typeof obj !== "object") return null;

        if (
          obj.brand ||
          obj.model ||
          obj.vehicleConfiguration ||
          obj.mileageFromOdometer ||
          obj.offers
        ) {
          return obj;
        }

        if (Array.isArray(obj["@graph"])) {
          for (const x of obj["@graph"]) {
            const found = inspect(x);
            if (found) return found;
          }
        }

        return null;
      };

      if (Array.isArray(parsed)) {
        for (const x of parsed) {
          const found = inspect(x);
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

function normalizeVehicle(ld, html) {
  ld = ld || {};

  const offers = Array.isArray(ld.offers)
    ? ld.offers[0] || {}
    : ld.offers || {};

  const brand =
    typeof ld.brand === "object"
      ? ld.brand?.name
      : ld.brand;

  const title =
    ld.name ||
    meta(html, "og:title") ||
    "";

  const description =
    ld.description ||
    meta(html, "og:description") ||
    "";

  const blob = cleanText(`${title} ${description}`);

  const model =
    cleanText(
      [
        brand,
        ld.model || ld.vehicleConfiguration
      ].filter(Boolean).join(" ")
    ) || cleanText(title);

  const year =
    numberFrom(ld.vehicleModelDate) ||
    numberFrom((blob.match(/\b(?:19|20)\d{2}\b/) || [])[0]);

  const km =
    numberFrom(ld.mileageFromOdometer?.value) ||
    numberFrom(
      (blob.match(/([\d .]{2,})\s*km\b/i) || [])[1]
    );

  const price =
    numberFrom(offers.price) ||
    numberFrom(
      (
        blob.match(
          /(?:€|EUR)\s*([\d .]+)|([\d .]+)\s*(?:€|EUR)/i
        ) || []
      ).slice(1).find(Boolean)
    );

  return {
    model,
    year,
    km,
    price,
    fuel: cleanText(ld.fuelType || ""),
    power: cleanText(ld.vehicleEngine?.enginePower?.value || ""),
    gearbox: cleanText(ld.vehicleTransmission || "")
  };
}

async function fetchPage(url, timeout = 12000) {
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
        "accept-language":
          "fr-BE,fr;q=0.9,nl;q=0.8,en;q=0.7",
        "cache-control": "no-cache"
      }
    });

    if (!response.ok)
      throw new Error(`HTTP ${response.status}`);

    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/* =========================
   ANALYSE ANNONCE
   ========================= */

app.post("/api/analyse", async (req, res) => {
  const url = req.body?.url?.trim();

  if (!url)
    return res.status(400).json({
      ok: false,
      error: "Lien d'annonce manquant"
    });

  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({
      ok: false,
      error: "Lien invalide"
    });
  }

  if (!["http:", "https:"].includes(parsed.protocol))
    return res.status(400).json({
      ok: false,
      error: "Protocole non autorisé"
    });

  const host = hostOf(url);

  try {
    const html = await fetchPage(url);
    const ld = findVehicleJsonLd(html);
    const data = normalizeVehicle(ld, html);

    const extracted = !!(
      data.model ||
      data.year ||
      data.km ||
      data.price
    );

    return res.json({
      ok: true,
      version: VERSION,
      source: sourceName(host),
      source_host: host,
      source_url: url,
      ...data,
      market_value: null,
      comparables: [],
      extraction_status:
        extracted ? "extracted" : "no_public_data",
      message:
        extracted
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
      message:
        `Lecture impossible : ${e.message}`
    });
  }
});

/* =========================
   2EMEMAIN
   ========================= */

function make2ememainSearch(model) {
  let query = cleanText(model);

  query = query
    .replace(/\b\d{4}\b/g, "")
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:tdi|cdti|hdi|dci|tsi|tfsi)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!query)
    return null;

  return (
    "https://www.2ememain.be/l/autos/q/" +
    encodeURIComponent(query).replace(/%20/g, "%2B") +
    "/"
  );
}

function extract2ememain(html, target, limit) {
  const results = [];
  const seen = new Set();

  /*
    Les résultats 2ememain peuvent apparaître
    dans le HTML et/ou dans des données JSON
    embarquées. On inspecte d'abord les blocs
    contenant prix + année + kilométrage.
  */

  const text = html
    .replace(/\\u20ac/gi, "€")
    .replace(/\\u002F/gi, "/")
    .replace(/\\u0026/gi, "&")
    .replace(/&euro;/gi, "€");

  const patterns = [
    /(.{0,220}?)(?:€|EUR)\s*([\d., ]{3,12}).{0,100}?\b((?:19|20)\d{2})\b.{0,100}?([\d., ]{2,12})\s*km/gis,

    /(.{0,220}?)\b((?:19|20)\d{2})\b.{0,100}?([\d., ]{2,12})\s*km.{0,100}?(?:€|EUR)\s*([\d., ]{3,12})/gis
  ];

  for (let pi = 0; pi < patterns.length; pi++) {
    const re = patterns[pi];

    let m;

    while ((m = re.exec(text)) && results.length < limit * 4) {
      let title;
      let price;
      let year;
      let km;

      if (pi === 0) {
        title = cleanText(m[1]);
        price = numberFrom(m[2]);
        year = numberFrom(m[3]);
        km = numberFrom(m[4]);
      } else {
        title = cleanText(m[1]);
        year = numberFrom(m[2]);
        km = numberFrom(m[3]);
        price = numberFrom(m[4]);
      }

      if (
        !price ||
        price < 200 ||
        price > 250000 ||
        !year ||
        year < 1980 ||
        year > new Date().getFullYear() + 1 ||
        !km ||
        km > 1000000
      ) continue;

      title = title
        .replace(/Sauvegarder dans Mes Favoris/gi, "")
        .replace(/Image:/gi, "")
        .trim();

      if (title.length > 160)
        title = title.slice(-160);

      const key = `${price}-${year}-${km}`;

      if (seen.has(key))
        continue;

      seen.add(key);

      results.push({
        site: "2ememain",
        title,
        price,
        year,
        km,
        url: ""
      });
    }
  }

  /*
    Filtrage année / kilométrage.
    On commence assez large afin de ne pas
    éliminer tous les résultats.
  */

  let filtered = results.filter(x => {
    if (target.year && Math.abs(x.year - target.year) > 4)
      return false;

    if (
      target.km &&
      Math.abs(x.km - target.km) >
        Math.max(80000, target.km * 0.65)
    )
      return false;

    return true;
  });

  if (!filtered.length)
    filtered = results;

  filtered.sort((a, b) => {
    let sa = 0;
    let sb = 0;

    if (target.year) {
      sa += Math.abs(a.year - target.year) * 15000;
      sb += Math.abs(b.year - target.year) * 15000;
    }

    if (target.km) {
      sa += Math.abs(a.km - target.km);
      sb += Math.abs(b.km - target.km);
    }

    return sa - sb;
  });

  return filtered.slice(0, limit);
}

function median(values) {
  const a = values
    .filter(Boolean)
    .sort((x, y) => x - y);

  if (!a.length)
    return null;

  const middle = Math.floor(a.length / 2);

  return a.length % 2
    ? a[middle]
    : Math.round((a[middle - 1] + a[middle]) / 2);
}

/* =========================
   COMPARABLES V35
   ========================= */

app.post("/api/comparables", async (req, res) => {
  const {
    model,
    year,
    km,
    price,
    limit
  } = req.body || {};

  if (!model)
    return res.status(400).json({
      ok: false,
      error:
        "Le modèle du véhicule est nécessaire pour rechercher les comparables."
    });

  const maxResults = Math.min(
    Math.max(Number(limit) || 10, 1),
    10
  );

  const searchUrl = make2ememainSearch(model);

  if (!searchUrl)
    return res.status(400).json({
      ok: false,
      error: "Recherche impossible."
    });

  const target = {
    model: cleanText(model),
    year: numberFrom(year),
    km: numberFrom(km),
    price: numberFrom(price)
  };

  try {
    const html = await fetchPage(searchUrl);

    const comparables = extract2ememain(
      html,
      target,
      maxResults
    );

    const marketValue = median(
      comparables.map(x => x.price)
    );

    return res.json({
      ok: true,
      version: VERSION,

      vehicle: target,

      provider: "2ememain",
      search_url: searchUrl,

      requested_results: maxResults,

      comparables,

      market_value: marketValue,

      search_status:
        comparables.length
          ? "results_found"
          : "no_results",

      message:
        comparables.length
          ? `${comparables.length} comparable(s) réel(s) trouvé(s) sur 2ememain.`
          : "2ememain a répondu, mais aucun comparable exploitable n'a été extrait."
    });

  } catch (e) {
    return res.json({
      ok: true,
      version: VERSION,

      vehicle: target,

      provider: "2ememain",
      search_url: searchUrl,

      requested_results: maxResults,

      comparables: [],
      market_value: null,

      search_status:
        "provider_unavailable",

      message:
        `Recherche 2ememain indisponible depuis le serveur : ${e.message}`
    });
  }
});

/* =========================
   SERVEUR
   ========================= */

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `AutoCheck+ ${VERSION} server ready on ${PORT}`
  );
});
