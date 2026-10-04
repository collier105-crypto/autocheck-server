const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => {
  res.json({
    ok: true,
    app: "AutoCheck+",
    version: "V30"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "online",
    version: "V30"
  });
});

function hostOf(url) {
  try {
    return new URL(url).hostname
      .replace(/^www\./, "")
      .toLowerCase();
  } catch {
    return "";
  }
}

function sourceName(host) {
  if (host.includes("autoscout24")) return "AutoScout24";
  if (host.includes("2ememain") || host.includes("2dehands"))
    return "2ememain";
  if (host.includes("facebook"))
    return "Facebook Marketplace";
  if (host.includes("leboncoin"))
    return "Leboncoin";
  if (host.includes("gocar"))
    return "Gocar";

  return host || "Inconnue";
}

app.post("/api/analyse", async (req, res) => {

  const url = req.body?.url?.trim();

  if (!url) {
    return res.status(400).json({
      ok: false,
      error: "Lien d'annonce manquant"
    });
  }

  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({
      ok: false,
      error: "Lien d'annonce invalide"
    });
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return res.status(400).json({
      ok: false,
      error: "Protocole non autorisé"
    });
  }

  const host = hostOf(url);

  res.json({
    ok: true,
    version: "V30",

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

    extraction_status: "source_recognized",

    message:
      "Source reconnue. Le connecteur d'extraction spécifique doit être activé pour récupérer les données de cette annonce."
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`AutoCheck+ V30 server ready on ${PORT}`);
});
