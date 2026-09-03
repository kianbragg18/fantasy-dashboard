const path = require("path");
const express = require("express");
const { getMatchupData } = require("./lib/sleeper");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/matchup", async (req, res) => {
  try {
    const force = req.query.force === "1";
    const data = await getMatchupData({ force });
    res.json(data);
  } catch (err) {
    console.error("Failed to load matchup data:", err.message);
    res.status(502).json({ error: "Failed to fetch data from Sleeper" });
  }
});

app.listen(PORT, () => {
  console.log(`Fantasy dashboard running on http://localhost:${PORT}`);
});
