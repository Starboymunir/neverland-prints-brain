require('dotenv').config();
const OpenAI = require('openai');
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

(async () => {
  const r = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'Write curator descriptions for artworks. Return JSON: {"items":[{"i":1,"d":"desc"},...]}' },
      { role: 'user', content: '1. "Schuit op een meer" by Adolf le Comte\n2. "Motherly love" by Frederick Morgan\n3. "The Old Gun Pit 1916" by Joseph Pennell' }
    ],
    temperature: 0.7,
    max_tokens: 1024,
    response_format: { type: 'json_object' }
  });
  const text = r.choices[0].message.content;
  console.log('RAW RESPONSE:');
  console.log(text);
  const obj = JSON.parse(text);
  console.log('\nPARSED:', JSON.stringify(obj, null, 2));
  console.log('\nITEMS:', obj.items);
})();
