import { $, escapeHtml, nowTime } from "./dom.js";
import { state } from "./state.js";
import { STATUS_ICONS } from "./icons.js";

function addActivity(text, kind = "") {
  const placeholder = $("activityEmpty");
  if (placeholder) placeholder.remove();
  const clearBtn = $("activityClearBtn");
  if (clearBtn) clearBtn.hidden = false;
  const line = document.createElement("div");
  line.className = "act " + kind;
  const mark = STATUS_ICONS[kind] || STATUS_ICONS.pending;
  line.innerHTML =
    '<span class="act-mark">' +
    mark +
    "</span>" +
    '<span class="act-text">' +
    escapeHtml(text) +
    "</span>" +
    '<span class="act-time">' +
    nowTime() +
    "</span>";
  state.activityStream.appendChild(line);
  state.activityStream.scrollTop = state.activityStream.scrollHeight;
}

// lastContextEntryText — dedupe flag for "Context loaded: …" spam (P1-10).
// Mutable via state.lastContextEntryText (see state.js).

export { addActivity };
