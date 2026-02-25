require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const oa = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

(async () => {
  try {
    console.log("1. Fetching 10 untagged assets...");
    const { data, error } = await sb
      .from("assets")
      .select("id, title, artist")
      .is("style", null)
      .limit(10);
    if (error) { console.log("DB err:", error.message); return; }
    console.log("   Got", data.length, "assets");
    if (!data.length) { console.log("   No untagged assets!"); return; }

    console.log("2. Calling OpenAI...");
    const items = data.map((a, i) => `${i}: "${a.title}" by ${a.artist || "Unknown"}`).join("\n");
    const r = await oa.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Classify artworks. Return valid JSON only." },
        { role: "user", content: `For each artwork return {style,mood,subject,era,palette,tags:[]}. Return {"results":[...]}.\n\n${items}` },
      ],
      max_tokens: 4000,
      response_format: { type: "json_object" },
    });
    console.log("   OpenAI OK, parsing...");
    let p = JSON.parse(r.choices[0].message.content);
    if (p.results) p = p.results;
    if (!Array.isArray(p)) { const arr = Object.values(p).find(v => Array.isArray(v)); p = arr || [p]; }
    console.log("   Parsed", p.length, "results");

    console.log("3. Updating DB...");
    for (let i = 0; i < Math.min(p.length, data.length); i++) {
      const { error: ue } = await sb.from("assets").update({
        style: p[i].style || null,
        mood: p[i].mood || null,
        subject: p[i].subject || null,
        era: p[i].era || null,
        palette: p[i].palette || null,
        ai_tags: p[i].tags || [],
      }).eq("id", data[i].id);
      if (ue) console.log("   Update err:", ue.message);
      else console.log("   Updated", data[i].id, "→", p[i].style, "/", p[i].mood);
    }
    console.log("DONE!");
  } catch (e) {
    console.error("FATAL:", e.message);
    console.error(e.stack);
  }
})();
