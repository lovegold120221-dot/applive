(function() {
  var TRANSLATOR_ID = "orbit-translator";
  var DONATE_ID = "orbit-donate";
  var LIVE_MODEL = "models/gemini-3.5-live-translate-preview";
  // Ephemeral mint tokens go to the Constrained endpoint via access_token
  // (never ?key= — that slot is for API keys and the handshake is refused).
  var LIVE_SOCKET_URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";
  var POLL_MS = 1500;
  var DONATION_AMOUNTS = [10, 25, 50, 100];
  var panel = { active: null, target: "nl", languages: null, languagesLoading: false, openingUntil: 0 };
  // wantActive = user pressed Start and has not pressed Stop / closed the panel.
  // The model session stays up until Stop, panel close, or track failure.
  // Translation input is remote + screenshare audio only — never the local mic
  // (no getUserMedia anywhere in this file).
  var translation = { status: "idle", wantActive: false, error: "", source: "", sourceBuffer: "", sourceLang: "", speaker: "", translated: "", translationBuffer: "", turnClosed: true, signature: "", generation: 0, socket: null, input: null, output: null, sourceNode: null, processor: null, nextTime: 0, playing: [], ducked: false, restoreTimer: null, duckVolumes: null };
  var lastAction = { key: "", time: 0 };

  function appStore() {
    if (window.APP && window.APP.store) {
      return window.APP.store;
    }
    return null;
  }

  function appApi() {
    if (window.APP && window.APP.API) {
      return window.APP.API;
    }
    return null;
  }

  function element(name, attributes, children) {
    var node = document.createElement(name);
    var key;
    if (attributes) {
      for (key in attributes) {
        if (!Object.prototype.hasOwnProperty.call(attributes, key)) {
          continue;
        }
        if (key === "text") {
          node.textContent = attributes[key];
        } else if (key === "htmlFor") {
          node.setAttribute("for", attributes[key]);
        } else {
          node.setAttribute(key, attributes[key]);
        }
      }
    }
    (children || []).forEach(function(child) {
      if (typeof child === "string") {
        node.appendChild(document.createTextNode(child));
      } else if (child) {
        node.appendChild(child);
      }
    });
    return node;
  }

  function panelState() {
    var store = appStore();
    if (!store) {
      return null;
    }
    return store.getState()["features/custom-panel"] || null;
  }

  function panelHost() {
    var root = document.getElementById("custom-panel");
    var index;
    if (root) {
      for (index = 0; index < root.children.length; index += 1) {
        var child = root.children[index];
        if (String(child.className || "").indexOf("contentContainer") !== -1) {
          return child;
        }
      }
    }
    return document.getElementById("orbit-panel-fallback-content");
  }

  function ensureFallbackPanel() {
    if (!panel.active || document.getElementById("custom-panel") || document.getElementById("orbit-panel-fallback")) {
      return;
    }
    var root = element("div", {
      id: "orbit-panel-fallback",
      style: "position:fixed;left:0;top:0;bottom:0;width:min(380px,100vw);z-index:10000;background:#1c1f24;color:#fff;box-shadow:8px 0 28px rgba(0,0,0,.38);display:flex;flex-direction:column;"
    });
    root.appendChild(element("div", {
      id: "orbit-panel-fallback-content",
      style: "display:flex;flex:1;min-height:0;overflow:hidden;"
    }));
    document.body.appendChild(root);
  }

  function setPanelSide(mode) {
    var root = document.getElementById("custom-panel");
    if (!root) {
      return;
    }
    if (mode === "translator") {
      root.setAttribute("data-orbit-side", "left");
    } else if (mode === "donate") {
      root.setAttribute("data-orbit-side", "right");
    } else {
      root.removeAttribute("data-orbit-side");
    }
  }

  function injectPanelSideStyle() {
    if (document.getElementById("orbit-panel-side")) {
      return;
    }
    var style = document.createElement("style");
    style.id = "orbit-panel-side";
    style.textContent = "#custom-panel[data-orbit-side='left']{order:-1;}#custom-panel[data-orbit-side='left'] .customPanelDragHandleContainer{left:auto !important;right:4px !important;}";
    document.head.appendChild(style);
  }

  function closeWrapper() {
    var store = appStore();
    var host = panelHost();
    if (host) {
      host.innerHTML = "";
    }
    var fallback = document.getElementById("orbit-panel-fallback");
    if (fallback && fallback.parentNode) {
      fallback.parentNode.removeChild(fallback);
    }
    panel.active = null;
    panel.openingUntil = 0;
    translation.wantActive = false;
    setPanelSide(null);
    stopTranslation();
    try {
      if (store) {
        store.dispatch({ type: "CUSTOM_PANEL_CLOSE" });
      }
    } catch (ignored) {
      // The fallback panel is already closed even if this Jitsi build cannot dispatch the panel action.
    }
  }

  function openPanel(mode) {
    var store = appStore();
    panel.active = mode;
    panel.openingUntil = Date.now() + 1800;
    setPanelSide(mode);
    if (store) {
      try {
        store.dispatch({ type: "SET_CUSTOM_PANEL_ENABLED", enabled: true });
        store.dispatch({ type: "CUSTOM_PANEL_OPEN" });
      } catch (ignored) {
        // A DOM fallback is mounted below if this Jitsi build cannot open custom-panel.
      }
    }
    window.setTimeout(renderActivePanel, 60);
    window.setTimeout(renderActivePanel, 450);
    window.setTimeout(function() {
      if (!document.getElementById("custom-panel")) {
        ensureFallbackPanel();
      }
      renderActivePanel();
    }, 700);
  }

  function togglePanel(mode) {
    var state = panelState();
    var fallbackOpen = Boolean(document.getElementById("orbit-panel-fallback"));
    if (panel.active === mode && ((state && state.isOpen) || fallbackOpen)) {
      closeWrapper();
    } else {
      translation.wantActive = false;
      stopTranslation();
      openPanel(mode);
    }
  }

  function normalizeKey(value) {
    if (typeof value === "string") {
      return value;
    }
    if (value && typeof value === "object") {
      return value.key || value.id || value.buttonKey || value.buttonId || "";
    }
    return "";
  }

  function handleToolbarKey(key) {
    if (key === TRANSLATOR_ID || key === DONATE_ID) {
      lastAction = { key: key, time: Date.now() };
      togglePanel(key === TRANSLATOR_ID ? "translator" : "donate");
    }
  }

  function wrapNotify() {
    var api = appApi();
    if (!api || typeof api.notifyToolbarButtonClicked !== "function" || api.notifyToolbarButtonClicked.orbitWrapped) {
      return;
    }
    var original = api.notifyToolbarButtonClicked;
    var wrapped = function() {
      try {
        // The document capture listener fires first for the same physical
        // click; skip this duplicate so one click toggles exactly once.
        var key = normalizeKey(arguments.length > 0 ? arguments[0] : "");
        var id = key === TRANSLATOR_ID ? "translator" : key === DONATE_ID ? "donate" : null;
        if (id && !(Date.now() - lastAction.time < 500 && lastAction.key === key)) {
          handleToolbarKey(key);
        }
      } catch (ignored) {
        return original.apply(this, arguments);
      }
      return original.apply(this, arguments);
    };
    wrapped.orbitWrapped = true;
    api.notifyToolbarButtonClicked = wrapped;
  }

  function buttonLabel(node) {
    var label = node.getAttribute("aria-label") || node.getAttribute("title") || node.getAttribute("data-testid") || "";
    if (!label) {
      label = node.textContent || "";
    }
    return String(label).trim().toLowerCase();
  }

  function documentClick(event) {
    var node = event.target && event.target.closest ? event.target.closest("button,[role='button']") : null;
    var image;
    var source;
    if (!node) {
      return;
    }
    image = node.querySelector("img");
    source = image ? String(image.getAttribute("src") || "") : "";
    var label = buttonLabel(node);
    if (source.indexOf("orbit-translator.svg") !== -1 || label === "translator") {
      if (Date.now() - lastAction.time < 500 && lastAction.key === TRANSLATOR_ID) {
        return;
      }
      handleToolbarKey(TRANSLATOR_ID);
      return;
    }
    if (source.indexOf("orbit-donate.svg") !== -1 || label === "donate") {
      if (Date.now() - lastAction.time < 500 && lastAction.key === DONATE_ID) {
        return;
      }
      handleToolbarKey(DONATE_ID);
    }
  }

  function renderActivePanel() {
    var host = panelHost();
    var state = panelState();
    var fallbackOpen = Boolean(document.getElementById("orbit-panel-fallback"));
    if (!host || !panel.active || ((!state || !state.isOpen) && !fallbackOpen)) {
      return;
    }
    var marker = host.querySelector("[data-orbit-panel='" + panel.active + "']");
    if (marker) {
      return;
    }
    host.innerHTML = "";
    if (panel.active === "translator") {
      host.appendChild(renderTranslator());
    } else if (panel.active === "donate") {
      host.appendChild(renderDonate());
    }
  }

  function panelShell(title, body) {
    var wrapper = element("div", { "data-orbit-panel": panel.active, style: "display:flex;flex-direction:column;height:100%;min-height:0;background:inherit;color:inherit;font:inherit;" });
    var header = element("div", { style: "display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 14px 10px;border-bottom:1px solid rgba(128,128,128,.35);" });
    header.appendChild(element("div", { style: "font-size:15px;font-weight:650;" }, [title]));
    var close = element("button", { type: "button", "aria-label": "Close panel", style: "width:34px;height:34px;border:1px solid rgba(128,128,128,.45);border-radius:999px;background:transparent;color:inherit;font-size:18px;line-height:1;cursor:pointer;" }, ["×"]);
    close.addEventListener("click", closeWrapper);
    header.appendChild(close);
    wrapper.appendChild(header);
    wrapper.appendChild(body);
    return wrapper;
  }

  function statusDot(color) {
    return element("span", { style: "width:8px;height:8px;border-radius:999px;background:" + color + ";flex:none;" });
  }

  function loadLanguages(done) {
    if (panel.languages) {
      done(panel.languages);
      return;
    }
    if (panel.languagesLoading) {
      var waiter = window.setInterval(function() {
        if (panel.languages || !panel.languagesLoading) {
          window.clearInterval(waiter);
          done(panel.languages || []);
        }
      }, 250);
      return;
    }
    panel.languagesLoading = true;
    fetch("/api/translation-languages", { headers: { accept: "*/*" } })
      .then(function(response) {
        if (!response.ok) {
          throw new Error("languages");
        }
        return response.json();
      })
      .then(function(languages) {
        panel.languages = Array.isArray(languages) ? languages : [];
        panel.languagesLoading = false;
        done(panel.languages);
      })
      .catch(function() {
        panel.languages = [];
        panel.languagesLoading = false;
        done([]);
      });
  }

  function renderTranslator() {
    var body = element("div", { style: "display:flex;flex-direction:column;min-height:0;flex:1;" });
    var top = element("div", { style: "padding:12px 14px;border-bottom:1px solid rgba(128,128,128,.35);" });
    var label = element("label", { htmlFor: "orbit-language", style: "display:block;font-size:13px;font-weight:600;margin-bottom:8px;" }, ["Translate incoming audio to:"]);
    var select = element("select", { id: "orbit-language", style: "width:100%;height:42px;border:1px solid rgba(128,128,128,.55);border-radius:8px;background:rgba(0,0,0,.18);color:inherit;padding:0 10px;font-size:14px;" });
    select.appendChild(element("option", { value: "", text: "Loading languages…" }));
    select.addEventListener("change", function() {
      if (!select.value) {
        return;
      }
      var changed = select.value !== panel.target;
      panel.target = select.value;
      updateTargetLabel();
      if (changed && translation.wantActive) {
        // Re-mint a session for the new language without leaving the meeting.
        // Transcripts are kept; the socket reconnects automatically.
        translation.signature = "";
        syncTranslation();
      }
    });
    top.appendChild(label);
    top.appendChild(select);
    body.appendChild(top);

    var statusRow = element("div", { style: "display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid rgba(128,128,128,.35);font-size:13px;opacity:.9;" });
    var dot = statusDot("#888");
    var statusText = element("span", { id: "orbit-translation-status", text: "Idle." });
    statusRow.appendChild(dot);
    statusRow.appendChild(statusText);
    body.appendChild(statusRow);

    body.appendChild(element("div", { id: "orbit-sources", style: "padding:8px 14px;border-bottom:1px solid rgba(128,128,128,.35);font-size:12.5px;line-height:1.4;opacity:.8;" }, ["Checking audio…"]));

    var controls = element("div", { style: "padding:12px 14px;border-bottom:1px solid rgba(128,128,128,.35);" });
    var toggle = element("button", { id: "orbit-translate-toggle", type: "button", style: "width:100%;height:44px;border-radius:8px;border:0;background:#e7e9ee;color:#0a0a0b;font-size:14px;font-weight:700;cursor:pointer;" }, ["Start Translation"]);
    toggle.addEventListener("click", function() {
      if (translation.wantActive) {
        translation.wantActive = false;
        stopTranslation();
        translation.status = "idle";
        setTranslationStatus("Stopped.", "#888");
        refreshToggle();
        return;
      }
      translation.wantActive = true;
      translation.error = "";
      syncTranslation();
    });
    controls.appendChild(toggle);
    body.appendChild(controls);

    var scroll = element("div", { style: "flex:1;min-height:0;overflow-y:auto;padding:12px 14px 16px;" });
    scroll.appendChild(element("div", { id: "orbit-source-label", style: "font-size:12px;font-weight:700;opacity:.75;margin-bottom:4px;" }, ["Original"]));
    scroll.appendChild(element("div", { id: "orbit-source-text", style: "font-size:14px;line-height:1.45;margin-bottom:14px;" }, ["Waiting for audio to translate."]));
    scroll.appendChild(element("div", { id: "orbit-target-label", style: "font-size:12px;font-weight:700;opacity:.75;margin-bottom:4px;" }, ["Translation"]));
    scroll.appendChild(element("div", { id: "orbit-translated-text", style: "font-size:14px;line-height:1.45;" }, ["Translation will appear here."]));
    scroll.appendChild(element("div", { style: "margin-top:14px;" }, [
      element("button", { id: "orbit-retry", type: "button", style: "display:none;width:100%;height:42px;border-radius:8px;border:1px solid rgba(128,128,128,.55);background:rgba(255,255,255,.08);color:inherit;font-size:14px;font-weight:600;cursor:pointer;" }, ["Try again"])
    ]));
    body.appendChild(scroll);

    var retry = scroll.querySelector("#orbit-retry");
    if (retry) {
      retry.addEventListener("click", function() {
        translation.error = "";
        if (translation.wantActive) {
          translation.signature = "";
          syncTranslation();
        } else {
          translation.wantActive = true;
          syncTranslation();
        }
      });
    }
    loadLanguages(function(languages) {
      if (panel.active !== "translator") {
        return;
      }
      select.innerHTML = "";
      if (!languages.length) {
        select.appendChild(element("option", { value: "", text: "Languages unavailable" }));
        setTranslationError("The language list could not be loaded. Please try again.");
        refreshToggle();
        return;
      }
      languages.forEach(function(language) {
        if (!language || !language.code) {
          return;
        }
        var option = element("option", { value: language.code, text: language.name || language.code });
        if (language.code === panel.target) {
          option.selected = true;
        }
        select.appendChild(option);
      });
      updateTargetLabel();
      refreshToggle();
      // Do NOT auto-start: the user taps Start Translation explicitly.
      if (!translation.wantActive) {
        setTranslationStatus("Idle.", "#888");
      } else {
        syncTranslation();
      }
    });
    window.setTimeout(function() {
      updateTargetLabel();
      refreshToggle();
      if (translation.wantActive) {
        syncTranslation();
      } else {
        setTranslationStatus("Idle.", "#888");
      }
    }, 50);
    return panelShell("Translator", body);
  }

  function refreshToggle() {
    var toggle = document.querySelector("#orbit-translate-toggle");
    if (!toggle) {
      return;
    }
    if (translation.wantActive) {
      toggle.textContent = "Stop Translation";
      toggle.style.background = "#c34747";
      toggle.style.color = "#ffffff";
    } else {
      toggle.textContent = "Start Translation";
      toggle.style.background = "#e7e9ee";
      toggle.style.color = "#0a0a0b";
    }
    var remote = null;
    try {
      remote = remoteMedia();
    } catch (ignored) {
      remote = null;
    }
    updateSources(remote);
    toggle.disabled = !translation.wantActive && !remote;
    toggle.style.opacity = toggle.disabled ? ".55" : "1";
    toggle.style.cursor = toggle.disabled ? "not-allowed" : "pointer";
  }

  function updateTargetLabel() {
    var node = document.querySelector("#orbit-target-label");
    if (node) {
      node.textContent = languageName(panel.target);
    }
  }

  function updateSourceLabel() {
    var node = document.querySelector("#orbit-source-label");
    if (!node) {
      return;
    }
    var parts = [];
    if (translation.speaker) {
      parts.push(translation.speaker);
    }
    if (translation.sourceLang) {
      parts.push(languageName(translation.sourceLang));
    }
    node.textContent = parts.length ? parts.join(" — ") : "Original";
  }

  function renderDonate() {
    var body = element("div", { style: "flex:1;min-height:0;overflow-y:auto;padding:14px;" });
    var card = element("div", { style: "border:1px solid rgba(128,128,128,.4);border-radius:12px;padding:14px;margin-bottom:14px;" });
    card.appendChild(element("div", { style: "font-size:15px;font-weight:700;margin-bottom:6px;" }, ["Support Orbit"]));
    card.appendChild(element("div", { style: "font-size:13.5px;line-height:1.45;opacity:.9;" }, ["Help keep simple, private meetings open to everyone."]));
    body.appendChild(card);
    body.appendChild(element("div", { style: "font-size:13px;font-weight:700;margin-bottom:8px;" }, ["Donation amount"]));
    var grid = element("div", { style: "display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;" });
    DONATION_AMOUNTS.forEach(function(amount) {
      var choice = element("button", { type: "button", "data-orbit-amount": String(amount), style: "height:44px;border-radius:8px;border:1px solid rgba(128,128,128,.5);background:rgba(255,255,255,.06);color:inherit;font-size:14px;font-weight:650;cursor:pointer;" }, ["$" + amount]);
      choice.addEventListener("click", function() {
        var input = body.querySelector("#orbit-custom-amount");
        if (input) {
          input.value = "";
        }
        donate(amount, body);
      });
      grid.appendChild(choice);
    });
    body.appendChild(grid);
    var customLabel = element("label", { htmlFor: "orbit-custom-amount", style: "display:block;font-size:13px;font-weight:600;margin-bottom:6px;" }, ["Custom amount"]);
    var custom = element("input", { id: "orbit-custom-amount", type: "number", min: "5", max: "500", value: "25", style: "width:100%;height:44px;border:1px solid rgba(128,128,128,.5);border-radius:8px;background:rgba(0,0,0,.18);color:inherit;padding:0 12px;font-size:15px;margin-bottom:12px;" });
    body.appendChild(customLabel);
    body.appendChild(custom);
    var donateButton = element("button", { type: "button", style: "width:100%;height:46px;border:0;border-radius:9px;background:#e7e9ee;color:#0a0a0b;font-size:15px;font-weight:700;cursor:pointer;" }, ["Continue to Stripe"]);
    donateButton.addEventListener("click", function() {
      var amount = Number(custom.value);
      if (!Number.isInteger(amount) || amount < 5 || amount > 500) {
        setDonateMessage(body, "Choose an amount from $5 to $500.", true);
        return;
      }
      donate(amount, body);
    });
    body.appendChild(donateButton);
    body.appendChild(element("div", { id: "orbit-donate-message", role: "status", style: "display:none;margin-top:12px;border:1px solid rgba(128,128,128,.4);border-radius:9px;padding:10px 12px;font-size:13.5px;line-height:1.45;" }));
    return panelShell("Donate", body);
  }

  function setDonateMessage(body, message, isError) {
    var node = body.querySelector("#orbit-donate-message");
    if (!node) {
      return;
    }
    node.style.display = "block";
    node.style.color = isError ? "#ff9d94" : "inherit";
    node.textContent = message;
  }

  function donate(amount, body) {
    var buttons = body.querySelectorAll("button");
    var index;
    for (index = 0; index < buttons.length; index += 1) {
      buttons[index].disabled = true;
    }
    setDonateMessage(body, "Opening checkout…", false);
    fetch("/api/donate", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "*/*" },
      body: JSON.stringify({ amount: amount, returnPath: window.location.pathname || "/" })
    })
      .then(function(response) {
        return response.json().then(function(payload) {
          return { ok: response.ok, payload: payload || {} };
        });
      })
      .then(function(result) {
        var i;
        for (i = 0; i < buttons.length; i += 1) {
          buttons[i].disabled = false;
        }
        if (!result.ok) {
          setDonateMessage(body, result.payload.error || "Checkout could not be created.", true);
          return;
        }
        if (result.payload.mode === "live" && result.payload.url) {
          window.location.assign(result.payload.url);
          return;
        }
        setDonateMessage(body, "Demo donation of $" + amount + " prepared. No payment was taken.", false);
      })
      .catch(function() {
        var i;
        for (i = 0; i < buttons.length; i += 1) {
          buttons[i].disabled = false;
        }
        setDonateMessage(body, "Checkout could not be created.", true);
      });
  }

  // Translation sources: remote participant audio AND shared-screen audio —
  // including the current user's own shared-screen audio, so a local tab or
  // screen share with sound is translated and played back for the current
  // user too. The local microphone is always excluded (never part of the
  // input stream). Like the working reference client, live MediaStreamTracks
  // are pulled directly from the Jitsi tracks into the input AudioContext —
  // never re-attached to hidden elements, never round-tripped through
  // captureStream.
  function isScreenshareTrack(track) {
    if (!track) {
      return false;
    }
    if (track.videoType === "desktop" || track.videoType === "screenshare") {
      return true;
    }
    var jt = track.jitsiTrack || {};
    if (jt.videoType === "desktop" || jt.videoType === "screenshare") {
      return true;
    }
    if (typeof jt.isScreenshare === "function") {
      try {
        if (jt.isScreenshare()) {
          return true;
        }
      } catch (ignored) {
        return false;
      }
    }
    // System-audio / tab-audio shares often surface without a desktop flag
    // but carry it in the underlying MediaStreamTrack label.
    var labels = [];
    try {
      if (track.track && track.track.label) {
        labels.push(String(track.track.label));
      }
    } catch (ignoredLabel) {
      return false;
    }
    try {
      if (jt.track && jt.track.label) {
        labels.push(String(jt.track.label));
      }
    } catch (ignoredJitsiLabel) {
      return false;
    }
    var index;
    for (index = 0; index < labels.length; index += 1) {
      if (/screen|share|system audio|tab audio|desktop/i.test(labels[index])) {
        return true;
      }
    }
    var pid = String(track.participantId || jt.ownerEndpointId || "");
    if (/screenshare|screen-share|desktop/i.test(pid)) {
      return true;
    }
    return false;
  }

  function trackIdentity(track) {
    var jt = track.jitsiTrack || {};
    try {
      if (jt && typeof jt.getId === "function" && jt.getId()) {
        return String(jt.getId());
      }
    } catch (ignored) {
      return "";
    }
    if (track.id) {
      return String(track.id);
    }
    return String(track.participantId || "remote");
  }

  function remoteAudioTracks() {
    var store = appStore();
    var state;
    var tracks;
    if (!store) {
      return [];
    }
    state = store.getState();
    tracks = state["features/base/tracks"] || [];
    return tracks.filter(function(track) {
      if (!track || track.mediaType !== "audio") {
        return false;
      }
      // Local microphone is never translated; a local screenshare-audio
      // track (desktop / system-audio share) is a valid source.
      if (track.local && !isScreenshareTrack(track)) {
        return false;
      }
      if (track.muted) {
        return false;
      }
      // Receiving-data is a remote/bridge concept; local shares are live
      // captures and must not be gated on it.
      if (!track.local && track.isReceivingData === false) {
        return false;
      }
      // The track must expose at least one live audio MediaStreamTrack —
      // pulled directly from the Jitsi track, never re-attached.
      var usable = false;
      try {
        usable = directAudioTracks(track).length > 0;
      } catch (ignoredUsable) {
        usable = false;
      }
      if (!usable) {
        return false;
      }
      return true;
    });
  }

  // One entry per audio track in the Jitsi store, with the include/exclude
  // reason. Powers the sidebar source line and window.__orbitTranslatorDebug.
  function describeAudioTracks() {
    var store = appStore();
    var out = [];
    var state;
    var tracks;
    if (!store) {
      return out;
    }
    try {
      state = store.getState();
    } catch (ignoredState) {
      return out;
    }
    tracks = state["features/base/tracks"] || [];
    tracks.forEach(function(track) {
      var reasons = [];
      var labels = [];
      var ss = false;
      var liveTracks = 0;
      if (!track || track.mediaType !== "audio") {
        return;
      }
      ss = isScreenshareTrack(track);
      if (track.local && !ss) {
        reasons.push("microphone");
      }
      if (track.muted) {
        reasons.push("muted");
      }
      if (!track.local && track.isReceivingData === false) {
        reasons.push("not-receiving");
      }
      try {
        liveTracks = directAudioTracks(track).length;
      } catch (ignoredLive) {
        liveTracks = 0;
      }
      if (!liveTracks) {
        reasons.push("no-audio-track");
      }
      try {
        if (track.track && track.track.label) {
          labels.push(String(track.track.label));
        }
      } catch (ignoredTrack) {
        return;
      }
      try {
        if (track.jitsiTrack && track.jitsiTrack.track && track.jitsiTrack.track.label) {
          labels.push(String(track.jitsiTrack.track.label));
        }
      } catch (ignoredJitsiTrack) {
        return;
      }
      out.push({
        local: !!track.local,
        muted: !!track.muted,
        receiving: track.isReceivingData,
        videoType: track.videoType || (track.jitsiTrack && track.jitsiTrack.videoType) || "",
        labels: labels,
        screenshare: ss,
        liveTracks: liveTracks,
        included: reasons.length === 0,
        reasons: reasons
      });
    });
    return out;
  }

  function sourceSummary(remote) {
    var screens = 0;
    var others = 0;
    var parts = [];
    if (remote && remote.tracks && remote.tracks.length) {
      remote.tracks.forEach(function(track) {
        if (isScreenshareTrack(track)) {
          screens += 1;
        } else {
          others += 1;
        }
      });
      if (screens) {
        parts.push(screens === 1 ? "shared-screen audio" : screens + " shared screens");
      }
      if (others) {
        parts.push(others === 1 ? "1 participant" : others + " participants");
      }
      return "Source: " + parts.join(" + ");
    }
    var desc = describeAudioTracks();
    if (!desc.length) {
      return "No audio in this meeting yet.";
    }
    if (desc.every(function(d) { return d.local && !d.screenshare; })) {
      return "Only your microphone found — share a tab with audio, or wait for others to speak.";
    }
    var blocked = desc.filter(function(d) { return !d.included; });
    if (blocked.length) {
      return "Audio found but unavailable (" + blocked.map(function(d) { return d.reasons.join("+"); }).join(", ") + ").";
    }
    return "Preparing audio…";
  }

  function updateSources(remote) {
    var node = document.querySelector("#orbit-sources");
    if (node) {
      node.textContent = sourceSummary(remote);
    }
    try {
      window.__orbitTranslatorDebug = {
        status: translation.status,
        wantActive: translation.wantActive,
        target: panel.target,
        signature: translation.signature,
        tracks: describeAudioTracks()
      };
    } catch (ignoredDebug) {
      return;
    }
  }

  function languageName(code) {
    var list = panel.languages || [];
    var index;
    for (index = 0; index < list.length; index += 1) {
      if (list[index] && list[index].code === code) {
        return list[index].name || code;
      }
    }
    return code || "Translation";
  }

  // Resolve a Jitsi participant display name from the redux store, trying the
  // shapes used across Jitsi releases. Falls back to null (caller labels).
  function participantName(participantId) {
    var store = appStore();
    var state;
    var slice;
    if (!store || !participantId) {
      return null;
    }
    try {
      state = store.getState();
    } catch (ignored) {
      return null;
    }
    slice = state["features/base/participants"];
    if (!slice) {
      return null;
    }
    var list = [];
    try {
      if (Array.isArray(slice)) {
        list = slice;
      } else if (Array.isArray(slice.remote)) {
        list = slice.remote;
      } else if (slice.remote && typeof slice.remote.forEach === "function") {
        slice.remote.forEach(function(p) {
          list.push(p);
        });
      } else if (typeof slice === "object") {
        Object.keys(slice).forEach(function(key) {
          if (key === "local" || key === "remote") {
            return;
          }
          list.push(slice[key]);
        });
        if (slice.local) {
          list.push(slice.local);
        }
      }
    } catch (ignoredCollect) {
      return null;
    }
    var index;
    for (index = 0; index < list.length; index += 1) {
      var p = list[index];
      if (!p) {
        continue;
      }
      var id = p.id || p.participantId || p.endpointId || p.jwtId;
      if (String(id) === String(participantId)) {
        return p.name || p.displayName || p.displayname || null;
      }
    }
    return null;
  }

  function dominantParticipantId(tracks) {
    var store = appStore();
    var state;
    if (!store) {
      return null;
    }
    try {
      state = store.getState();
    } catch (ignored) {
      return null;
    }
    var speakers = state["features/base/participants"];
    try {
      if (speakers && speakers.dominantSpeakerId) {
        return speakers.dominantSpeakerId;
      }
      if (speakers && speakers.dominantSpeaker) {
        return speakers.dominantSpeaker.id || speakers.dominantSpeaker.participantId || null;
      }
    } catch (ignoredShape) {
      return null;
    }
    void tracks;
    return null;
  }

  function speakerLabelFor(tracks) {
    if (!tracks || !tracks.length) {
      return "";
    }
    var onlyScreenshare = tracks.every(function(track) {
      return isScreenshareTrack(track);
    });
    if (onlyScreenshare) {
      return "Shared screen";
    }
    var dominant = dominantParticipantId(tracks);
    var name = dominant ? participantName(dominant) : null;
    if (name) {
      return name;
    }
    var ids = [];
    tracks.forEach(function(track) {
      var pid = track.participantId || (track.jitsiTrack && track.jitsiTrack.ownerEndpointId);
      if (pid && ids.indexOf(pid) === -1) {
        ids.push(pid);
      }
    });
    if (ids.length === 1) {
      return participantName(ids[0]) || "";
    }
    return "";
  }

  // Live MediaStreamTracks straight out of a Jitsi track wrapper — the way
  // the working reference client feeds its AudioContext: direct streams, no
  // hidden <audio> elements, no re-attach, no captureStream round-trip.
  // Several accessor shapes are tried because lib-jitsi-meet exposes the
  // underlying track differently across versions; only live audio tracks are
  // collected.
  function directAudioTracks(track) {
    var found = [];
    var seen = {};
    function add(mediaTrack) {
      if (!mediaTrack || typeof mediaTrack !== "object") {
        return;
      }
      if (mediaTrack.kind && mediaTrack.kind !== "audio") {
        return;
      }
      if (mediaTrack.readyState && mediaTrack.readyState !== "live") {
        return;
      }
      if (typeof mediaTrack.id === "string" && mediaTrack.id) {
        if (seen[mediaTrack.id]) {
          return;
        }
        seen[mediaTrack.id] = true;
      }
      found.push(mediaTrack);
    }
    function addStream(stream) {
      if (!stream || typeof stream.getAudioTracks !== "function") {
        return;
      }
      var list = [];
      try {
        list = stream.getAudioTracks() || [];
      } catch (ignoredList) {
        return;
      }
      list.forEach(add);
    }
    var jt = (track && track.jitsiTrack) || {};
    try {
      if (typeof jt.getOriginalStream === "function") {
        addStream(jt.getOriginalStream());
      }
    } catch (ignoredOriginal) {
      return found;
    }
    try {
      addStream(jt.stream);
    } catch (ignoredJitsiStream) {
      return found;
    }
    try {
      addStream(track.stream);
    } catch (ignoredWrapperStream) {
      return found;
    }
    try {
      add(jt.track);
    } catch (ignoredJitsiTrack) {
      return found;
    }
    try {
      add(track.track);
    } catch (ignoredWrapperTrack) {
      return found;
    }
    return found;
  }

  function remoteMedia() {
    var tracks = remoteAudioTracks();
    var stream = new MediaStream();
    var signature = [];
    var seen = {};
    tracks.forEach(function(track) {
      signature.push(trackIdentity(track));
      directAudioTracks(track).forEach(function(mediaTrack) {
        if (!seen[mediaTrack.id]) {
          seen[mediaTrack.id] = true;
          try {
            stream.addTrack(mediaTrack);
          } catch (ignoredAdd) {
            return;
          }
        }
      });
    });
    if (!stream.getAudioTracks().length) {
      return null;
    }
    return { stream: stream, signature: signature.sort().join("|"), tracks: tracks };
  }

  // Temporarily lower the original conference audio while translated speech
  // plays, so the two voices do not compete at full volume. Only Jitsi's own
  // audible <audio> elements are touched — translation output runs through
  // WebAudio, so no exclusions are needed.
  function jitsiAudioElements() {
    return Array.prototype.slice.call(document.querySelectorAll("audio"));
  }

  function duckOriginals() {
    if (translation.ducked) {
      return;
    }
    translation.ducked = true;
    if (translation.restoreTimer) {
      window.clearTimeout(translation.restoreTimer);
      translation.restoreTimer = null;
    }
    if (!translation.duckVolumes) {
      translation.duckVolumes = [];
      jitsiAudioElements().forEach(function(node) {
        try {
          translation.duckVolumes.push({ node: node, volume: node.volume });
          node.volume = Math.min(node.volume, 0.15);
        } catch (ignored) {
          return;
        }
      });
    } else {
      jitsiAudioElements().forEach(function(node) {
        try {
          node.volume = Math.min(node.volume, 0.15);
        } catch (ignoredVolume) {
          return;
        }
      });
    }
  }

  function restoreOriginals(immediate) {
    if (!translation.ducked) {
      return;
    }
    if (translation.restoreTimer) {
      window.clearTimeout(translation.restoreTimer);
      translation.restoreTimer = null;
    }
    if (immediate) {
      restoreVolumes();
      return;
    }
    var wait = 400;
    try {
      if (translation.output && translation.nextTime > translation.output.currentTime) {
        wait = Math.min(2500, Math.max(400, (translation.nextTime - translation.output.currentTime) * 1000 + 250));
      }
    } catch (ignored) {
      wait = 400;
    }
    translation.restoreTimer = window.setTimeout(restoreVolumes, wait);
  }

  function restoreVolumes() {
    translation.restoreTimer = null;
    translation.ducked = false;
    (translation.duckVolumes || []).forEach(function(saved) {
      try {
        if (saved.node && saved.node.isConnected) {
          saved.node.volume = saved.volume;
        }
      } catch (ignored) {
        return;
      }
    });
    translation.duckVolumes = null;
  }

  function setTranslationStatus(text, color) {
    var status = document.querySelector("#orbit-translation-status");
    if (status) {
      status.textContent = text;
    }
    var retry = document.querySelector("#orbit-retry");
    if (retry) {
      retry.style.display = translation.status === "error" ? "block" : "none";
    }
    void color;
  }

  function setTranslationText(kind, text) {
    var node = document.querySelector(kind === "source" ? "#orbit-source-text" : "#orbit-translated-text");
    if (node) {
      node.textContent = text;
    }
  }

  function setTranslationError(message) {
    translation.status = "error";
    translation.wantActive = false;
    translation.error = message;
    restoreOriginals(true);
    setTranslationStatus(message, "#ff9d94");
    setTranslationText("source", translation.source || "Waiting for audio to translate.");
    setTranslationText("translated", translation.translated || "Translation will appear here.");
    var retry = document.querySelector("#orbit-retry");
    if (retry) {
      retry.style.display = "block";
    }
    refreshToggle();
  }

  function stopTranslation() {
    translation.generation += 1;
    translation.status = "idle";
    translation.error = "";
    translation.signature = "";
    restoreOriginals(true);
    if (translation.socket) {
      try {
        translation.socket.close();
      } catch (ignored) {
        translation.socket = null;
      }
      translation.socket = null;
    }
    if (translation.processor) {
      try {
        translation.processor.disconnect();
      } catch (ignoredDisconnect) {
        translation.processor = null;
      }
      translation.processor = null;
    }
    if (translation.sourceNode) {
      try {
        translation.sourceNode.disconnect();
      } catch (ignoredSource) {
        translation.sourceNode = null;
      }
      translation.sourceNode = null;
    }
    translation.playing.forEach(function(source) {
      try {
        source.stop();
      } catch (ignoredStop) {
        return;
      }
    });
    translation.playing = [];
    translation.nextTime = 0;
    if (translation.input) {
      translation.input.close().catch(function() {
        return null;
      });
      translation.input = null;
    }
    if (translation.output) {
      translation.output.close().catch(function() {
        return null;
      });
      translation.output = null;
    }
    // Nothing to detach: input tracks come straight from the Jitsi tracks
    // and were never attached to our own elements.
  }

  function floatToBase64(input) {
    var bytes = new Uint8Array(input.length * 2);
    var view = new DataView(bytes.buffer);
    var index;
    for (index = 0; index < input.length; index += 1) {
      var sample = Math.max(-1, Math.min(1, input[index]));
      view.setInt16(index * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
    }
    var binary = "";
    for (index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
  }

  function base64ToBytes(value) {
    var binary = atob(value);
    var bytes = new Uint8Array(binary.length);
    var index;
    for (index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function scheduleOutput(bytes, output, next) {
    var samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    var buffer = output.createBuffer(1, samples.length, 24000);
    var channel = buffer.getChannelData(0);
    var index;
    for (index = 0; index < samples.length; index += 1) {
      channel[index] = samples[index] / 32768;
    }
    var source = output.createBufferSource();
    source.buffer = buffer;
    source.connect(output.destination);
    var startAt = Math.max(output.currentTime + 0.03, next.value);
    duckOriginals();
    source.start(startAt);
    next.value = startAt + buffer.duration;
    translation.playing.push(source);
    source.onended = function() {
      translation.playing = translation.playing.filter(function(item) {
        return item !== source;
      });
      if (!translation.playing.length) {
        restoreOriginals(false);
      }
    };
  }

  function syncTranslation() {
    var remote;
    if (panel.active !== "translator") {
      return;
    }
    if (!translation.wantActive) {
      refreshToggle();
      return;
    }
    remote = remoteMedia();
    if (!remote) {
      if (translation.signature || translation.status === "connecting" || translation.status === "listening" || translation.status === "playing") {
        stopTranslation();
      }
      translation.status = "idle";
      setTranslationStatus("Waiting for audio to translate.", "#888");
      setTranslationText("source", translation.source || "Waiting for audio to translate.");
      refreshToggle();
      return;
    }
    if (translation.socket && translation.signature === remote.signature + "|" + panel.target) {
      var label = speakerLabelFor(remote.tracks);
      if (label && label !== translation.speaker) {
        translation.speaker = label;
        updateSourceLabel();
      }
      refreshToggle();
      return;
    }
    translation.speaker = speakerLabelFor(remote.tracks) || translation.speaker;
    updateSourceLabel();
    stopTranslation();
    startTranslation(remote.stream, remote.signature + "|" + panel.target, panel.target);
    refreshToggle();
  }

  function startTranslation(stream, signature, target) {
    var generation = translation.generation + 1;
    translation.generation = generation;
    translation.status = "connecting";
    translation.error = "";
    translation.signature = signature;
    translation.source = "";
    translation.sourceBuffer = "";
    translation.sourceLang = "";
    translation.translated = "";
    translation.translationBuffer = "";
    translation.turnClosed = true;
    updateTargetLabel();
    updateSourceLabel();
    setTranslationStatus("Connecting…", "#ffd479");
    setTranslationText("source", "Listening…");
    setTranslationText("translated", "Translation will appear here.");
    var input;
    var output;
    try {
      input = new AudioContext({ sampleRate: 16000 });
      output = new AudioContext({ sampleRate: 24000 });
    } catch (contextError) {
      setTranslationError("This browser cannot start live audio translation.");
      return;
    }
    translation.input = input;
    translation.output = output;
    translation.nextTime = 0;
    input.resume().catch(function() {
      return null;
    });
    output.resume().catch(function() {
      return null;
    });

    fetch("/api/translate-token", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ targetLanguageCode: target })
    })
      .then(function(response) {
        return response.json().then(function(payload) {
          return { ok: response.ok, payload: payload || {} };
        });
      })
      .then(function(result) {
        if (generation !== translation.generation) {
          return;
        }
        if (!result.ok || !result.payload.token || !result.payload.model) {
          setTranslationError(result.payload.error || "Translation could not start. Please try again.");
          stopTranslation();
          translation.status = "error";
          setTranslationError(result.payload.error || "Translation could not start. Please try again.");
          return;
        }
        openLiveSocket(stream, result.payload.token, result.payload.model, target, generation);
      })
      .catch(function() {
        if (generation !== translation.generation) {
          return;
        }
        setTranslationError("Translation could not start. Please try again.");
        stopTranslation();
        translation.status = "error";
        setTranslationError("Translation could not start. Please try again.");
      });
  }

  function openLiveSocket(stream, token, model, target, generation) {
    var socket;
    try {
      socket = new WebSocket(LIVE_SOCKET_URL + "?access_token=" + encodeURIComponent(token));
    } catch (socketError) {
      setTranslationError("Translation could not start. Please try again.");
      stopTranslation();
      translation.status = "error";
      setTranslationError("Translation could not start. Please try again.");
      return;
    }
    translation.socket = socket;
    socket.onopen = function() {
      if (generation !== translation.generation) {
        return;
      }
      socket.send(JSON.stringify({
        setup: {
          model: model.indexOf("models/") === 0 ? model : "models/" + model,
          generationConfig: {
            responseModalities: ["AUDIO"],
            // Must match the locked token config on the server exactly
            // (see api.translate-token.ts) — same shape as the proven
            // working reference app.
            translationConfig: { targetLanguageCode: target, echoTargetLanguage: true }
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {}
        }
      }));
    };
    // Server frames can arrive as string, Blob, or ArrayBuffer — decode all
    // three before parsing, otherwise setupComplete and transcripts are lost.
    function decodeSocketData(data) {
      if (typeof data === "string") {
        return Promise.resolve(data);
      }
      try {
        if (typeof Blob !== "undefined" && data instanceof Blob) {
          return data.text();
        }
      } catch (ignoredBlob) {
        return Promise.resolve("");
      }
      try {
        if (data instanceof ArrayBuffer) {
          return Promise.resolve(new TextDecoder().decode(data));
        }
      } catch (ignoredBuffer) {
        return Promise.resolve("");
      }
      return Promise.resolve("");
    }

    socket.onmessage = function(event) {
      if (generation !== translation.generation) {
        return;
      }
      decodeSocketData(event.data).then(function(text) {
        var message;
        if (generation !== translation.generation || !text) {
          return;
        }
        try {
          message = JSON.parse(text);
        } catch (parseError) {
          return;
        }
        handleLiveMessage(message, stream, generation);
      });
    };

  function handleLiveMessage(message, stream, generation) {
      if (message.setupComplete) {
        translation.status = "listening";
        setTranslationStatus("Listening for remote speech.", "#8fd49a");
        startInput(stream, generation);
        return;
      }
      var content = message.serverContent;
      if (!content) {
        return;
      }
      if (content.interrupted) {
        translation.playing.forEach(function(source) {
          try {
            source.stop();
          } catch (ignored) {
            return;
          }
        });
        translation.playing = [];
        translation.nextTime = translation.output ? translation.output.currentTime : 0;
        restoreOriginals(true);
      }
      // Transcripts arrive as incremental chunks — accumulate them like the
      // reference client instead of overwriting, so partial text no longer
      // flickers or shows only the latest fragment. A new turn resets the
      // buffers; turnComplete closes the turn.
      if (content.inputTranscription && content.inputTranscription.text) {
        if (translation.turnClosed) {
          translation.sourceBuffer = "";
          translation.translationBuffer = "";
          translation.turnClosed = false;
        }
        translation.sourceBuffer += content.inputTranscription.text;
        if (content.inputTranscription.languageCode) {
          translation.sourceLang = content.inputTranscription.languageCode;
        }
        var freshTracks = null;
        try {
          var fresh = remoteMedia();
          freshTracks = fresh ? fresh.tracks : null;
        } catch (ignoredFresh) {
          freshTracks = null;
        }
        if (freshTracks) {
          var freshLabel = speakerLabelFor(freshTracks);
          if (freshLabel) {
            translation.speaker = freshLabel;
          }
        }
        updateSourceLabel();
        translation.source = translation.sourceBuffer.trim();
        setTranslationText("source", translation.source);
      }
      if (content.outputTranscription && content.outputTranscription.text) {
        if (translation.turnClosed) {
          translation.sourceBuffer = "";
          translation.translationBuffer = "";
          translation.turnClosed = false;
        }
        translation.translationBuffer += content.outputTranscription.text;
        translation.translated = translation.translationBuffer.trim();
        translation.status = "playing";
        setTranslationStatus("Playing translation.", "#8fd49a");
        updateTargetLabel();
        setTranslationText("translated", translation.translated);
      }
      (content.modelTurn && content.modelTurn.parts ? content.modelTurn.parts : []).forEach(function(part) {
        if (!part || !part.inlineData || !part.inlineData.data || String(part.inlineData.mimeType || "").indexOf("audio/") !== 0) {
          return;
        }
        translation.status = "playing";
        setTranslationStatus("Playing translation.", "#8fd49a");
        if (translation.output) {
          scheduleOutput(base64ToBytes(part.inlineData.data), translation.output, { get value() { return translation.nextTime; }, set value(next) { translation.nextTime = next; } });
        }
      });
      if (content.turnComplete) {
        translation.turnClosed = true;
        translation.status = "listening";
        setTranslationStatus("Listening for remote speech.", "#8fd49a");
        restoreOriginals(false);
      }
  }

    socket.onerror = function() {
      if (generation !== translation.generation) {
        return;
      }
      setTranslationError("The live translation connection failed. Please try again.");
      stopTranslation();
      translation.status = "error";
      setTranslationError("The live translation connection failed. Please try again.");
    };
    socket.onclose = function() {
      if (generation !== translation.generation) {
        return;
      }
      if (translation.status === "listening" || translation.status === "playing" || translation.status === "connecting") {
        setTranslationError("The live translation connection closed. Please try again.");
        stopTranslation();
        translation.status = "error";
        setTranslationError("The live translation connection closed. Please try again.");
      }
    };
  }

  function downsample(input, fromRate) {
    var rate = fromRate || 16000;
    var ratio;
    var length;
    var output;
    var index;
    var start;
    var end;
    var total;
    var count;
    if (rate === 16000) {
      return input;
    }
    ratio = rate / 16000;
    length = Math.max(1, Math.floor(input.length / ratio));
    output = new Float32Array(length);
    for (index = 0; index < length; index += 1) {
      start = Math.floor(index * ratio);
      end = Math.min(input.length, Math.floor((index + 1) * ratio));
      total = 0;
      count = 0;
      while (start < end) {
        total += input[start];
        start += 1;
        count += 1;
      }
      output[index] = count ? total / count : 0;
    }
    return output;
  }

  // AudioWorklet capture ported from the working reference client
  // (audio.ts `relay-capture` processor). ScriptProcessor is deprecated and
  // throttled on some platforms; the worklet path is preferred with a
  // ScriptProcessor fallback where AudioWorklet is unavailable.
  var CAPTURE_WORKLET_SOURCE = "class CaptureProcessor extends AudioWorkletProcessor{process(inputs){var channel=inputs[0]&&inputs[0][0];if(channel){this.port.postMessage(channel);}return true;}}registerProcessor(\"orbit-capture\",CaptureProcessor);";

  function sendInputFrame(frame, input, generation) {
    var socket = translation.socket;
    if (generation !== translation.generation || !socket || socket.readyState !== 1) {
      return;
    }
    var live = downsample(frame, input.sampleRate);
    socket.send(JSON.stringify({
      realtimeInput: {
        audio: { data: floatToBase64(live), mimeType: "audio/pcm;rate=16000" }
      }
    }));
  }

  function startScriptCapture(input, mix, generation) {
    var processor = input.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = function(event) {
      event.outputBuffer.getChannelData(0).fill(0);
      sendInputFrame(event.inputBuffer.getChannelData(0), input, generation);
    };
    var silent = input.createGain();
    silent.gain.value = 0;
    mix.connect(processor);
    processor.connect(silent);
    silent.connect(input.destination);
    translation.processor = processor;
  }

  function startWorkletCapture(input, mix, generation) {
    var url;
    try {
      url = URL.createObjectURL(new Blob([CAPTURE_WORKLET_SOURCE], { type: "text/javascript" }));
    } catch (urlError) {
      startScriptCapture(input, mix, generation);
      return;
    }
    input.audioWorklet.addModule(url).then(function() {
      try {
        URL.revokeObjectURL(url);
      } catch (ignoredRevoke) {
        return;
      }
      if (generation !== translation.generation || translation.processor) {
        return;
      }
      var node = new AudioWorkletNode(input, "orbit-capture");
      node.port.onmessage = function(event) {
        sendInputFrame(event.data, input, generation);
      };
      var silent = input.createGain();
      silent.gain.value = 0;
      mix.connect(node);
      node.connect(silent);
      silent.connect(input.destination);
      translation.processor = node;
    }).catch(function() {
      try {
        URL.revokeObjectURL(url);
      } catch (ignoredFallbackRevoke) {
        return;
      }
      if (generation !== translation.generation || translation.processor) {
        return;
      }
      try {
        startScriptCapture(input, mix, generation);
      } catch (fallbackError) {
        setTranslationError("This browser cannot capture remote meeting audio.");
        stopTranslation();
        translation.status = "error";
        setTranslationError("This browser cannot capture remote meeting audio.");
      }
    });
  }

  function startInput(stream, generation) {
    var input = translation.input;
    var socket = translation.socket;
    if (!input || !socket || generation !== translation.generation || translation.sourceNode) {
      return;
    }
    try {
      var source = input.createMediaStreamSource(stream);
      var mix = input.createGain();
      source.connect(mix);
      translation.sourceNode = source;
      if (input.audioWorklet) {
        startWorkletCapture(input, mix, generation);
      } else {
        startScriptCapture(input, mix, generation);
      }
    } catch (inputError) {
      setTranslationError("This browser cannot capture remote meeting audio.");
      stopTranslation();
      translation.status = "error";
      setTranslationError("This browser cannot capture remote meeting audio.");
    }
  }

  function poll() {
    var store = appStore();
    if (!store) {
      return;
    }
    wrapNotify();
    if (panel.active === "translator") {
      syncTranslation();
    }
    var state = panelState();
    var fallbackOpen = Boolean(document.getElementById("orbit-panel-fallback"));
    if (panel.active && (!state || !state.isOpen) && !fallbackOpen) {
      if (Date.now() < panel.openingUntil) {
        return;
      }
      ensureFallbackPanel();
    }
    renderActivePanel();
  }

  function boot() {
    if (!window.APP || !appApi() || !appStore()) {
      window.setTimeout(boot, 250);
      return;
    }
    wrapNotify();
    injectPanelSideStyle();
    document.addEventListener("click", documentClick, true);
    window.setInterval(poll, POLL_MS);
    window.setTimeout(poll, 250);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
