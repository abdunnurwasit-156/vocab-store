// Paused: "Usage by type" AI column. Set to true to bring it back.
const ENABLE_POS_USAGE = false;

const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");
const searchEl = document.getElementById("search");
const tabsEl = document.getElementById("tabs");

let allWords = [];
let groups = []; // user-created group names
let activeGroup = "__all__"; // "__all__" or a group name ("" = Ungrouped)

async function load() {
  const data = await chrome.storage.local.get(["words", "groups"]);
  allWords = data.words || [];
  groups = data.groups || [];
  render();
}

function saveWords() {
  return chrome.storage.local.set({ words: allWords });
}

function saveGroups() {
  return chrome.storage.local.set({ groups });
}

// ---- Confirmation modal ---------------------------------------------------

const overlayEl = document.getElementById("modal-overlay");
const modalTextEl = document.getElementById("modal-text");
const modalConfirmEl = document.getElementById("modal-confirm");
const modalCancelEl = document.getElementById("modal-cancel");

let modalResolve = null;

function confirmModal(html, confirmLabel = "Delete") {
  modalTextEl.innerHTML = html;
  modalConfirmEl.textContent = confirmLabel;
  overlayEl.hidden = false;
  modalCancelEl.focus();
  return new Promise((resolve) => {
    modalResolve = resolve;
  });
}

function closeModal(result) {
  overlayEl.hidden = true;
  if (modalResolve) {
    modalResolve(result);
    modalResolve = null;
  }
}

modalConfirmEl.addEventListener("click", () => closeModal(true));
modalCancelEl.addEventListener("click", () => closeModal(false));
overlayEl.addEventListener("click", (e) => {
  if (e.target === overlayEl) closeModal(false);
});
document.addEventListener("keydown", (e) => {
  if (!overlayEl.hidden && e.key === "Escape") closeModal(false);
});

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s || "";
  return div.innerHTML;
}

// ---- Tabs -----------------------------------------------------------------

function countIn(group) {
  if (group === "__all__") return allWords.length;
  return allWords.filter((w) => (w.group || "") === group).length;
}

function renderTabs() {
  tabsEl.innerHTML = "";

  const mk = (label, value, deletable) => {
    const b = document.createElement("button");
    b.className = "tab" + (activeGroup === value ? " active" : "");
    b.dataset.group = value;
    b.innerHTML =
      escapeHtml(label) +
      ` <span class="tab-count">${countIn(value)}</span>` +
      (deletable ? ' <span class="tab-del" title="Delete group">✕</span>' : "");
    tabsEl.appendChild(b);
  };

  mk("All", "__all__", false);
  for (const g of groups) mk(g, g, true);

  const add = document.createElement("button");
  add.className = "tab add-tab";
  add.id = "add-group";
  add.textContent = "＋ New";
  tabsEl.appendChild(add);
}

tabsEl.addEventListener("click", async (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;

  // Delete a group (words fall back to ungrouped/All)
  if (e.target.classList.contains("tab-del")) {
    const g = tab.dataset.group;
    const ok = await confirmModal(
      `Delete group <b>${escapeHtml(g)}</b>?<br>Words in it will stay in All.`,
      "Delete group"
    );
    if (!ok) return;
    groups = groups.filter((x) => x !== g);
    for (const w of allWords) if (w.group === g) w.group = "";
    if (activeGroup === g) activeGroup = "__all__";
    await saveGroups();
    await saveWords();
    render();
    return;
  }

  // "+ New" → inline input
  if (tab.id === "add-group") {
    const input = document.createElement("input");
    input.id = "new-group-input";
    input.placeholder = "Group name…";
    tab.replaceWith(input);
    input.focus();

    const commit = async () => {
      const name = input.value.trim();
      if (name && name !== "__all__" && !groups.includes(name)) {
        groups.push(name);
        await saveGroups();
        activeGroup = name;
      }
      render();
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") commit();
      if (ev.key === "Escape") render();
    });
    input.addEventListener("blur", commit);
    return;
  }

  activeGroup = tab.dataset.group;
  render();
});

// ---- Word list ------------------------------------------------------------

function render() {
  renderTabs();

  const q = searchEl.value.trim().toLowerCase();
  let words = allWords;

  if (activeGroup !== "__all__") {
    words = words.filter((w) => (w.group || "") === activeGroup);
  }
  if (q) {
    words = words.filter(
      (w) =>
        w.word.toLowerCase().includes(q) ||
        (w.meaning || "").toLowerCase().includes(q)
    );
  }

  emptyEl.hidden = words.length > 0;
  listEl.innerHTML = "";

  for (const w of words) {
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.id = w.id;

    // --- Column 1: word + meaning + actions
    const meaning = w.meaning
      ? `<div class="meaning">${escapeHtml(w.meaning)}</div>`
      : `<div class="meaning missing">no meaning yet</div>`;

    const groupOptions =
      `<option value="">— no group —</option>` +
      groups
        .map(
          (g) =>
            `<option value="${escapeHtml(g)}" ${
              (w.group || "") === g ? "selected" : ""
            }>${escapeHtml(g)}</option>`
        )
        .join("");

    const pos = w.pos
      ? `<span class="pos">${escapeHtml(w.pos)}</span>`
      : "";

    const definition = w.definition
      ? `<div class="definition">${escapeHtml(w.definition)}</div>`
      : "";

    const needsRetry = !w.meaning || !w.definition;

    // "found in" — a subtle grey link that opens a floating note.
    const foundBtn =
      w.sentence || w.url
        ? '<button class="link muted found-btn">found in</button>'
        : "";

    const col1 = `
      <div class="col1">
        <div class="word">${escapeHtml(w.word)} ${pos}</div>
        ${definition}
        ${meaning}
        <div class="actions">
          <select class="group-select" title="Move to group">${groupOptions}</select>
          ${needsRetry ? '<button class="link retry">Fetch info</button>' : ""}
          <button class="link danger del">Delete</button>
          ${foundBtn}
        </div>
      </div>
    `;

    // --- Column 2: examples
    const col2 = `
      <div class="col3">
        ${
          w.examples
            ? `<div class="examples">${escapeHtml(w.examples)}</div>
               <div class="gen-wrap"><button class="link gen">Regenerate</button></div>`
            : `<div class="no-examples">No examples yet.</div>
               <div class="gen-wrap"><button class="link gen">Generate examples</button></div>`
        }
      </div>
    `;

    // --- Column 3: usage by part of speech ("noun: sentence" lines, label bolded)
    const posExamplesHtml = (w.posExamples || "")
      .split("\n")
      .map((line) =>
        escapeHtml(line).replace(
          /^\s*[-*\d.]*\s*([A-Za-z][A-Za-z ]{2,20}):/,
          '<b class="pos-label">$1:</b>'
        )
      )
      .join("\n");

    const col3 = !ENABLE_POS_USAGE
      ? ""
      : `
      <div class="col4">
        ${
          w.posExamples
            ? `<div class="examples pos-examples">${posExamplesHtml}</div>
               <div class="gen-wrap"><button class="link gen-pos">Regenerate</button></div>`
            : `<div class="no-examples">No usage examples yet.</div>
               <div class="gen-wrap"><button class="link gen-pos">Generate usage</button></div>`
        }
      </div>
    `;

    card.innerHTML = col1 + col2 + col3;
    listEl.appendChild(card);
  }
}

// ---- "found in" floating note ---------------------------------------------

const noteEl = document.createElement("div");
noteEl.id = "found-note";
noteEl.hidden = true;
document.body.appendChild(noteEl);

function hideNote() {
  noteEl.hidden = true;
}

function showNote(anchorBtn, w) {
  noteEl.innerHTML = `
    ${w.sentence ? `<div class="note-sentence">“${escapeHtml(w.sentence)}”</div>` : ""}
    ${
      w.url
        ? `<a class="note-source" href="${escapeHtml(w.url)}" target="_blank" rel="noreferrer">${escapeHtml(
            w.title || w.url
          )}</a>`
        : ""
    }
  `;
  noteEl.hidden = false;

  // Position under the button, kept inside the viewport.
  const r = anchorBtn.getBoundingClientRect();
  const noteW = Math.min(280, window.innerWidth - 20);
  noteEl.style.width = noteW + "px";
  let left = r.left;
  if (left + noteW > window.innerWidth - 10) left = window.innerWidth - noteW - 10;
  noteEl.style.left = Math.max(10, left) + "px";
  noteEl.style.top = r.bottom + 6 + "px";
}

document.addEventListener("click", (e) => {
  if (!noteEl.hidden && !noteEl.contains(e.target) && !e.target.classList.contains("found-btn")) {
    hideNote();
  }
});
document.addEventListener("scroll", hideNote, true);

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

listEl.addEventListener("click", async (e) => {
  const card = e.target.closest(".card");
  if (!card) return;
  const id = card.dataset.id;

  if (e.target.classList.contains("found-btn")) {
    if (!noteEl.hidden && noteEl.dataset.id === id) {
      hideNote();
    } else {
      const entry = allWords.find((w) => w.id === id);
      if (entry) {
        noteEl.dataset.id = id;
        showNote(e.target, entry);
      }
    }
  } else if (e.target.classList.contains("gen")) {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = "Generating…";
    const res = await send({ type: "GENERATE_EXAMPLES", id });
    if (res && res.ok) {
      const entry = allWords.find((w) => w.id === id);
      if (entry) entry.examples = res.examples;
      render();
    } else {
      btn.disabled = false;
      btn.textContent = "Failed — try again";
    }
  } else if (e.target.classList.contains("gen-pos")) {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = "Generating…";
    const res = await send({ type: "GENERATE_POS_EXAMPLES", id });
    if (res && res.ok) {
      const entry = allWords.find((w) => w.id === id);
      if (entry) entry.posExamples = res.posExamples;
      render();
    } else {
      btn.disabled = false;
      btn.textContent = "Failed — try again";
    }
  } else if (e.target.classList.contains("retry")) {
    e.target.disabled = true;
    e.target.textContent = "…";
    const res = await send({ type: "RETRANSLATE", id });
    if (res && res.ok && res.entry) {
      const i = allWords.findIndex((w) => w.id === id);
      if (i !== -1) allWords[i] = res.entry;
    }
    render();
  } else if (e.target.classList.contains("del")) {
    const entry = allWords.find((w) => w.id === id);
    const ok = await confirmModal(
      `Delete <b>${escapeHtml(entry ? entry.word : "this word")}</b> from your vocab?`
    );
    if (!ok) return;
    await send({ type: "DELETE_WORD", id });
    allWords = allWords.filter((w) => w.id !== id);
    render();
  }
});

// Assign a word to a group
listEl.addEventListener("change", async (e) => {
  if (!e.target.classList.contains("group-select")) return;
  const card = e.target.closest(".card");
  const entry = allWords.find((w) => w.id === card.dataset.id);
  if (!entry) return;
  entry.group = e.target.value;
  await saveWords();
  render();
});

searchEl.addEventListener("input", render);

// ---- Flashcard practice mode ----------------------------------------------

const practiceEl = document.getElementById("practice");
const flashcardArea = document.getElementById("flashcard-area");
const flashcardEl = document.getElementById("flashcard");
const answerBtns = document.getElementById("answer-btns");
const practiceDoneEl = document.getElementById("practice-done");
const progressEl = document.getElementById("practice-progress");
const progressFill = document.getElementById("progress-fill");

const listViewEls = [
  document.getElementById("list"),
  document.querySelector(".col-headers"),
  emptyEl,
];

let deck = []; // word ids still to answer this session
let deckTotal = 0; // unique words in this session
let doneIds = new Set(); // answered correctly
let sessionRight = 0;
let sessionWrong = 0;
let current = null; // current word entry

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function practicePool() {
  return activeGroup === "__all__"
    ? allWords
    : allWords.filter((w) => (w.group || "") === activeGroup);
}

function startPractice() {
  const pool = practicePool();
  if (!pool.length) return;

  deck = shuffle(pool.map((w) => w.id));
  deckTotal = deck.length;
  doneIds = new Set();
  sessionRight = 0;
  sessionWrong = 0;

  listViewEls.forEach((el) => el && (el.hidden = true));
  practiceDoneEl.hidden = true;
  flashcardArea.hidden = false;
  practiceEl.hidden = false;

  nextCard();
}

function exitPractice() {
  practiceEl.hidden = true;
  listViewEls.forEach((el) => el && (el.hidden = false));
  render(); // restores empty-state visibility correctly
}

function nextCard() {
  if (!deck.length) {
    finishPractice();
    return;
  }
  const id = deck[0];
  current = allWords.find((w) => w.id === id);
  if (!current) {
    deck.shift();
    nextCard();
    return;
  }

  flashcardEl.classList.remove("flipped");
  answerBtns.hidden = true;

  document.getElementById("flash-word").textContent = current.word;
  document.getElementById("flash-pos").textContent = current.pos || "";
  document.getElementById("flash-meaning").textContent =
    current.meaning || "(no Bengali meaning saved)";
  document.getElementById("flash-definition").textContent =
    current.definition || "";
  document.getElementById("flash-sentence").textContent = current.sentence
    ? "“" + current.sentence + "”"
    : "";

  progressEl.textContent = `${doneIds.size} / ${deckTotal}`;
  progressFill.style.width = (doneIds.size / deckTotal) * 100 + "%";
}

flashcardEl.addEventListener("click", () => {
  const flipped = flashcardEl.classList.toggle("flipped");
  answerBtns.hidden = !flipped;
});

async function answer(gotIt) {
  if (!current) return;
  current.stats = current.stats || { right: 0, wrong: 0 };

  deck.shift();
  if (gotIt) {
    current.stats.right++;
    sessionRight++;
    doneIds.add(current.id);
  } else {
    current.stats.wrong++;
    sessionWrong++;
    // Reinsert a few cards later so it comes back this session.
    const pos = Math.min(3, deck.length);
    deck.splice(pos, 0, current.id);
  }
  current.stats.lastPracticed = Date.now();
  await saveWords();
  nextCard();
}

document.getElementById("btn-got").addEventListener("click", () => answer(true));
document.getElementById("btn-again").addEventListener("click", () => answer(false));

function finishPractice() {
  flashcardArea.hidden = true;
  practiceDoneEl.hidden = false;
  progressEl.textContent = `${deckTotal} / ${deckTotal}`;
  progressFill.style.width = "100%";
  const total = sessionRight + sessionWrong;
  const acc = total ? Math.round((sessionRight / total) * 100) : 100;
  document.getElementById("done-stats").textContent =
    `${deckTotal} word${deckTotal > 1 ? "s" : ""} practiced · ` +
    `${sessionWrong} miss${sessionWrong === 1 ? "" : "es"} · ${acc}% accuracy`;
}

document.getElementById("practice-btn").addEventListener("click", startPractice);
document.getElementById("practice-exit").addEventListener("click", exitPractice);
document.getElementById("practice-close").addEventListener("click", exitPractice);
document.getElementById("practice-again").addEventListener("click", startPractice);

// Keyboard shortcuts: Space = flip, 1 = again, 2 = got it
document.addEventListener("keydown", (e) => {
  if (practiceEl.hidden || !practiceDoneEl.hidden) return;
  if (e.key === " ") {
    e.preventDefault();
    flashcardEl.click();
  } else if (!answerBtns.hidden && e.key === "1") {
    answer(false);
  } else if (!answerBtns.hidden && e.key === "2") {
    answer(true);
  }
});

// Live refresh: when a word is saved from a page while the panel is open.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.words || changes.groups)) {
    if (changes.words) allWords = changes.words.newValue || [];
    if (changes.groups) groups = changes.groups.newValue || [];
    render();
  }
});

load();
