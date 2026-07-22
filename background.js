// Service worker: handles saving words, translation, and AI example generation.

const STORAGE_KEY = "words";

// ---- Storage helpers -------------------------------------------------------

async function getWords() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return data[STORAGE_KEY] || [];
}

async function setWords(words) {
  await chrome.storage.local.set({ [STORAGE_KEY]: words });
}

// ---- Google Translate (free keyless endpoint) ------------------------------

async function translateToBengali(text) {
  const url =
    "https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=bn&dt=t&q=" +
    encodeURIComponent(text);
  const res = await fetch(url);
  if (!res.ok) throw new Error("Translation request failed (" + res.status + ")");
  const data = await res.json();
  // data[0] is an array of segments; each segment[0] is the translated chunk.
  const translated = (data[0] || [])
    .map((seg) => (seg && seg[0]) || "")
    .join("");
  return translated.trim();
}

// ---- English definition + part of speech (Free Dictionary API) -------------

async function fetchDictionary(word) {
  const url =
    "https://api.dictionaryapi.dev/api/v2/entries/en/" +
    encodeURIComponent(word.toLowerCase());
  const res = await fetch(url);
  if (!res.ok) throw new Error("Dictionary request failed (" + res.status + ")");
  const data = await res.json();
  const entry = Array.isArray(data) ? data[0] : null;
  if (!entry || !entry.meanings || !entry.meanings.length) {
    throw new Error("No dictionary entry");
  }
  // Collect all parts of speech, use the first meaning's first definition.
  const pos = [...new Set(entry.meanings.map((m) => m.partOfSpeech))]
    .filter(Boolean)
    .join(", ");
  const first = entry.meanings[0];
  const definition =
    (first.definitions && first.definitions[0] && first.definitions[0].definition) ||
    "";
  return { pos, definition };
}

// Fallback for phrases/idioms the single-word dictionary API doesn't cover.
async function fetchDictionaryViaAi(word) {
  const prompt =
    'The English word or phrase "' +
    word +
    '" was not found in a single-word dictionary, so it is likely a multi-word expression (phrasal verb, idiom, or collocation) or an uncommon term.' +
    " Reply with EXACTLY two lines and nothing else, in this format:\n" +
    "pos: <a short label, e.g. \"phrasal verb\", \"idiom\", \"collocation\", or a normal part of speech if it fits one>\n" +
    "definition: <one short, simple definition, easy vocabulary, under 20 words>";
  const text = await callGroq(prompt);
  const posMatch = text.match(/pos:\s*(.+)/i);
  const defMatch = text.match(/definition:\s*(.+)/i);
  return {
    pos: posMatch ? posMatch[1].trim() : "",
    definition: defMatch ? defMatch[1].trim() : "",
  };
}

// ---- AI example generation (Groq, free tier — requires user's own API key) -

async function getGroqApiKey() {
  const data = await chrome.storage.local.get("groqApiKey");
  if (!data.groqApiKey) {
    throw new Error(
      "No Groq API key set. Add a free key via the settings menu (⚙ → Groq API Key)."
    );
  }
  return data.groqApiKey;
}

async function callGroq(prompt, opts) {
  const apiKey = await getGroqApiKey();
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + apiKey,
    },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: prompt }],
      temperature: (opts && opts.temperature) ?? 0.7,
      ...(opts && opts.jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error("AI request failed (" + res.status + "): " + body.slice(0, 200));
  }
  const data = await res.json();
  return (data.choices && data.choices[0] && data.choices[0].message.content || "").trim();
}

async function generateExamples(word) {
  const prompt =
    "Give exactly 3 short, simple example sentences in English that use the word \"" +
    word +
    "\". Write them for a beginner English learner: use easy, everyday vocabulary and short sentences (under 12 words each), avoiding rare or advanced words. Number them 1., 2., 3. Only output the three sentences, nothing else.";
  return callGroq(prompt);
}

// ---- AI usage-by-part-of-speech generation ---------------------------------

async function generatePosExamples(word, knownPos) {
  const hint = knownPos
    ? ' Its known parts of speech are: ' + knownPos + "."
    : "";
  const prompt =
    'The English word or phrase "' +
    word +
    '" may be usable as different parts of speech (noun, verb, adjective, adverb, etc.), or it may instead be a multi-word expression such as a phrasal verb, idiom, or collocation.' +
    hint +
    " If it fits one or more parts of speech, output one line per part of speech in the format: partofspeech: one short, simple example sentence using it that way. If it is (or also has a sense as) a phrasal verb, idiom, or collocation, output one line per such sense in the format: phrasal verb: example sentence / idiom: example sentence / collocation: example sentence, using whichever label fits. Write for a beginner English learner: easy, everyday vocabulary, under 12 words per sentence, no rare or advanced words. Do not include categories that do not apply. Output only these lines, nothing else.";
  return callGroq(prompt);
}

// ---- AI grammar check --------------------------------------------------------

async function checkGrammar(text) {
  const prompt =
    'You are a friendly English grammar checker for a language learner. Analyze this sentence:\n"' +
    text +
    '"\n\n' +
    "Reply with ONLY a JSON object (no markdown, no code fences) in exactly this shape:\n" +
    '{"tokens":[{"text":"word","role":"subject|verb|object|complement|modifier|conjunction|punctuation|other"}],"structure":"state the sentence structure (e.g. Subject + Verb + Object) and the sentence type (simple, compound, complex, or compound-complex; and declarative, interrogative, imperative, or exclamatory), 1 short sentence, easy vocabulary","hasErrors":true|false,"corrected":"the corrected sentence, or the same sentence if no errors","corrections":"a short, simple explanation of what was wrong and fixed, or empty string if no errors"}\n' +
    "Split the sentence into tokens covering every word and punctuation mark, in order, preserving original words (do not fix spelling in the tokens list, only in \"corrected\"). Tag each token by its grammatical role in the sentence (subject, verb, object, complement, modifier, conjunction, punctuation, other). Keep explanations beginner-friendly.";
  const raw = await callGroq(prompt, { temperature: 0.3, jsonMode: true });
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error("Could not parse AI response");
  }
  return parsed;
}

// ---- Save a word -----------------------------------------------------------

async function saveWord({ word, sentence, url, title, group }) {
  word = (word || "").trim();
  if (!word) return { ok: false, error: "Empty selection" };

  const words = await getWords();

  // Avoid duplicates (case-insensitive).
  const existing = words.find(
    (w) => w.word.toLowerCase() === word.toLowerCase()
  );
  if (existing) {
    return { ok: true, duplicate: true, entry: existing };
  }

  // Fetch Bengali meaning and English dictionary info in parallel.
  const [tRes, dRes] = await Promise.allSettled([
    translateToBengali(word),
    fetchDictionary(word),
  ]);
  const meaning = tRes.status === "fulfilled" ? tRes.value : "";
  let dict = dRes.status === "fulfilled" ? dRes.value : { pos: "", definition: "" };
  if (dRes.status === "rejected") {
    dict = await fetchDictionaryViaAi(word).catch(() => ({ pos: "", definition: "" }));
  }

  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    word,
    meaning,
    pos: dict.pos,
    definition: dict.definition,
    examples: null, // generated on demand
    sentence: sentence || "",
    url: url || "",
    title: title || "",
    group: group || "",
    createdAt: Date.now(),
  };

  words.unshift(entry);
  await setWords(words);
  return { ok: true, entry };
}

// ---- Message router --------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "SAVE_WORD") {
        const result = await saveWord(msg.payload);
        sendResponse(result);
      } else if (msg.type === "GENERATE_EXAMPLES") {
        const words = await getWords();
        const entry = words.find((w) => w.id === msg.id);
        if (!entry) return sendResponse({ ok: false, error: "Not found" });
        entry.examples = await generateExamples(entry.word);
        await setWords(words);
        sendResponse({ ok: true, examples: entry.examples });
      } else if (msg.type === "GENERATE_POS_EXAMPLES") {
        const words = await getWords();
        const entry = words.find((w) => w.id === msg.id);
        if (!entry) return sendResponse({ ok: false, error: "Not found" });
        entry.posExamples = await generatePosExamples(entry.word, entry.pos);
        await setWords(words);
        sendResponse({ ok: true, posExamples: entry.posExamples });
      } else if (msg.type === "RETRANSLATE") {
        const words = await getWords();
        const entry = words.find((w) => w.id === msg.id);
        if (!entry) return sendResponse({ ok: false, error: "Not found" });
        const [tRes, dRes] = await Promise.allSettled([
          translateToBengali(entry.word),
          fetchDictionary(entry.word),
        ]);
        if (tRes.status === "fulfilled" && tRes.value) entry.meaning = tRes.value;
        if (dRes.status === "fulfilled") {
          entry.pos = dRes.value.pos;
          entry.definition = dRes.value.definition;
        } else {
          const aiDict = await fetchDictionaryViaAi(entry.word).catch(() => null);
          if (aiDict) {
            entry.pos = aiDict.pos;
            entry.definition = aiDict.definition;
          }
        }
        await setWords(words);
        sendResponse({ ok: true, entry });
      } else if (msg.type === "CHECK_GRAMMAR") {
        const result = await checkGrammar(msg.text);
        sendResponse({ ok: true, result });
      } else if (msg.type === "DELETE_WORD") {
        const words = await getWords();
        await setWords(words.filter((w) => w.id !== msg.id));
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "Unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message || String(e) });
    }
  })();
  return true; // keep the channel open for async response
});

// ---- Side panel: clicking the toolbar icon opens it ------------------------

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

// ---- Right-click context menu ---------------------------------------------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "save-word",
    title: 'Save "%s" to vocab',
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "save-word" && info.selectionText) {
    saveWord({
      word: info.selectionText,
      sentence: "",
      url: (tab && tab.url) || "",
      title: (tab && tab.title) || "",
    });
  }
});
