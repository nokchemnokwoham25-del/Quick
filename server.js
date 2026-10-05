const express = require('express');
const cors = require('cors');
const fs = require('fs');
const zlib = require('zlib');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10kb' }));

// ---- Makes the website installable like an app (PWA) ----
// PNG-START
function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function makePng(s) {
  const row = 1 + s * 3;
  const raw = Buffer.alloc(row * s);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      let r = 0x5b, g = 0x4b, b = 0xdb;
      if (x >= 0.38 * s && x <= 0.72 * s && Math.abs(y - 0.5 * s) <= 0.2 * s * (0.72 * s - x) / (0.34 * s)) { r = g = b = 255; }
      const o = y * row + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(s, 0); ihdr.writeUInt32BE(s, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// PNG-END
const icons = { 192: makePng(192), 512: makePng(512) };
app.get('/icon-192.png', (req, res) => res.type('png').send(icons[192]));
app.get('/icon-512.png', (req, res) => res.type('png').send(icons[512]));
app.get('/manifest.json', (req, res) => res.json({
  id: '/',
  name: 'Nokchem',
  short_name: 'Nokchem',
  description: 'Type any topic and watch a narrated visual lesson.',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#14141c',
  theme_color: '#5b4bdb',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}));
app.get('/sw.js', (req, res) => {
  res.type('application/javascript').send(
    "self.addEventListener('install',e=>self.skipWaiting());" +
    "self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));" +
    "self.addEventListener('fetch',e=>{});"
  );
});
app.get('/', (req, res) => {
  let html = fs.readFileSync(__dirname + '/index.html', 'utf8');
  html = html
    .replace('', '<link rel="manifest" href="/manifest.json"><meta name="theme-color" content="#5b4bdb"><link rel="icon" href="/icon-192.png">')
    .replace('', '');
  res.type('html').send(html);
});

const KEY = process.env.GEMINI_API_KEY;
const MODELS = [...new Set([
  process.env.GEMINI_MODEL,
  'gemini-3.8-flash',
  'gemini-flash-latest',
  'gemini-flash-lite-latest',
].filter(Boolean))];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function callModel(prompt) {
  let lastErr;
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`;
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.8, responseMimeType: 'application/json' },
          }),
        });
        if (!r.ok) {
          const t = await r.text();
          lastErr = new Error(`${model}: ${r.status} ${t}`);
          if (r.status === 503 || r.status === 429 || r.status === 404) { await sleep(600); continue; }
          continue;
        }
        const data = await r.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) { lastErr = new Error(`${model}: empty response`); continue; }
        return text;
      } catch (e) {
        lastErr = e;
        await sleep(400);
      }
    }
  }
  throw lastErr || new Error('All models failed');
}

function extractJson(text) {
  const start = text.indexOf('{') === -1 ? text.indexOf('[') : text.indexOf('{');
  const endBrace = text.lastIndexOf('}');
  const endBracket = text.lastIndexOf(']');
  const end = Math.max(endBrace, endBracket);
  const slice = text.slice(start, end + 1);
  return JSON.parse(slice);
}

const LEVEL_GUIDE = {
  basic: 'Teach from the very beginning, as if the student has never heard of this topic. Build up step by step, slowly, covering everything from the start to the end of the topic in a simple way. Use 6 to 7 scenes.',
  medium: 'Teach at a moderate pace, assuming the student already knows the basics. Cover the topic in a balanced, not-too-light, not-too-deep way. Use 5 scenes.',
  revision: 'Give a quick revision: only the most important points and key facts of the topic, like a fast recap before an exam. Keep it short. Use 3 to 4 scenes.',
};

app.post('/api/lesson', async (req, res) => {
  try {
    const { topic, className, subject, level } = req.body || {};
    if (!topic || !String(topic).trim()) return res.status(400).json({ error: 'Topic is required' });
    const lvl = LEVEL_GUIDE[level] ? level : 'medium';

    const prompt = `You are an advanced, warm, natural-sounding human tutor creating a narrated visual lesson for a class ${className || ''} student, subject: ${subject || 'General'}, topic: "${topic}".
Level instruction: ${LEVEL_GUIDE[lvl]}

Speak in a natural, conversational, warm tutor voice - like a real teacher explaining one-on-one, not a robot reading facts. Use short, clear sentences. Use simple words appropriate for the class level. Add small natural touches like "Now, let's see...", "Notice how...", "This is important because...".

Return ONLY valid JSON (no markdown, no backticks) in this exact shape:
{
  "title": "short lesson title",
  "scenes": [
    { "narration": "what the tutor says for this scene, 2-4 natural sentences", "svg": "a simple, clean SVG string (viewBox 0 0 400 300, no external fonts/images, using basic shapes/text) that visually represents this scene" }
  ]
}
Return between 3 and 7 scenes depending on the level instruction above.`;

    const text = await callModel(prompt);
    const lesson = extractJson(text);
    res.json(lesson);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong making the lesson. Please try again.' });
  }
});

app.post('/api/quiz', async (req, res) => {
  try {
    const { topic, className, subject, level } = req.body || {};
    if (!topic || !String(topic).trim()) return res.status(400).json({ error: 'Topic is required' });

    const prompt = `Create a short multiple-choice quiz to test a class ${className || ''} student on the topic "${topic}" (subject: ${subject || 'General'}, difficulty level: ${level || 'medium'}).
Return ONLY valid JSON (no markdown, no backticks) in this exact shape:
{
  "questions": [
    { "question": "question text", "options": ["option A", "option B", "option C", "option D"], "correctIndex": 0 }
  ]
}
Return exactly 5 questions. correctIndex is the 0-based index of the correct option.`;

    const text = await callModel(prompt);
    const quiz = extractJson(text);
    res.json(quiz);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Something went wrong making the quiz. Please try again.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Nokchem running on port ' + PORT));
