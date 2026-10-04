const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/", (req, res) => {
  res.json({
    ok: true,
    app: "AutoCheck+",
    version: "V29"
  });
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    status: "online",
    version: "V29"
  });
});

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

app.post("/api/analyse", async (req, res) => {

  const url = req.body?.url;

  if (!url) {
    return res.status(400).json({
      error: "Lien d'annonce manquant"
    });
  }

  const source = hostOf(url);

  res.json({
    ok: true,
    version: "V29",

    source: source,
    source_url: url,

    model: "",
    year: null,
    km: null,
    price: null,

    market_value: null,

    comparables: [],

    extraction_status: "source_connector_required"
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`AutoCheck+ V29 server ready on ${PORT}`);
});
