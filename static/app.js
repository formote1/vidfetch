/* ============ VidFetch frontend ============ */
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);

const els = {
  serverDot: $("#server-dot"),
  serverStatus: $("#server-status"),
  fetchForm: $("#fetch-form"),
  urlInput: $("#url"),
  fetchBtn: $("#fetch-btn"),
  hintText: $("#hint-text"),
  infoCard: $("#info-card"),
  thumb: $("#thumb"),
  thumbPh: $(".thumb-ph"),
  thumbBadge: $("#thumb-badge"),
  metaSite: $("#meta-site"),
  metaDuration: $("#meta-duration"),
  metaUploader: $("#meta-uploader"),
  infoTitle: $("#info-title"),
  tabs: document.querySelectorAll(".tab"),
  formats: $("#formats"),
  progressCard: $("#progress-card"),
  progressTitle: $("#progress-title"),
  progressPhase: $("#progress-phase"),
  progressPct: $("#progress-pct"),
  barFill: $("#bar-fill"),
  progressSpeed: $("#progress-speed"),
  progressEta: $("#progress-eta"),
  cancelBtn: $("#cancel-btn"),
  saveBtn: $("#save-btn"),
  libCount: $("#lib-count"),
  libGrid: $("#lib-grid"),
  emptyState: $("#empty-state"),
  toasts: $("#toasts"),
};

/* ---------------- state ---------------- */
let meta = null;            // fetched /api/info result
let activeJobId = null;     // job shown in the progress card
let lastJobJson = "";       // for diffing library renders
let knownJobs = new Map();  // id -> last status (for transition toasts)

/* ---------------- helpers ---------------- */
function fmtBytes(n) {
  if (n == null || Number.isNaN(n) || n < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}
function fmtDuration(sec) {
  if (sec == null) return "—";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h ${m.toString().padStart(2, "0")}m`;
  if (m) return `${m}m ${s.toString().padStart(2, "0")}s`;
  return `${s}s`;
}
function fmtSpeed(bps) {
  if (bps == null) return "—";
  return `${fmtBytes(bps)}/s`;
}
function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return "video"; }
}
function toast(msg, type = "info") {
  const el = document.createElement("div");
  el.className = `toast${type === "error" ? " toast--error" : ""}${type === "ok" ? " toast--ok" : ""}`;
  const icon = type === "error"
    ? '<svg class="toast__icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5h.01"/></svg>'
    : type === "ok"
      ? '<svg class="toast__icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>'
      : '<svg class="toast__icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8h.01M11 12h1v4h1"/></svg>';
  el.innerHTML = `${icon}<div class="toast__msg"></div>`;
  el.querySelector(".toast__msg").textContent = msg;
  els.toasts.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity .3s";
    setTimeout(() => el.remove(), 320);
  }, 4200);
}
async function api(url, opts) {
  const res = await fetch(url, opts);
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
function setFetching(on) {
  els.fetchBtn.disabled = on;
  els.fetchBtn.querySelector(".btn__label").hidden = on;
  els.fetchBtn.querySelector(".btn__spinner").hidden = !on;
}

/* ---------------- fetch video info ---------------- */
els.fetchForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = els.urlInput.value.trim();
  if (!raw) {
    toast("Please paste a video URL.", "error");
    els.urlInput.focus();
    return;
  }
  setFetching(true);
  els.hintText.textContent = "Reading video info…";
  try {
    const data = await api(`/api/info?url=${encodeURIComponent(raw)}`);
    if (!data.ok) throw new Error(data.error || "Could not read this URL.");
    renderInfo(data);
  } catch (err) {
    toast(err.message, "error");
  } finally {
    setFetching(false);
    els.hintText.textContent = "Supports 1,000+ sites handled by yt-dlp";
  }
});

function renderInfo(data) {
  meta = data;
  els.infoCard.hidden = false;
  els.infoTitle.textContent = data.title;
  els.metaSite.textContent = domainOf(data.webpage_url || data.thumbnail || "");
  els.metaSite.title = data.webpage_url || "";
  els.metaDuration.hidden = !data.duration_string;
  els.metaDuration.textContent = data.duration_string || "";
  els.metaUploader.hidden = !data.uploader;
  els.metaUploader.textContent = data.uploader || "";

  if (data.thumbnail) {
    const img = new Image();
    img.onload = () => {
      els.thumb.src = data.thumbnail;
      els.thumb.hidden = false;
      els.thumbPh.hidden = true;
    };
    img.src = data.thumbnail;
  } else {
    els.thumb.hidden = true;
    els.thumbPh.hidden = false;
    els.thumbPh.textContent = (data.title || "?").trim().split(" ")[0].slice(0, 3).toUpperCase();
  }
  els.thumbBadge.hidden = false;
  els.thumbBadge.textContent = data.is_live ? "LIVE" : (data.duration_string || "video");
  renderFormats("video");
  els.infoCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* ---------------- format tabs ---------------- */
els.tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => {
      const on = t === tab;
      t.classList.toggle("is-active", on);
      t.setAttribute("aria-selected", String(on));
    });
    renderFormats(tab.dataset.tab);
  });
});

const VIDEO_FORMATS = [
  { q: "best", label: "Best", tag: "MP4" },
  { q: "2160", label: "2160p", tag: "4K" },
  { q: "1440", label: "1440p", tag: "2K" },
  { q: "1080", label: "1080p", tag: "Full HD" },
  { q: "720", label: "720p", tag: "HD" },
  { q: "480", label: "480p", tag: "SD" },
  { q: "360", label: "360p", tag: "SD" },
];
const AUDIO_FORMATS = [
  { q: "mp3", label: "MP3", tag: "192 kbps" },
  { q: "m4a", label: "M4A", tag: "AAC" },
  { q: "opus", label: "OPUS", tag: "Efficient" },
  { q: "flac", label: "FLAC", tag: "Lossless" },
];

function renderFormats(kind) {
  const list = kind === "video" ? VIDEO_FORMATS : AUDIO_FORMATS;
  els.formats.innerHTML = "";
  for (const f of list) {
    const btn = document.createElement("button");
    btn.className = "format";
    btn.type = "button";
    btn.title = `Download ${f.label} ${kind === "video" ? "video (MP4)" : "audio"} — ${f.tag}`;
    btn.innerHTML = `<span class="format__q"></span><span class="format__tag"></span>`;
    btn.querySelector(".format__q").textContent = f.label;
    btn.querySelector(".format__tag").textContent = f.tag;
    btn.addEventListener("click", () => startDownload(kind, f.q, btn));
    els.formats.appendChild(btn);
  }
}

/* ---------------- start a download ---------------- */
async function startDownload(kind, quality, btn) {
  if (!meta) { toast("Fetch the video info first.", "error"); return; }
  btn.disabled = true;
  try {
    const body = {
      url: meta.webpage_url || els.urlInput.value.trim(),
      kind,
      quality,
    };
    const data = await api("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!data.ok) throw new Error(data.error || "Download failed to start.");
    showProgressFor(data.job);
    toast("Download started — see progress below.", "info");
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

function showProgressFor(job) {
  activeJobId = job.id;
  els.progressCard.hidden = false;
  els.saveBtn.hidden = true;
  els.cancelBtn.hidden = false;
  els.barFill.classList.remove("bar__fill--done");
  els.progressTitle.textContent = job.title || meta?.title || domainOf(job.url);
  updateProgressUI(job);
  els.progressCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* ---------------- polling ---------------- */
async function refresh() {
  try {
    const data = await api("/api/jobs");
    applyJobs(data.jobs || []);
    els.serverDot.className = "dot dot--ok";
    els.serverStatus.textContent = "Server online";
  } catch {
    els.serverDot.className = "dot dot--err";
    els.serverStatus.textContent = "Server offline";
  }
}

function applyJobs(jobs) {
  // toast on transitions
  for (const job of jobs) {
    const prev = knownJobs.get(job.id);
    if (prev && prev !== job.status && (job.status === "done" || job.status === "error" || job.status === "canceled")) {
      if (job.status === "done") toast(`Finished: ${job.title || "download"}`, "ok");
      else if (job.status === "error") toast(job.error || "Download failed.", "error");
      else toast("Download canceled.", "info");
    }
    knownJobs.set(job.id, job.status);
  }

  // live progress card
  const active = activeJobId ? jobs.find((j) => j.id === activeJobId) : null;
  if (active) updateProgressUI(active);
  else if (activeJobId) {
    activeJobId = null;
    els.progressCard.hidden = true;
  }

  const json = JSON.stringify(jobs.map(({ files, ...j }) => j));
  if (json !== lastJobJson) { renderLibrary(jobs); lastJobJson = json; }
}

function updateProgressUI(job) {
  if (!job) return;
  const pct = Math.round(job.progress);
  els.progressPct.textContent = `${pct}%`;
  els.barFill.style.width = `${Math.min(100, Math.max(0, job.progress))}%`;
  els.progressPhase.textContent = job.phase || job.status;

  if (job.status === "done") {
    els.barFill.classList.add("bar__fill--done");
    els.cancelBtn.hidden = true;
    els.progressPhase.style.color = "";
    els.progressSpeed.textContent = "—";
    els.progressEta.textContent = "—";
    const fileIdx = job.files.findIndex((f) => f.kind === "video" || f.kind === "audio");
    if (fileIdx >= 0) {
      els.saveBtn.hidden = false;
      els.saveBtn.href = `/api/file/${job.id}/${fileIdx}`;
      els.saveBtn.setAttribute("download", job.files[fileIdx].name);
    }
  } else if (job.status === "error" || job.status === "canceled") {
    els.barFill.classList.remove("bar__fill--done");
    els.cancelBtn.hidden = true;
    els.saveBtn.hidden = true;
    els.progressPhase.textContent = job.error || "Canceled";
    els.progressPhase.style.color = "var(--red)";
    els.progressSpeed.textContent = "—";
    els.progressEta.textContent = "—";
  } else {
    els.progressPhase.style.color = "";
    els.cancelBtn.hidden = false;
    els.progressSpeed.textContent = `Speed ${fmtSpeed(job.speed)}`;
    els.progressEta.textContent = job.eta != null ? `ETA ${fmtDuration(job.eta)}` : "—";
  }
}

/* ---------------- library ---------------- */
function renderLibrary(jobs) {
  const completed = jobs.filter((j) => j.status === "done" && j.files.length);
  els.libCount.textContent = `${completed.length} file${completed.length === 1 ? "" : "s"}`;
  if (!completed.length) {
    els.libGrid.innerHTML = "";
    els.emptyState.hidden = false;
    els.libGrid.appendChild(els.emptyState);
    return;
  }
  els.emptyState.hidden = true;
  els.libGrid.querySelectorAll(".file-card").forEach((el) => el.remove());

  for (const job of completed) {
    const media = job.files.find((f) => f.kind === "video" || f.kind === "audio");
    if (!media) continue;
    const thumb = job.files.find((f) => f.kind === "thumb");
    const card = document.createElement("article");
    card.className = "file-card";
    const icon = media.kind === "audio"
      ? '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>'
      : '<svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10.5 9.5v5l4.5-2.5z" fill="currentColor"/></svg>';
    const ext = media.name.split(".").pop().toUpperCase();
    const size = media.size > 0 ? fmtBytes(media.size) : "—";
    const idx = job.files.indexOf(media);

    card.innerHTML = `
      <div class="file-card__thumb">
        ${thumb ? `<img src="/api/file/${job.id}/${job.files.indexOf(thumb)}" alt="" loading="lazy">` : icon}
        <span class="file-card__badge">${ext} · ${job.kind === "audio" ? job.quality.toUpperCase() : media.kind}</span>
      </div>
      <div class="file-card__body">
        <div class="file-card__name"></div>
        <div class="file-card__meta">
          <span>${size}</span><span>·</span><span>${domainOf(job.url)}</span>
        </div>
        <div class="file-card__actions">
          <a class="btn btn--primary" href="/api/file/${job.id}/${idx}" download="${media.name}">Save</a>
          <button class="btn btn--danger" data-del="${job.id}">Delete</button>
        </div>
      </div>`;
    card.querySelector(".file-card__name").textContent = job.title || media.name;
    card.querySelector('[data-del]').addEventListener("click", async (ev) => {
      ev.currentTarget.disabled = true;
      try {
        await api(`/api/jobs/${ev.currentTarget.dataset.del}`, { method: "DELETE" });
        knownJobs.delete(job.id);
        lastJobJson = "";
        await refresh();
        toast("Download removed.", "info");
      } catch (err) {
        toast(err.message, "error");
        ev.currentTarget.disabled = false;
      }
    });
    els.libGrid.appendChild(card);
  }
}

/* ---------------- cancel ---------------- */
els.cancelBtn.addEventListener("click", async () => {
  if (!activeJobId) return;
  els.cancelBtn.disabled = true;
  try {
    await api(`/api/jobs/${activeJobId}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    els.progressPhase.textContent = "Canceling…";
  } catch (err) {
    toast(err.message, "error");
    els.cancelBtn.disabled = false;
  }
});

/* ---------------- boot ---------------- */
refresh();
setInterval(refresh, 1200);
document.querySelectorAll(".tabs .tab")[0].click(); // ensure active styling