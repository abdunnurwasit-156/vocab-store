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

// ---- AI example generation (free keyless endpoint) -------------------------

// Pollinations appends an ad/donation footer after a "---" separator. Strip it.
function cleanAiText(text) {
  if (!text) return text;
  // Cut everything from the first horizontal-rule separator onward.
  let out = text.split(/\n\s*-{3,}\s*\n?/)[0];
  // Belt and braces: drop any leftover ad/sponsor lines.
  out = out
    .split("\n")
    .filter(
      (line) =>
        !/pollinations|support our mission|\*\*ad\*\*|🌸/i.test(line)
    )
    .join("\n");
  return out.trim();
}

async function generateExamples(word) {
  const prompt =
    "Give exactly 3 short, natural example sentences in English that use the word \"" +
    word +
    "\". Number them 1., 2., 3. Only output the three sentences, nothing else.";
  const url = "https://text.pollinations.ai/" + encodeURIComponent(prompt);
  const res = await fetch(url);
  if (!res.ok) throw new Error("AI request failed (" + res.status + ")");
  const text = await res.text();
  return cleanAiText(text);
}

// ---- AI usage-by-part-of-speech generation ---------------------------------

async function generatePosExamples(word, knownPos) {
  const hint = knownPos
    ? ' Its known parts of speech are: ' + knownPos + "."
    : "";
  const prompt =
    'The English word "' +
    word +
    '" may be usable as different parts of speech (noun, verb, adjective, adverb, etc.).' +
    hint +
    " For EACH part of speech that genuinely applies to this word, output one line in the format: partofspeech: one short natural example sentence using the word that way. One line per part of speech. Do not include parts of speech that do not apply. Output only these lines, nothing else.";
  const url = "https://text.pollinations.ai/" + encodeURIComponent(prompt);
  const res = await fetch(url);
  if (!res.ok) throw new Error("AI request failed (" + res.status + ")");
  const text = await res.text();
  return cleanAiText(text);
}

// ---- Save a word -----------------------------------------------------------

async function saveWord({ word, sentence, url, title }) {
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
  const dict =
    dRes.status === "fulfilled" ? dRes.value : { pos: "", definition: "" };

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
        }
        await setWords(words);
        sendResponse({ ok: true, entry });
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

// ---- One-time scrub: remove ad footers from already-saved examples ---------

(async () => {
  try {
    const words = await getWords();
    let changed = false;
    for (const w of words) {
      const cleaned = w.examples ? cleanAiText(w.examples) : w.examples;
      const cleanedPos = w.posExamples ? cleanAiText(w.posExamples) : w.posExamples;
      if (cleaned !== w.examples || cleanedPos !== w.posExamples) {
        w.examples = cleaned;
        w.posExamples = cleanedPos;
        changed = true;
      }
    }
    if (changed) await setWords(words);
  } catch (e) {
    // non-fatal
  }
})();

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
