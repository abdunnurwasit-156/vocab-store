// Shows a small "Save word" button when the user selects text on a page.

let btn = null;

function removeButton() {
  if (btn) {
    btn.remove();
    btn = null;
  }
}

function getSentence(selection, selectedText) {
  try {
    const node = selection.anchorNode;
    const container =
      node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    const text = (container && container.textContent) || selectedText;
    // Split into sentences and return the one containing the selection.
    const sentences = text.split(/(?<=[.!?।])\s+/);
    const hit = sentences.find((s) =>
      s.toLowerCase().includes(selectedText.toLowerCase())
    );
    return (hit || "").trim().slice(0, 400);
  } catch (e) {
    return "";
  }
}

function showButton(x, y, selectedText, sentence) {
  removeButton();
  btn = document.createElement("div");
  btn.className = "wvc-save-btn";
  btn.textContent = "＋ Save word";
  btn.style.left = x + "px";
  btn.style.top = y + "px";

  btn.addEventListener("mousedown", (e) => {
    // Prevent clearing the selection before we read it.
    e.preventDefault();
    e.stopPropagation();
  });

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();

    // If the extension was reloaded/updated, this old content script's
    // connection is dead ("Extension context invalidated"). Detect + explain.
    if (!chrome.runtime || !chrome.runtime.id) {
      btn.textContent = "Refresh page to save ↻";
      setTimeout(removeButton, 2500);
      return;
    }

    btn.textContent = "Saving…";
    try {
      chrome.runtime.sendMessage(
        {
          type: "SAVE_WORD",
          payload: {
            word: selectedText,
            sentence,
            url: location.href,
            title: document.title,
          },
        },
        (res) => {
          if (chrome.runtime.lastError) {
            btn.textContent = "Refresh page to save ↻";
            setTimeout(removeButton, 2500);
            return;
          }
          if (res && res.ok) {
            btn.textContent = res.duplicate ? "Already saved ✓" : "Saved ✓";
          } else {
            btn.textContent = "Failed ✕";
          }
          setTimeout(removeButton, 1200);
        }
      );
    } catch (err) {
      // sendMessage throws synchronously when the context is invalidated.
      btn.textContent = "Refresh page to save ↻";
      setTimeout(removeButton, 2500);
    }
  });

  document.body.appendChild(btn);
}

document.addEventListener("mouseup", (e) => {
  // Ignore clicks on our own button.
  if (btn && btn.contains(e.target)) return;

  setTimeout(() => {
    const selection = window.getSelection();
    const selectedText = selection.toString().trim();

    // Only offer to save short selections (a word or short phrase).
    if (!selectedText || selectedText.length > 60 || selectedText.split(/\s+/).length > 4) {
      removeButton();
      return;
    }

    const sentence = getSentence(selection, selectedText);
    showButton(e.pageX + 6, e.pageY + 12, selectedText, sentence);
  }, 10);
});

document.addEventListener("mousedown", (e) => {
  if (btn && !btn.contains(e.target)) removeButton();
});

document.addEventListener("scroll", removeButton, true);
