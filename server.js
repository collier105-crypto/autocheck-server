const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const VERSION = "V37";

/* =========================
   AUTOCHECK+ SERVER V37
   ========================= */

app.get("/", (_, res) => {
  res.json({
    ok: true,
    app: "AutoCheck+",
    version: VERSION
  });
});

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    status: "online",
    version: VERSION
  });
});

/* =========================
   OUTILS
   ========================= */

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
    return new URL(u)
      .hostname
      .replace(/^www\./, "")
      .toLowerCase();
  } catch {
    return "";
  }
}

function sourceName(h) {
  if (
    h.includes("2ememain") ||
    h.includes("2dehands")
  ) {
    return "2ememain";
  }

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

/* =========================
   META
   ========================= */

function meta(html, key) {
  const escaped = key.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );

  const r1 = new RegExp(
    `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`,
    "i"
  );

  const r2 = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`,
    "i"
  );

  return (
    html.match(r1) ||
    html.match(r2) ||
    []
  )[1] || "";
}

/* =========================
   JSON-LD
   ========================= */

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
        if (!obj || typeof obj !== "object")
          return null;

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

            if (found)
              return found;
          }
        }

        return null;
      };

      if (Array.isArray(parsed)) {
        for (const x of parsed) {
          const found = inspect(x);

          if (found)
            return found;
        }
      } else {
        const found = inspect(parsed);

        if (found)
          return found;
      }
    } catch {}
  }

  return null;
}

/* =========================
   NORMALISATION VEHICULE
   ========================= */

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

  const blob = cleanText(
    `${title} ${description}`
  );

  const model =
    cleanText(
      [
        brand,
        ld.model ||
          ld.vehicleConfiguration
      ]
        .filter(Boolean)
        .join(" ")
    ) ||
    cleanText(title);

  const year =
    numberFrom(ld.vehicleModelDate) ||
    numberFrom(
      (
        blob.match(
          /\b(?:19|20)\d{2}\b/
        ) || []
      )[0]
    );

  const km =
    numberFrom(
      ld.mileageFromOdometer?.value
    ) ||
    numberFrom(
      (
        blob.match(
          /([\d .]{2,})\s*km\b/i
        ) || []
      )[1]
    );

  const price =
    numberFrom(offers.price) ||
    numberFrom(
      (
        blob.match(
          /(?:€|EUR)\s*([\d .]+)|([\d .]+)\s*(?:€|EUR)/i
        ) || []
      )
        .slice(1)
        .find(Boolean)
    );

  return {
    model,
    year,
    km,
    price,

    fuel:
      cleanText(
        ld.fuelType || ""
      ),

    power:
      cleanText(
        ld.vehicleEngine
          ?.enginePower
          ?.value || ""
      ),

    gearbox:
      cleanText(
        ld.vehicleTransmission || ""
      )
  };
}

/* =========================
   TELECHARGEMENT PAGE
   ========================= */

async function fetchPage(
  url,
  timeout = 12000
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () => controller.abort(),
      timeout
    );

  try {
    const response =
      await fetch(url, {
        signal:
          controller.signal,

        redirect:
          "follow",

        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36",

          "accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",

          "accept-language":
            "fr-BE,fr;q=0.9,nl;q=0.8,en;q=0.7",

          "cache-control":
            "no-cache"
        }
      });

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status}`
      );
    }

    return await response.text();

  } finally {
    clearTimeout(timer);
  }
}

/* =========================
   ANALYSE ANNONCE
   ========================= */

app.post(
  "/api/analyse",

  async (req, res) => {
    const url =
      req.body?.url?.trim();

    if (!url) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Lien d'annonce manquant"
        });
    }

    let parsed;

    try {
      parsed = new URL(url);
    } catch {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Lien invalide"
        });
    }

    if (
      !["http:", "https:"]
        .includes(parsed.protocol)
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Protocole non autorisé"
        });
    }

    const host = hostOf(url);

    try {
      const html =
        await fetchPage(url);

      const ld =
        findVehicleJsonLd(html);

      const data =
        normalizeVehicle(
          ld,
          html
        );

      const extracted =
        !!(
          data.model ||
          data.year ||
          data.km ||
          data.price
        );

      return res.json({
        ok: true,

        version:
          VERSION,

        source:
          sourceName(host),

        source_host:
          host,

        source_url:
          url,

        ...data,

        market_value:
          null,

        comparables:
          [],

        extraction_status:
          extracted
            ? "extracted"
            : "no_public_data",

        message:
          extracted
            ? "Données publiques récupérées."
            : "Aucune donnée structurée exploitable."
      });

    } catch (e) {
      return res.json({
        ok: true,

        version:
          VERSION,

        source:
          sourceName(host),

        source_host:
          host,

        source_url:
          url,

        model: "",
        year: null,
        km: null,
        price: null,
        fuel: "",
        power: "",
        gearbox: "",

        market_value:
          null,

        comparables:
          [],

        extraction_status:
          "blocked_or_unavailable",

        message:
          `Lecture impossible : ${e.message}`
      });
    }
  }
);

/* =========================
   RECHERCHE 2EMEMAIN
   ========================= */

function make2ememainSearch(model) {
  let query = cleanText(model);

  query = query
    .replace(/\b\d{4}\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!query)
    return null;

  return (
    "https://www.2ememain.be/l/autos/q/" +
    encodeURIComponent(query)
      .replace(/%20/g, "%2B") +
    "/"
  );
}

/* =========================
   EXTRACTION 2EMEMAIN V37
   ========================= */

function extract2ememain(
  html,
  target,
  limit
) {
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

  function addResult(
    title,
    price,
    year,
    km,
    url = ""
  ) {
    title = cleanText(title)
      .replace(
        /Sauvegarder dans Mes Favoris/gi,
        ""
      )
      .replace(/Image:/gi, "")
      .replace(/Détails/gi, "")
      .trim();

    price = numberFrom(price);
    year = numberFrom(year);
    km = numberFrom(km);

    if (
      !price ||
      price < 250 ||
      price > 200000
    )
      return;

    if (
      !year ||
      year < 1980 ||
      year >
        new Date().getFullYear() + 1
    )
      return;

    if (
      !km ||
      km < 500 ||
      km > 700000
    )
      return;

    const key =
      `${price}-${year}-${km}`;

    if (seen.has(key))
      return;

    seen.add(key);

    results.push({
      site: "2ememain",
      title,
      price,
      year,
      km,
      url
    });
  }

  /*
     METHODE 1
     prix -> année -> km
  */

  const pattern1 =
    /(.{8,300}?)€\s*([\d.\s]+)(?:,-)?.{0,300}?\b((?:19|20)\d{2})\b.{0,180}?([\d.\s]+)\s*km/gi;

  let match;

  while (
    (match = pattern1.exec(text)) &&
    results.length < 100
  ) {
    addResult(
      match[1],
      match[2],
      match[3],
      match[4]
    );
  }

  /*
     METHODE 2
     année -> km -> prix
  */

  const pattern2 =
    /(.{8,300}?)\b((?:19|20)\d{2})\b.{0,180}?([\d.\s]+)\s*km.{0,300}?€\s*([\d.\s]+)(?:,-)?/gi;

  while (
    (match = pattern2.exec(text)) &&
    results.length < 150
  ) {
    addResult(
      match[1],
      match[4],
      match[2],
      match[3]
    );
  }

  /*
     METHODE 3
     Analyse des blocs contenant
     prix + année + km
  */

  const blocks =
    text.split(
      /(?=€\s*[\d.\s]+(?:,-)?)/i
    );

  for (const block of blocks) {
    if (results.length >= 200)
      break;

    if (
      !/\b(?:19|20)\d{2}\b/
        .test(block)
    )
      continue;

    if (
      !/[\d.\s]+\s*km\b/i
        .test(block)
    )
      continue;

    const p =
      block.match(
        /€\s*([\d.\s]+)(?:,-)?/i
      );

    const y =
      block.match(
        /\b((?:19|20)\d{2})\b/
      );

    const k =
      block.match(
        /([\d.\s]+)\s*km\b/i
      );

    if (!p || !y || !k)
      continue;

    const title =
      block.substring(
        0,
        Math.min(
          block.length,
          250
        )
      );

    addResult(
      title,
      p[1],
      y[1],
      k[1]
    );
  }

  /*
     SCORE DE SIMILARITE
  */

  const targetWords =
    cleanText(target.model)
      .toLowerCase()
      .split(/\s+/)
      .filter(
        word =>
          word.length >= 3
      );

  results.forEach(item => {
    let score = 0;

    if (target.year) {
      score +=
        Math.abs(
          item.year -
          target.year
        ) *
        20000;
    }

    if (target.km) {
      score +=
        Math.abs(
          item.km -
          target.km
        );
    }

    const title =
      item.title.toLowerCase();

    let matchingWords = 0;

    for (
      const word of targetWords
    ) {
      if (
        title.includes(word)
      ) {
        matchingWords++;
      }
    }

    score -=
      matchingWords *
      100000;

    item._score =
      score;

    item._matchingWords =
      matchingWords;
  });

  /*
     PRIVILEGIER LE MEME MODELE
  */

  let candidates = results;

  const modelMatches =
    results.filter(
      item =>
        item._matchingWords > 0
    );

  if (
    modelMatches.length >= 2
  ) {
    candidates =
      modelMatches;
  }

  /*
     FILTRAGE V37
     année +/- 6 ans
     kilométrage marge élargie
  */

  let filtered =
    candidates.filter(item => {
      if (
        target.year &&
        Math.abs(
          item.year -
          target.year
        ) > 6
      )
        return false;

      if (
        target.km &&
        Math.abs(
          item.km -
          target.km
        ) >
          Math.max(
            150000,
            target.km * 0.90
          )
      )
        return false;

      return true;
    });

  if (!filtered.length) {
    filtered =
      candidates;
  }

  filtered.sort(
    (a, b) =>
      a._score -
      b._score
  );

  return filtered
    .slice(0, limit)
    .map(item => {
      delete item._score;
      delete item._matchingWords;

      return item;
    });
}

/* =========================
   MEDIANE
   ========================= */

function median(values) {
  const a = values
    .filter(Boolean)
    .sort(
      (x, y) => x - y
    );

  if (!a.length)
    return null;

  const middle =
    Math.floor(
      a.length / 2
    );

  return a.length % 2
    ? a[middle]
    : Math.round(
        (
          a[middle - 1] +
          a[middle]
        ) / 2
      );
}

/* =========================
   MOYENNE
   ========================= */

function average(values) {
  const a =
    values.filter(Boolean);

  if (!a.length)
    return null;

  return Math.round(
    a.reduce(
      (sum, n) =>
        sum + n,
      0
    ) / a.length
  );
}

/* =========================
   COMPARABLES V37
   ========================= */

app.post(
  "/api/comparables",

  async (req, res) => {
    const {
      model,
      year,
      km,
      price,
      limit
    } =
      req.body || {};

    if (!model) {
      return res
        .status(400)
        .json({
          ok: false,

          error:
            "Le modèle est nécessaire pour rechercher les comparables."
        });
    }

    const maxResults =
      Math.min(
        Math.max(
          Number(limit) || 10,
          1
        ),
        10
      );

    const target = {
      model:
        cleanText(model),

      year:
        numberFrom(year),

      km:
        numberFrom(km),

      price:
        numberFrom(price)
    };

    const searchUrl =
      make2ememainSearch(
        target.model
      );

    if (!searchUrl) {
      return res
        .status(400)
        .json({
          ok: false,

          error:
            "Recherche impossible."
        });
    }

    try {
      const html =
        await fetchPage(
          searchUrl
        );

      const comparables =
        extract2ememain(
          html,
          target,
          maxResults
        );

      const prices =
        comparables.map(
          x => x.price
        );

      const marketValue =
        median(prices);

      const averageValue =
        average(prices);

      return res.json({
        ok: true,

        version:
          VERSION,

        vehicle:
          target,

        provider:
          "2ememain",

        search_url:
          searchUrl,

        requested_results:
          maxResults,

        results_count:
          comparables.length,

        comparables,

        market_value:
          marketValue,

        median_value:
          marketValue,

        average_value:
          averageValue,

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

        version:
          VERSION,

        vehicle:
          target,

        provider:
          "2ememain",

        search_url:
          searchUrl,

        requested_results:
          maxResults,

        results_count:
          0,

        comparables:
          [],

        market_value:
          null,

        median_value:
          null,

        average_value:
          null,

        search_status:
          "provider_unavailable",

        message:
          `Recherche 2ememain indisponible : ${e.message}`
      });
    }
  }
);

/* =========================
   SERVEUR
   ========================= */

const PORT =
  process.env.PORT ||
  3000;

app.listen(
  PORT,
  "0.0.0.0",

  () => {
    console.log(
      `AutoCheck+ ${VERSION} server ready on ${PORT}`
    );
  }
);
