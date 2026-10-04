const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

/* =========================
   AUTOCHECK+ SERVER V34
   ========================= */

app.get("/", (_, res) => {
  res.json({
    ok: true,
    app: "AutoCheck+",
    version: "V34"
  });
});

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    status: "online",
    version: "V34"
  });
});

function hostOf(u) {
  try {
    return new URL(u).hostname
      .replace(/^www\./, "")
      .toLowerCase();
  } catch {
    return "";
  }
}

function sourceName(h) {
  if (h.includes("autoscout24")) return "AutoScout24";
  if (h.includes("2ememain") || h.includes("2dehands"))
    return "2ememain";
  if (h.includes("facebook"))
    return "Facebook Marketplace";
  if (h.includes("leboncoin"))
    return "Leboncoin";
  if (h.includes("gocar"))
    return "Gocar";

  return h || "Inconnue";
}

function cleanText(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .trim();
}

function numberFrom(v) {
  if (v == null) return null;

  const n = Number(
    String(v).replace(/[^\d]/g, "")
  );

  return Number.isFinite(n) && n
    ? n
    : null;
}

/* =========================
   JSON-LD
   ========================= */

function jsonLd(html) {
  const blocks = [
    ...html.matchAll(
      /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
    )
  ];

  for (const b of blocks) {
    try {
      const x = JSON.parse(b[1]);

      const arr = Array.isArray(x)
        ? x
        : [x];

      for (const o of arr) {
        if (
          o &&
          typeof o === "object" &&
          (
            o.vehicleConfiguration ||
            o.brand ||
            o.model ||
            o.offers
          )
        ) {
          return o;
        }
      }
    } catch {}
  }

  return null;
}

/* =========================
   META TAG
   ========================= */

function meta(html, key) {
  const esc = key.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );

  const r1 = new RegExp(
    `<meta[^>]+(?:property|name)=["']${esc}["'][^>]+content=["']([^"']+)["']`,
    "i"
  );

  const r2 = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${esc}["']`,
    "i"
  );

  return (
    html.match(r1) ||
    html.match(r2) ||
    []
  )[1] || "";
}

/* =========================
   NORMALISATION ANNONCE
   ========================= */

function normalize(ld, html) {
  const offers = ld?.offers || {};

  const brand =
    typeof ld?.brand === "object"
      ? ld.brand.name
      : ld?.brand;

  const model =
    ld?.model ||
    ld?.vehicleConfiguration ||
    "";

  const name =
    ld?.name ||
    meta(html, "og:title") ||
    "";

  const desc =
    ld?.description ||
    meta(html, "og:description") ||
    "";

  const blob =
    cleanText(`${name} ${desc}`);

  const year =
    numberFrom(ld?.vehicleModelDate) ||
    numberFrom(
      (
        blob.match(
          /\b(?:19|20)\d{2}\b/
        ) || []
      )[0]
    );

  const km =
    numberFrom(
      ld?.mileageFromOdometer?.value
    ) ||
    numberFrom(
      (
        blob.match(
          /([\d .]{2,})\s*km\b/i
        ) || []
      )[1]
    );

  const price =
    numberFrom(offers?.price) ||
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
    model:
      cleanText(
        [brand, model]
          .filter(Boolean)
          .join(" ")
      ) ||
      cleanText(name),

    year,
    km,
    price,

    fuel:
      cleanText(
        ld?.fuelType || ""
      ),

    power:
      cleanText(
        ld?.vehicleEngine
          ?.enginePower
          ?.value || ""
      ),

    gearbox:
      cleanText(
        ld?.vehicleTransmission || ""
      )
  };
}

/* =========================
   ANALYSE D'UNE ANNONCE
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

    const host =
      hostOf(url);

    try {
      const controller =
        new AbortController();

      const timer =
        setTimeout(
          () =>
            controller.abort(),
          12000
        );

      const r =
        await fetch(
          url,
          {
            signal:
              controller.signal,

            headers: {
              "user-agent":
                "Mozilla/5.0 (compatible; AutoCheckPlus/34)",

              "accept-language":
                "fr-BE,fr;q=0.9,en;q=0.7"
            }
          }
        );

      clearTimeout(timer);

      if (!r.ok) {
        throw new Error(
          `HTTP ${r.status}`
        );
      }

      const html =
        await r.text();

      const ld =
        jsonLd(html);

      const data =
        normalize(ld, html);

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
          "V34",

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
          "V34",

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
          "Cette source ne permet pas au serveur de lire directement la page."
      });
    }
  }
);

/* =========================
   COMPARABLES V34
   ========================= */

app.post(
  "/api/comparables",

  async (req, res) => {
    const {
      url,
      model,
      year,
      km,
      price,
      limit
    } = req.body || {};

    if (!url && !model) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Véhicule ou annonce manquante."
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

    /*
      V34 prépare la recherche automatique.

      IMPORTANT :
      on ne fabrique pas de fausses annonces.

      Une source de recherche réelle devra être
      branchée ici dans la prochaine évolution.
    */

    return res.json({
      ok: true,

      version:
        "V34",

      vehicle: {
        model:
          cleanText(model),
        year:
          numberFrom(year),
        km:
          numberFrom(km),
        price:
          numberFrom(price)
      },

      requested_results:
        maxResults,

      comparables:
        [],

      market_value:
        null,

      search_status:
        "search_provider_required",

      message:
        "Serveur V34 opérationnel. Le moteur de recherche de comparables doit maintenant être connecté à une source d'annonces réelle."
    });
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
      `AutoCheck+ V34 server ready on ${PORT}`
    );
  }
);
