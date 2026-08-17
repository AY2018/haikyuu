/* ============================================================
   Hidden Marriage — reader
   Everything runs client-side. Chapter text comes from
   data/book.js; settings, progress, bookmarks and replacement
   rules live in localStorage so the reader reopens exactly
   where you left off.

   Reading position is always stored as {chapter index, ratio
   within that chapter}, which keeps bookmarks valid in both
   paged and continuous mode.
   ============================================================ */
(function () {
  "use strict";

  var BOOK = window.BOOK;
  var KEY = "haikyuu-reader:v1";
  var CHAPTERS = (BOOK && BOOK.chapters) || [];

  var THEMES = [
    { id: "light", label: "Paper",  bg: "#faf9f7", fg: "#22201d" },
    { id: "sepia", label: "Sepia",  bg: "#f4ecd8", fg: "#4a3f2f" },
    { id: "mint",  label: "Mint",   bg: "#eef4ee", fg: "#253027" },
    { id: "slate", label: "Slate",  bg: "#e9eaee", fg: "#262a33" },
    { id: "dark",  label: "Dark",   bg: "#1b1c1f", fg: "#ddd9d3" },
    { id: "black", label: "Black",  bg: "#000000", fg: "#c9c5bf" },
    { id: "custom", label: "Custom", bg: "linear-gradient(135deg,#f7d9c4 0%,#c9d6ea 50%,#2b2b2f 100%)", fg: "#333" }
  ];

  var FONTS = [
    { id: "serif",    label: "Serif",   stack: 'Georgia, "Iowan Old Style", "Times New Roman", serif' },
    { id: "sans",     label: "Sans",    stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' },
    { id: "humanist", label: "Book",    stack: 'Palatino, "Palatino Linotype", "Book Antiqua", "URW Palladio L", serif' },
    { id: "readable", label: "Dyslexia", stack: '"Open Dyslexic", "Comic Sans MS", "Trebuchet MS", Verdana, sans-serif' }
  ];

  var WIDTHS = [
    { id: "narrow", label: "Narrow", value: "28rem" },
    { id: "medium", label: "Medium", value: "34rem" },
    { id: "wide",   label: "Wide",   value: "42rem" },
    { id: "full",   label: "Full",   value: "60rem" }
  ];

  var ALIGNS = [
    { id: "left",    label: "Ragged" },
    { id: "justify", label: "Justified" }
  ];

  var DEFAULTS = {
    theme: "light", customBg: "#faf9f7", customFg: "#22201d",
    font: "serif", fontSize: 19, lineHeight: 1.75, paraGap: 0.9,
    width: "medium", align: "left", hideBar: true, continuous: false
  };

  /* How much runway to keep below the viewport in continuous mode. */
  var GROW_AHEAD = 1600;
  var GROW_BEHIND = 700;

  /* Daily pacing: this many new chapters become readable each calendar day,
     counted in Paris time. Day 1 opens the first batch. */
  var PER_DAY = 3;
  var UNLOCK_TZ = "Europe/Paris";

  /* ---------- persisted state ---------- */
  var state = {
    settings: Object.assign({}, DEFAULTS),
    chapter: 0,          // index into CHAPTERS
    offset: 0,           // ratio (0-1) within that chapter
    read: {},            // chapter number -> true
    bookmarks: [],
    rules: [],           // {id, from, to, matchCase, on}
    start: null          // Paris date (YYYY-MM-DD) the book was opened on
  };

  /* Range of chapters currently in the DOM (continuous mode grows it). */
  var first = 0, last = 0;
  var lastActive = -1;
  var editingRule = null;

  function load() {
    try {
      var saved = JSON.parse(localStorage.getItem(KEY) || "{}");
      if (saved.settings) state.settings = Object.assign({}, DEFAULTS, saved.settings);
      if (typeof saved.chapter === "number") state.chapter = clamp(saved.chapter, 0, CHAPTERS.length - 1);
      if (typeof saved.offset === "number") state.offset = saved.offset;
      if (saved.read) state.read = saved.read;
      if (Array.isArray(saved.bookmarks)) state.bookmarks = saved.bookmarks;
      if (Array.isArray(saved.rules)) state.rules = saved.rules;
      if (typeof saved.start === "string") state.start = saved.start;
    } catch (e) { /* corrupt or unavailable storage: fall back to defaults */ }
  }

  var saveTimer;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 250);
  }

  function flush() {
    clearTimeout(saveTimer);
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* private mode / quota */ }
  }

  /* ---------- helpers ---------- */
  function $(sel) { return document.querySelector(sel); }
  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function scrollMax() {
    return Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
  }
  function barHeight() { return $("#topbar").offsetHeight + 10; }

  var toastTimer;
  function toast(msg) {
    var t = $("#toast");
    t.textContent = msg;
    t.classList.add("is-shown");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove("is-shown"); }, 1600);
  }

  /* ============================================================
     Daily unlock
     Chapters open in batches of PER_DAY, one batch per calendar
     day in Paris. Dates come from Intl rather than the machine's
     own timezone, so the schedule holds while travelling and
     across DST changes.
     ============================================================ */

  function parisYmd(date) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: UNLOCK_TZ, year: "numeric", month: "2-digit", day: "2-digit"
    }).format(date || new Date());
  }

  /* Whole days since the epoch for a YYYY-MM-DD string, so two dates can be
     subtracted without any timezone arithmetic. */
  function dayNumber(ymd) { return Math.round(Date.parse(ymd + "T00:00:00Z") / 86400000); }

  function startDay() {
    if (!state.start) {
      state.start = parisYmd();
      save();
    }
    return state.start;
  }

  /* No daily drip-feed here — every downloaded chapter is readable right away. */
  function unlockedCount() {
    return CHAPTERS.length;
  }

  function isLocked(index) { return index >= unlockedCount(); }

  /* The date chapter `index` becomes readable. */
  function unlockLabel(index) {
    var day = dayNumber(startDay()) + Math.floor(index / PER_DAY);
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short", day: "numeric", month: "short", timeZone: "UTC"
    }).format(new Date(day * 86400000));
  }

  /* Time left until midnight in Paris. Off by an hour on the two DST
     changeover days; the unlock itself compares dates, so it stays exact. */
  function untilNextUnlock() {
    var parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: UNLOCK_TZ, hour12: false, hour: "2-digit", minute: "2-digit"
    }).format(new Date()).split(":");
    var mins = 24 * 60 - (Number(parts[0]) * 60 + Number(parts[1]));
    var h = Math.floor(mins / 60), m = mins % 60;
    return h ? h + "h " + m + "m" : m + "m";
  }

  function updateLock() {
    var unlocked = unlockedCount();
    var edge = state.settings.continuous ? last : state.chapter;
    var atEdge = edge >= unlocked - 1;
    var card = $("#lockCard");

    card.hidden = !(atEdge && unlocked < CHAPTERS.length);
    if (!card.hidden) {
      $("#lockText").textContent =
        "You've reached chapter " + CHAPTERS[unlocked - 1].n + ". The next " +
        PER_DAY + " unlock at midnight in Paris — about " + untilNextUnlock() + " from now.";
    }
  }

  /* ============================================================
     Replacement rules
     Applied when text is rendered, so data/book.js and the
     scraped .txt files stay untouched and every rule is
     reversible.
     ============================================================ */

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  function ruleRegex(rule) {
    return new RegExp(escapeRe(rule.from), rule.matchCase ? "g" : "gi");
  }

  function applyRule(text, rule) {
    return text.replace(ruleRegex(rule), function (match) {
      if (rule.matchCase) return rule.to;
      // Case-insensitive rules follow the capitalisation they replaced, so a
      // name at the start of a sentence still reads correctly.
      var head = match.charAt(0);
      if (head === head.toUpperCase() && head !== head.toLowerCase()) {
        return rule.to.charAt(0).toUpperCase() + rule.to.slice(1);
      }
      return rule.to;
    });
  }

  function transform(text) {
    for (var i = 0; i < state.rules.length; i++) {
      var rule = state.rules[i];
      if (rule.on && rule.from) text = applyRule(text, rule);
    }
    return text;
  }

  /* Occurrences per rule across the whole book, in one pass. Each rule is
     counted against the text as it reaches it, so chained rules stay honest. */
  function ruleCounts() {
    var counts = state.rules.map(function () { return 0; });
    if (!state.rules.length) return counts;

    CHAPTERS.forEach(function (ch) {
      var text = ch.t + "\n" + ch.p.join("\n");
      state.rules.forEach(function (rule, i) {
        if (!rule.from) return;
        var found = text.match(ruleRegex(rule));
        if (found) counts[i] += found.length;
        if (rule.on) text = applyRule(text, rule);
      });
    });
    return counts;
  }

  /* Occurrences of an arbitrary string — used for the live count in the dialog. */
  function countPhrase(phrase, matchCase) {
    if (!phrase) return 0;
    var re = new RegExp(escapeRe(phrase), matchCase ? "g" : "gi");
    var total = 0;
    for (var i = 0; i < CHAPTERS.length; i++) {
      var found = (CHAPTERS[i].t + "\n" + CHAPTERS[i].p.join("\n")).match(re);
      if (found) total += found.length;
    }
    return total;
  }

  function renderRules() {
    var list = $("#ruleList");
    list.textContent = "";
    if (!state.rules.length) {
      list.appendChild(el("li", "empty", "No replacements yet."));
      return;
    }

    var counts = ruleCounts();
    state.rules.forEach(function (rule, i) {
      var li = el("li", "rule" + (rule.on ? "" : " is-off"));

      var pair = el("div", "rule__pair");
      pair.appendChild(el("span", "rule__from", rule.from));
      pair.appendChild(el("span", "rule__arrow", "→"));
      pair.appendChild(el("span", "rule__to", rule.to));
      li.appendChild(pair);

      li.appendChild(el("div", "rule__meta",
        counts[i] + (counts[i] === 1 ? " match" : " matches") +
        (rule.matchCase ? " · case-sensitive" : "") +
        (rule.on ? "" : " · paused")));

      var actions = el("div", "rule__actions");
      actions.appendChild(action(rule.on ? "Pause" : "Resume", function () {
        rule.on = !rule.on;
        refresh();
      }));
      actions.appendChild(action("Edit", function () { openReplaceDialog(rule.from, rule.to, rule); }));
      actions.appendChild(action("Delete", function () {
        state.rules.splice(i, 1);
        refresh();
        toast("Replacement removed");
      }));
      li.appendChild(actions);
      list.appendChild(li);
    });

    function action(label, fn) {
      var b = el("button", null, label);
      b.addEventListener("click", fn);
      return b;
    }
  }

  /* Re-render everything that shows text, keeping the reading position. */
  function refresh() {
    renderRules();
    buildToc();
    render(state.chapter, state.offset);
    save();
  }

  /* ---------- replace dialog ---------- */
  function openReplaceDialog(from, to, rule) {
    editingRule = rule || null;
    $("#replaceHeading").textContent = rule ? "Edit replacement" : "Replace throughout the book";
    $("#findInput").value = from || "";
    $("#replaceInput").value = to || "";
    $("#matchCase").checked = rule ? !!rule.matchCase : false;
    $("#replaceModal").hidden = false;
    document.body.classList.add("is-locked");
    hidePill();
    updateMatchCount();
    var target = from ? $("#replaceInput") : $("#findInput");
    target.focus();
    target.select();
  }

  function closeReplaceDialog() {
    $("#replaceModal").hidden = true;
    editingRule = null;
    if (!panelOpen()) document.body.classList.remove("is-locked");
  }

  var countTimer;
  function updateMatchCount() {
    clearTimeout(countTimer);
    countTimer = setTimeout(function () {
      var phrase = $("#findInput").value;
      var n = countPhrase(phrase, $("#matchCase").checked);
      $("#matchCount").textContent = !phrase
        ? "Type the text you want replaced."
        : n + (n === 1 ? " occurrence" : " occurrences") + " in the book" + (n ? "." : " — check the spelling.");
      $("#replaceSave").disabled = !phrase;
    }, 180);
  }

  function saveReplaceDialog() {
    var from = $("#findInput").value;
    var to = $("#replaceInput").value;
    if (!from) return;

    if (editingRule) {
      editingRule.from = from;
      editingRule.to = to;
      editingRule.matchCase = $("#matchCase").checked;
      toast("Replacement updated");
    } else {
      state.rules.push({
        id: Date.now(), from: from, to: to,
        matchCase: $("#matchCase").checked, on: true
      });
      toast("Applied to the whole book");
    }
    closeReplaceDialog();
    refresh();
  }

  /* ---------- selection pill ---------- */
  function showPill() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return hidePill();

    var text = sel.toString().trim();
    var node = sel.anchorNode;
    var inChapter = node && $("#chapter").contains(node.nodeType === 1 ? node : node.parentNode);
    if (!text || text.length > 200 || !inChapter) return hidePill();

    var rect = sel.getRangeAt(0).getBoundingClientRect();
    var pill = $("#selPill");
    pill.hidden = false;

    var w = pill.offsetWidth, h = pill.offsetHeight;
    var left = clamp(rect.left + rect.width / 2 - w / 2, 8, window.innerWidth - w - 8);
    var above = rect.top - h - 10;
    pill.style.left = left + "px";
    pill.style.top = (above > barHeight() ? above : rect.bottom + 10) + "px";
  }

  function hidePill() { $("#selPill").hidden = true; }

  /* ============================================================
     Rendering
     ============================================================ */

  function buildSection(i) {
    var ch = CHAPTERS[i];
    var sec = el("section", "ch");
    sec.dataset.i = String(i);
    sec.appendChild(el("h1", "ch__title", transform(ch.t)));

    var body = el("div", "ch__body");
    var frag = document.createDocumentFragment();
    ch.p.forEach(function (para) { frag.appendChild(el("p", null, transform(para))); });
    body.appendChild(frag);
    sec.appendChild(body);
    return sec;
  }

  function sections() { return $("#chapter").children; }

  function sectionFor(index) {
    var secs = sections();
    for (var i = 0; i < secs.length; i++) {
      if (Number(secs[i].dataset.i) === index) return secs[i];
    }
    return null;
  }

  function sectionTop(sec) { return sec.getBoundingClientRect().top + window.scrollY; }

  /* Render `index` at `ratio`, in whichever mode is active. */
  function render(index, ratio) {
    index = clamp(index, 0, CHAPTERS.length - 1);
    // Held locally: placeAt() runs onScroll(), which overwrites state.offset
    // with wherever the page actually landed. Before the stream grows, a spot
    // near the end of a chapter can't be reached yet, so re-seating from
    // state.offset would lock in that short position.
    var target = ratio || 0;
    state.chapter = index;
    state.offset = target;

    $("#chapter").textContent = "";
    $("#chapter").appendChild(buildSection(index));
    first = last = index;
    lastActive = -1;

    updateChrome(index);
    placeAt(index, target);
    if (state.settings.continuous) {
      grow();
      placeAt(index, target);   // re-seat now that there is content below
    }
    save();
  }

  /* Scroll so that `ratio` through chapter `index` sits under the top bar. */
  function placeAt(index, ratio) {
    var sec = sectionFor(index);
    if (!sec) return;
    var top = sectionTop(sec) - barHeight();
    var target = ratio > 0 ? top + ratio * sec.offsetHeight : Math.max(0, top);
    // "instant" beats the CSS scroll-behavior: smooth, which would otherwise
    // animate every jump.
    window.scrollTo({ top: clamp(target, 0, scrollMax()), behavior: "instant" });
    onScroll();
  }

  function goTo(index, offset) {
    if (index < 0 || index >= CHAPTERS.length) return;
    if (isLocked(index)) {
      toast("Chapter " + CHAPTERS[index].n + " unlocks " + unlockLabel(index));
      return;
    }
    closePanels();

    if (state.settings.continuous && sectionFor(index)) {
      state.chapter = index;
      placeAt(index, offset || 0);
      grow();
      save();
      return;
    }
    render(index, offset || 0);
  }

  /* Grow the continuous stream in whichever direction the reader is heading. */
  function grow() {
    if (!state.settings.continuous) return;
    var doc = document.documentElement;
    var guard = 0;
    var ceiling = unlockedCount() - 1;   // the stream stops at today's batch

    while (last < ceiling && guard++ < 4 &&
           doc.scrollHeight - (window.scrollY + window.innerHeight) < GROW_AHEAD) {
      $("#chapter").appendChild(buildSection(++last));
    }

    // Prepending shifts everything down, so compensate the scroll position or
    // the reader would appear to jump backwards.
    if (first > 0 && window.scrollY < GROW_BEHIND) {
      var before = doc.scrollHeight;
      $("#chapter").insertBefore(buildSection(--first), $("#chapter").firstChild);
      window.scrollTo({ top: window.scrollY + (doc.scrollHeight - before), behavior: "instant" });
    }
    updateFooter();
  }

  function updateFooter() {
    var continuous = state.settings.continuous;
    $("#chapterNav").hidden = continuous;
    if (continuous) {
      $("#endNote").textContent = last === CHAPTERS.length - 1
        ? "End of the last downloaded chapter." : "";
    }
    updateLock();
  }

  /* Top bar, buttons and TOC state for the chapter currently in view. */
  function updateChrome(index) {
    if (index === lastActive) return;
    lastActive = index;
    var ch = CHAPTERS[index];
    var title = transform(ch.t);

    $("#chapterLabel").textContent = title;
    $("#chapterMeta").textContent = "Chapter " + ch.n + " of " + CHAPTERS.length;
    document.title = title + " — " + BOOK.title;

    $("#prevBtn").disabled = index === 0;
    $("#nextBtn").disabled = index === CHAPTERS.length - 1 || isLocked(index + 1);
    if (!state.settings.continuous) {
      $("#endNote").textContent = index === CHAPTERS.length - 1
        ? "End of the last downloaded chapter."
        : (isLocked(index + 1) ? "" : "Up next · " + transform(CHAPTERS[index + 1].t));
    }
    highlightToc();
    updateBookmarkButton();
    updateLock();
  }

  /* ---------- scroll tracking ---------- */
  var lastY = 0;

  function onScroll() {
    var y = window.scrollY;
    var secs = sections();
    if (!secs.length) return;

    // Which chapter is under the top bar, and how far into it are we?
    var probe = y + barHeight() + 4;
    var active = secs[0];
    for (var i = secs.length - 1; i >= 0; i--) {
      if (sectionTop(secs[i]) <= probe) { active = secs[i]; break; }
    }
    var index = Number(active.dataset.i);
    var ratio = clamp((probe - sectionTop(active)) / Math.max(1, active.offsetHeight), 0, 1);

    state.chapter = index;
    state.offset = ratio;
    updateChrome(index);

    $("#progressFill").style.width = (ratio * 100).toFixed(2) + "%";
    $("#topFab").hidden = y <= 700;
    $("#topFab").classList.toggle("is-shown", y > 700);

    // Near the end counts as read; so does a chapter scrolled past entirely,
    // or one too short to scroll at all.
    if (ratio > 0.9) markRead(CHAPTERS[index].n);
    if (document.documentElement.scrollHeight <= window.innerHeight + 4) markRead(CHAPTERS[index].n);
    for (var j = 0; j < secs.length; j++) {
      if (secs[j].getBoundingClientRect().bottom < 100) markRead(CHAPTERS[Number(secs[j].dataset.i)].n);
    }

    if (state.settings.hideBar) {
      var down = y > lastY;
      $("#topbar").classList.toggle("is-hidden",
        down && y > 220 && !document.body.classList.contains("is-locked"));
    }
    lastY = y;
    save();
  }

  function markRead(n) {
    if (state.read[n]) return;
    state.read[n] = true;
    highlightToc();
    updateBookProgress();
    save();
  }

  /* ---------- table of contents ---------- */
  function buildToc() {
    var list = $("#tocList");
    list.textContent = "";
    CHAPTERS.forEach(function (ch, i) {
      var li = el("li");
      var b = el("button");
      var locked = isLocked(i);
      b.dataset.index = String(i);
      b.appendChild(el("span", "num", String(ch.n)));
      // Locked rows show the unlock date instead of the title — the titles
      // give the plot away.
      b.appendChild(el("span", "txt", locked
        ? "Unlocks " + unlockLabel(i)
        : transform(ch.t).replace(/^Chapter\s+\d+:\s*/i, "")));
      if (locked) b.classList.add("is-locked");
      b.addEventListener("click", function () { goTo(i, 0); });
      li.appendChild(b);
      list.appendChild(li);
    });
    var query = $("#tocSearch").value;
    if (query) filterToc(query);
    highlightToc();
    updateBookProgress();
  }

  function highlightToc() {
    var buttons = $("#tocList").querySelectorAll("button");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].classList.toggle("is-current", i === state.chapter);
      buttons[i].classList.toggle("is-read", !!state.read[CHAPTERS[i].n]);
    }
  }

  function updateBookProgress() {
    var done = Object.keys(state.read).length;
    var unlocked = unlockedCount();
    $("#bookProgress").textContent =
      done + " of " + CHAPTERS.length + " read · " +
      (unlocked < CHAPTERS.length
        ? unlocked + " unlocked · next " + PER_DAY + " in " + untilNextUnlock()
        : "all chapters unlocked");
  }

  function filterToc(query) {
    var q = query.trim().toLowerCase();
    var items = $("#tocList").children;
    for (var i = 0; i < items.length; i++) {
      var title = transform(CHAPTERS[i].t).toLowerCase();
      items[i].hidden = !(!q || title.indexOf(q) !== -1 || String(CHAPTERS[i].n) === q);
    }
  }

  /* ---------- bookmarks ---------- */
  function currentSnippet() {
    var sec = sectionFor(state.chapter);
    if (!sec) return "";
    var paras = sec.querySelectorAll(".ch__body p");
    for (var i = 0; i < paras.length; i++) {
      if (paras[i].getBoundingClientRect().bottom > barHeight() + 20) {
        return paras[i].textContent.slice(0, 140);
      }
    }
    return "";
  }

  function bookmarkHere() {
    var ch = CHAPTERS[state.chapter];
    var existing = findBookmark();
    if (existing !== -1) {
      state.bookmarks.splice(existing, 1);
      toast("Bookmark removed");
    } else {
      state.bookmarks.unshift({
        n: ch.n, index: state.chapter, title: transform(ch.t),
        offset: state.offset, snippet: currentSnippet(), at: Date.now()
      });
      toast("Bookmark saved");
    }
    renderBookmarks();
    updateBookmarkButton();
    save();
  }

  function findBookmark() {
    // A bookmark counts as "here" when it is within 3% of the current spot.
    for (var i = 0; i < state.bookmarks.length; i++) {
      var b = state.bookmarks[i];
      if (b.index === state.chapter && Math.abs(b.offset - state.offset) < 0.03) return i;
    }
    return -1;
  }

  function updateBookmarkButton() {
    $("#bookmarkBtn").classList.toggle("is-on", findBookmark() !== -1);
  }

  function renderBookmarks() {
    var list = $("#bookmarkList");
    list.textContent = "";
    if (!state.bookmarks.length) {
      list.appendChild(el("li", "empty", "No bookmarks yet."));
      return;
    }
    state.bookmarks.forEach(function (b, i) {
      var li = el("li");
      var go = el("button", "go");
      go.appendChild(el("span", "bm-title", b.title));
      go.appendChild(el("span", "bm-sub", Math.round(b.offset * 100) + "% in · " + new Date(b.at).toLocaleDateString()));
      if (b.snippet) go.appendChild(el("span", "bm-snip", b.snippet + "…"));
      go.addEventListener("click", function () { goTo(b.index, b.offset); });

      var del = el("button", "del");
      del.title = "Remove bookmark";
      del.setAttribute("aria-label", "Remove bookmark");
      del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      del.addEventListener("click", function () {
        state.bookmarks.splice(i, 1);
        renderBookmarks();
        updateBookmarkButton();
        save();
      });

      li.appendChild(go);
      li.appendChild(del);
      list.appendChild(li);
    });
  }

  /* ---------- panels ---------- */
  function openPanel(sel) {
    closePanels();
    var panel = $(sel);
    panel.classList.add("is-open");
    panel.setAttribute("aria-hidden", "false");
    $("#scrim").hidden = false;
    document.body.classList.add("is-locked");
    $("#topbar").classList.remove("is-hidden");
    hidePill();
  }

  function closePanels() {
    ["#tocPanel", "#settingsPanel"].forEach(function (sel) {
      $(sel).classList.remove("is-open");
      $(sel).setAttribute("aria-hidden", "true");
    });
    $("#scrim").hidden = true;
    if ($("#replaceModal").hidden) document.body.classList.remove("is-locked");
  }

  function panelOpen() {
    return $("#tocPanel").classList.contains("is-open") || $("#settingsPanel").classList.contains("is-open");
  }

  function showTab(which) {
    [["chapters", "#tabChapters", "#viewChapters"],
     ["bookmarks", "#tabBookmarks", "#viewBookmarks"],
     ["replace", "#tabReplace", "#viewReplace"]].forEach(function (row) {
      var on = row[0] === which;
      $(row[1]).classList.toggle("is-active", on);
      $(row[1]).setAttribute("aria-selected", String(on));
      $(row[2]).hidden = !on;
    });
    if (which === "replace") renderRules();
  }

  /* ---------- settings ---------- */
  function applySettings() {
    var s = state.settings;
    var root = document.documentElement;
    var font = FONTS.filter(function (f) { return f.id === s.font; })[0] || FONTS[0];
    var width = WIDTHS.filter(function (w) { return w.id === s.width; })[0] || WIDTHS[1];

    root.setAttribute("data-theme", s.theme);
    root.style.setProperty("--font", font.stack);
    root.style.setProperty("--fs", s.fontSize + "px");
    root.style.setProperty("--lh", String(s.lineHeight));
    root.style.setProperty("--gap", String(s.paraGap));
    root.style.setProperty("--measure", width.value);
    root.style.setProperty("--align", s.align);
    root.style.setProperty("--c-bg", s.customBg);
    root.style.setProperty("--c-fg", s.customFg);

    var theme = THEMES.filter(function (t) { return t.id === s.theme; })[0];
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = s.theme === "custom" ? s.customBg : (theme ? theme.bg : "#faf9f7");

    $("#customColors").hidden = s.theme !== "custom";
    syncControls();
    save();
  }

  function setSetting(key, value) {
    state.settings[key] = value;
    applySettings();
    // Type size and page width change the layout, so re-seat the position.
    if (key === "fontSize" || key === "lineHeight" || key === "paraGap" ||
        key === "width" || key === "font") {
      placeAt(state.chapter, state.offset);
    }
  }

  function syncControls() {
    var s = state.settings;
    markActive("#themeRow", s.theme);
    markActive("#fontRow", s.font);
    markActive("#widthRow", s.width);
    markActive("#alignRow", s.align);
    $("#fontSize").value = s.fontSize;
    $("#lineHeight").value = s.lineHeight;
    $("#paraGap").value = s.paraGap;
    $("#customBg").value = s.customBg;
    $("#customFg").value = s.customFg;
    $("#hideBar").checked = s.hideBar;
    $("#continuous").checked = s.continuous;
    $("#sizeOut").textContent = s.fontSize + " px";
    $("#lineOut").textContent = Number(s.lineHeight).toFixed(2);
    $("#gapOut").textContent = Number(s.paraGap).toFixed(1) + " em";
  }

  function markActive(sel, value) {
    var nodes = $(sel).children;
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].classList.toggle("is-active", nodes[i].dataset.value === value);
    }
  }

  function buildControls() {
    var themeRow = $("#themeRow");
    THEMES.forEach(function (t) {
      var b = el("button", "swatch");
      b.dataset.value = t.id;
      b.title = t.label;
      b.setAttribute("aria-label", t.label + " theme");
      b.style.background = t.bg;
      b.style.color = t.fg;
      b.appendChild(el("span", null, "Aa"));
      b.addEventListener("click", function () { setSetting("theme", t.id); });
      themeRow.appendChild(b);
    });

    segment("#fontRow", FONTS, "font", function (f, b) { b.style.fontFamily = f.stack; });
    segment("#widthRow", WIDTHS, "width");
    segment("#alignRow", ALIGNS, "align");
  }

  function segment(sel, items, key, decorate) {
    var row = $(sel);
    items.forEach(function (item) {
      var b = el("button", null, item.label);
      b.dataset.value = item.id;
      if (decorate) decorate(item, b);
      b.addEventListener("click", function () { setSetting(key, item.id); });
      row.appendChild(b);
    });
  }

  /* ---------- events ---------- */
  function wire() {
    $("#tocBtn").addEventListener("click", function () {
      openPanel("#tocPanel");
      showTab("chapters");
      var current = $("#tocList").children[state.chapter];
      if (current) current.scrollIntoView({ block: "center" });
    });
    $("#settingsBtn").addEventListener("click", function () { openPanel("#settingsPanel"); });
    $("#bookmarkBtn").addEventListener("click", bookmarkHere);
    $("#scrim").addEventListener("click", closePanels);
    Array.prototype.forEach.call(document.querySelectorAll("[data-close-panel]"), function (b) {
      b.addEventListener("click", closePanels);
    });

    $("#tabChapters").addEventListener("click", function () { showTab("chapters"); });
    $("#tabBookmarks").addEventListener("click", function () { showTab("bookmarks"); });
    $("#tabReplace").addEventListener("click", function () { showTab("replace"); });
    $("#tocSearch").addEventListener("input", function () { filterToc(this.value); });

    $("#prevBtn").addEventListener("click", function () { goTo(state.chapter - 1, 0); });
    $("#nextBtn").addEventListener("click", function () { goTo(state.chapter + 1, 0); });
    $("#topFab").addEventListener("click", function () { window.scrollTo({ top: 0, behavior: "smooth" }); });

    /* replacements */
    $("#selPill").addEventListener("mousedown", function (e) { e.preventDefault(); });
    $("#selPill").addEventListener("click", function () {
      var text = window.getSelection().toString().trim();
      if (text) openReplaceDialog(text, "", null);
    });
    $("#addRuleBtn").addEventListener("click", function () { openReplaceDialog("", "", null); });
    $("#replaceCancel").addEventListener("click", closeReplaceDialog);
    $("#replaceSave").addEventListener("click", saveReplaceDialog);
    $("#findInput").addEventListener("input", updateMatchCount);
    $("#matchCase").addEventListener("change", updateMatchCount);
    $("#replaceModal").addEventListener("click", function (e) {
      if (e.target === this) closeReplaceDialog();
    });
    ["#findInput", "#replaceInput"].forEach(function (sel) {
      $(sel).addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); saveReplaceDialog(); }
      });
    });

    document.addEventListener("mouseup", function () { setTimeout(showPill, 0); });
    document.addEventListener("touchend", function () { setTimeout(showPill, 10); });
    document.addEventListener("selectionchange", function () {
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed) hidePill();
    });

    /* display */
    $("#fontSize").addEventListener("input", function () { setSetting("fontSize", Number(this.value)); });
    $("#lineHeight").addEventListener("input", function () { setSetting("lineHeight", Number(this.value)); });
    $("#paraGap").addEventListener("input", function () { setSetting("paraGap", Number(this.value)); });
    $("#customBg").addEventListener("input", function () { setSetting("customBg", this.value); });
    $("#customFg").addEventListener("input", function () { setSetting("customFg", this.value); });
    $("#hideBar").addEventListener("change", function () {
      setSetting("hideBar", this.checked);
      if (!this.checked) $("#topbar").classList.remove("is-hidden");
    });
    $("#continuous").addEventListener("change", function () {
      setSetting("continuous", this.checked);
      updateFooter();
      render(state.chapter, state.offset);
      toast(this.checked ? "Continuous scrolling on" : "One chapter at a time");
    });

    Array.prototype.forEach.call(document.querySelectorAll("[data-adjust]"), function (b) {
      b.addEventListener("click", function () {
        var input = $("#" + b.dataset.adjust);
        var next = clamp(Number(state.settings[b.dataset.adjust]) + Number(b.dataset.delta),
                         Number(input.min), Number(input.max));
        setSetting(b.dataset.adjust, next);
      });
    });

    $("#resetBtn").addEventListener("click", function () {
      var wasContinuous = state.settings.continuous;
      state.settings = Object.assign({}, DEFAULTS);
      applySettings();
      if (wasContinuous !== state.settings.continuous) render(state.chapter, state.offset);
      else placeAt(state.chapter, state.offset);
      toast("Display reset");
    });

    // Deliberately not rAF-gated: a frame callback that never runs (backgrounded
    // tab) would otherwise wedge the handler and stop tracking the position.
    window.addEventListener("scroll", function () {
      onScroll();
      grow();
    }, { passive: true });

    window.addEventListener("resize", function () { placeAt(state.chapter, state.offset); });

    // beforeunload is unreliable on mobile; pagehide/visibilitychange are not.
    ["pagehide", "visibilitychange", "beforeunload"].forEach(function (evt) {
      window.addEventListener(evt, flush);
    });

    document.addEventListener("keydown", function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (e.key === "Escape") {
        if (!$("#replaceModal").hidden) closeReplaceDialog();
        else closePanels();
        return;
      }
      if (typing || !$("#replaceModal").hidden) return;

      switch (e.key) {
        case "ArrowLeft":  goTo(state.chapter - 1, 0); break;
        case "ArrowRight": goTo(state.chapter + 1, 0); break;
        case "t": case "T": panelOpen() ? closePanels() : $("#tocBtn").click(); break;
        case "s": case "S": panelOpen() ? closePanels() : openPanel("#settingsPanel"); break;
        case "b": case "B": bookmarkHere(); break;
        case "r": case "R": openPanel("#tocPanel"); showTab("replace"); break;
        default: return;
      }
      e.preventDefault();
    });

    wireSwipe();
  }

  /* Horizontal swipe changes chapter; vertical movement cancels it so
     ordinary scrolling never triggers navigation. Off in continuous mode,
     where scrolling already carries you between chapters. */
  function wireSwipe() {
    var x0 = 0, y0 = 0, tracking = false;
    document.addEventListener("touchstart", function (e) {
      if (e.touches.length !== 1 || panelOpen() || state.settings.continuous) { tracking = false; return; }
      tracking = true;
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
    }, { passive: true });

    document.addEventListener("touchend", function (e) {
      if (!tracking) return;
      tracking = false;
      if (window.getSelection && !window.getSelection().isCollapsed) return;
      var dx = e.changedTouches[0].clientX - x0;
      var dy = e.changedTouches[0].clientY - y0;
      if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 2) return;
      goTo(state.chapter + (dx < 0 ? 1 : -1), 0);
    }, { passive: true });
  }

  /* ---------- boot ---------- */
  function init() {
    if (!CHAPTERS.length) {
      $("#chapter").appendChild(el("p", null, "No chapters found — run build_data.py to generate data/book.js."));
      return;
    }
    load();
    startDay();
    // A saved position can sit past the gate if storage was edited or the
    // clock moved backwards.
    if (isLocked(state.chapter)) {
      state.chapter = unlockedCount() - 1;
      state.offset = 0;
    }
    buildControls();
    applySettings();
    buildToc();
    renderBookmarks();
    renderRules();
    wire();
    updateFooter();
    render(state.chapter, state.offset);

    // Keep the countdown honest and open the next batch the moment the Paris
    // date rolls over, without needing a reload.
    var openDay = parisYmd();
    setInterval(function () {
      var today = parisYmd();
      if (today !== openDay) {
        openDay = today;
        buildToc();
        updateChrome(state.chapter);
        if (state.settings.continuous) grow();
        toast(PER_DAY + " new chapters unlocked");
      }
      updateLock();
      updateBookProgress();
    }, 30000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
