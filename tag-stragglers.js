require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

(async () => {
  const { data } = await supabase.from("assets").select("id, title, artist").is("style", null);
  if (!data || data.length === 0) { console.log("All done!"); process.exit(0); }
  console.log("Tagging", data.length, "stragglers...");

  const items = data.map((a, i) => `${i}:"${a.title}" by ${a.artist || "?"}`).join("\n");
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "Art classification bot. Return valid JSON array only." },
      { role: "user", content: `Classify each artwork. Return JSON array, one object per item, same order.
Each: {"style":"...","mood":"...","subject":"...","era":"...","palette":"...","tags":["t1","t2",...]}
tags: 5-8 SEO keywords.

${items}` },
    ],
    temperature: 0.2,
    max_tokens: 4000,
    response_format: { type: "json_object" },
  });

  let parsed = JSON.parse(r.choices[0].message.content);
  if (!Array.isArray(parsed)) parsed = Object.values(parsed).find(v => Array.isArray(v));

  for (let i = 0; i < Math.min(parsed.length, data.length); i++) {
    const p = parsed[i];
    const { error } = await supabase.from("assets").update({
      style: p.style, mood: p.mood, subject: p.subject,
      era: p.era, palette: p.palette, ai_tags: p.tags || [],
    }).eq("id", data[i].id);
    console.log(error ? "ERR " + data[i].title : "OK " + data[i].title);
  }
  process.exit(0);
})();
