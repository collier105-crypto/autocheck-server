const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/", (_, res) => {
  res.json({
    ok: true,
    app: "AutoCheck+",
    version: "V31"
  });
});

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    status: "online",
    version: "V31"
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

  if (v == null)
    return null;

  const n = Number(
    String(v).replace(/[^\d]/g, "")
  );

  return Number.isFinite(n) && n
    ? n
    : null;
}

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

function normalize(ld, html) {

  const offers = ld?.offers || {};

  const brand =
    typeof ld?.brand === "object"
      ? ld.brand.name
      : ld?.brand;

  const model =
    ld?.model ||
    ld?.vehicleModelDate ||
    "";

  const name =
    ld?.name ||
    meta(html, "og:title") ||
    "";

  const desc =
    ld?.description ||
    meta(html, "og:description") ||
    "";

  const blob = cleanText(
    `${name} ${desc}`
  );

  const year =
    numberFrom(ld?.vehicleModelDate) ||
    numberFrom(
      (blob.match(/\b(19|20)\d{2}\b/) || [])[0]
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

    year: year,

    km: km,

    price: price,

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

      parsed =
        new URL(url);

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
      ![
        "http:",
        "https:"
      ].includes(parsed.protocol)
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
                "Mozilla/5.0 (compatible; AutoCheckPlus/31; +vehicle-analysis)",

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
        normalize(
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

        version: "V31",

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
            : "La page répond mais aucune donnée structurée exploitable n'a été trouvée."
      });

    } catch (e) {

      return res.json({

        ok: true,

        version: "V31",

        source:
          sourceName(host),

        source_host:
          host,

        source_url:
          url,

        model: "",

        year:
          null,

        km:
          null,

        price:
          null,

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

const PORT =
  process.env.PORT ||
  3000;

app.listen(
  PORT,
  "0.0.0.0",
  () => {

    console.log(
      `AutoCheck+ V31 server ready on ${PORT}`
    );
  }
);
