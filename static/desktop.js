/* ============ VidFetch Desktop frontend ============ */
"use strict";

const $ = (sel, root = document) => root.querySelector(sel);

const els = {
  serverDot: $("#server-dot"),
  serverStatus: $("#server-status"),
  fetchForm: $("#fetch-form"),
  urlInput: $("#url"),
  fetchBtn: $("#fetch-btn"),
  qualityPills: $("#quality-pills"),
  autoPill: $("#auto-pill"),
  infoPanel: $("#info-panel"),
  thumb: $("#thumb"),
  thumbPh: $("#thumb-ph"),
  thumbBadge: $("#thumb-badge"),
  metaSite: $("#meta-site"),
  metaDuration: $("#meta-duration"),
  metaUploader: $("#meta-uploader"),
  infoTitle: $("#info-title"),
  segBtns: document.querySelectorAll(".seg-btn"),
  playlistPanel: $("#playlist-panel"),
  plSelectAll: $("#pl-select-all"),
  plSelected: $("#pl-selected"),
  playlistList: $("#playlist-list"),
  audioNote: $("#audio-note"),
  progressPanel: $("#progress-panel"),
  progressTitle: $("#progress-title"),
  progressPhase: $("#progress-phase"),
  progressPct: $("#progress-pct"),
  barFill: $("#bar-fill"),
  progressSize: $("#progress-size"),
  progressSpeed: $("#progress-speed"),
  progressEta: $("#progress-eta"),
  cancelBtn: $("#cancel-btn"),
  saveBtn: $("#save-btn"),
  emptyPane: $("#empty-pane"),
  libCount: $("#lib-count"),
  libList: $("#lib-list"),
  libEmpty: $("#lib-empty"),
  statusLeft: $("#status-left"),
  statusRight: $("#status-right"),
  toasts: $("#toasts"),
};

/* ---------------- state ---------------- */
let meta = null;
let kind = "video";
let quality = "best";
let activeJobId = null;
let knownJobs = new Map();
let autoSaved = new Set();
let selected = new Set();

/* ---------------- helpers ---------------- */
function fmtBytes(n) {
  if (n == null || Number.isNaN(n) || n < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
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
  return bps == null ? "—" : `${fmtBytes(bps)}/s`;
}
function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return "video"; }
}
function toast(msg, type = "info") {
  const el = document.createElement("div");
  el.className = `toast${type === "error" ? " toast--error" : ""}${type === "ok" ? " toast--ok" : ""}`;
  el.innerHTML = `
    <svg class="toast__icon" viewBox="0 0 24 24" width="15" height="15" fill="none"
         stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5h.01"/>
    </svg><div class="toast__msg"></div>`;
  el.querySelector(".toast__msg").textContent = msg;
  els.toasts.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    el.style.transition = "opacity .3s";
    setTimeout(() => el.remove(), 320);
  }, 3800);
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
function setServer(ok) {
  els.serverDot.className = `dot ${ok ? "dot--ok" : "dot--err"}`;
  els.serverStatus.textContent = ok ? "server online" : "server offline";
  els.statusLeft.textContent = ok ? "server online" : "server offline";
}

/* ---------------- fetch video info ---------------- */
els.fetchForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const raw = els.urlInput.value.trim();
  if (!raw) { toast("Please paste a video URL.", "error"); els.urlInput.focus(); return; }
  setFetching(true);
  try {
    const data = await api(`/api/info?url=${encodeURIComponent(raw)}`);
    if (!data.ok) throw new Error(data.error || "Could not read this URL.");
    renderInfo(data);
  } catch (err) {
    toast(err.message, "error");
  } finally {
    setFetching(false);
  }
});

function renderInfo(data) {
  meta = data;
  els.infoPanel.hidden = false;
  els.emptyPane.hidden = true;
  els.infoTitle.textContent = data.title;
  els.metaSite.textContent = domainOf(data.webpage_url || data.thumbnail || "");
  els.metaSite.title = data.webpage_url || "";
  els.metaDuration.hidden = !data.duration_string && !data.is_playlist;
  if (data.is_playlist) {
    els.metaDuration.textContent = data.truncated
      ? `${data.count} videos · listing ${data.entries.length}`
      : `${data.count} videos`;
  } else {
    els.metaDuration.textContent = data.duration_string || "";
  }
  els.metaUploader.hidden = !data.uploader;
  els.metaUploader.textContent = data.uploader || "";

  if (data.thumbnail) {
    const img = new Image();
    img.onload = () => { els.thumb.src = data.thumbnail; els.thumb.hidden = false; els.thumbPh.hidden = true; };
    img.src = data.thumbnail;
  } else {
    els.thumb.hidden = true;
    els.thumbPh.hidden = false;
    els.thumbPh.textContent = (data.title || "?").trim().split(" ")[0].slice(0, 3).toUpperCase();
  }
  els.thumbBadge.hidden = false;
  els.thumbBadge.textContent = data.is_playlist
    ? "PLAYLIST"
    : (data.is_live ? "LIVE" : (data.duration_string || "video"));

  if (data.is_playlist) renderPlaylist(data);
  else hidePlaylist();
  setKind(kind);
}

/* ---------------- playlist picker ---------------- */
function renderPlaylist(data) {
  selected = new Set();
  els.playlistPanel.hidden = false;
  els.playlistList.innerHTML = "";
  data.entries.forEach((e, i) => {
    const row = document.createElement("div");
    row.className = "pl-row";
    const thumb = e.thumbnail
      ? `<img class="pl-thumb" src="${e.thumbnail}" alt="" loading="lazy">`
      : `<span class="pl-thumb pl-thumb--ph">${(e.title || "?").trim()[0] || "?"}</span>`;
    row.innerHTML = `
      <input type="checkbox" class="pl-check" data-i="${i}" checked>
      <span class="pl-num">${i + 1}</span>
      ${thumb}
      <span class="pl-body">
        <span class="pl-title"></span>
        <span class="pl-dur">${e.duration_string ? e.duration_string + " · " : ""}video</span>
      </span>`;
    row.querySelector(".pl-title").textContent = e.title;
    row.querySelector(".pl-check").addEventListener("change", (ev) => {
      if (ev.target.checked) selected.add(i);
      else selected.delete(i);
      updateSelection();
    });
    els.playlistList.appendChild(row);
  });
  selected = new Set(data.entries.map((_, i) => i));
  updateSelection();
}
function hidePlaylist() {
  selected = new Set();
  els.playlistPanel.hidden = true;
  els.playlistList.innerHTML = "";
}
function updateSelection() {
  const n = meta && meta.entries ? meta.entries.length : 0;
  els.plSelected.textContent = `${selected.size} of ${n} selected`;
  els.plSelectAll.checked = n > 0 && selected.size === n;
}
els.plSelectAll.addEventListener("change", (ev) => {
  if (!meta || !meta.is_playlist) return;
  els.playlistList.querySelectorAll(".pl-check").forEach((c) => { c.checked = ev.target.checked; });
  selected = new Set();
  if (ev.target.checked) meta.entries.forEach((_, i) => selected.add(i));
  updateSelection();
});

/* ---------------- video / audio toggle ---------------- */
els.segBtns.forEach((btn) => btn.addEventListener("click", () => setKind(btn.dataset.kind)));

function setKind(next) {
  kind = next === "audio" ? "audio" : "video";
  els.segBtns.forEach((b) => {
    const on = b.dataset.kind === kind;
    b.classList.toggle("is-active", on);
  });
  els.qualityPills.hidden = kind !== "video";
  els.autoPill.hidden = kind === "video";
  els.audioNote.hidden = kind === "video";
  if (kind === "video") renderQualityPills();
}

/* ---------------- quality pills ---------------- */
const VIDEO_FORMATS = [
  { q: "best", label: "Best" },
  { q: "2160", label: "2160p" },
  { q: "1440", label: "1440p" },
  { q: "1080", label: "1080p" },
  { q: "720", label: "720p" },
  { q: "480", label: "480p" },
  { q: "360", label: "360p" },
];
function renderQualityPills() {
  els.qualityPills.innerHTML = "";
  for (const f of VIDEO_FORMATS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "quality-pill";
    if (f.q === quality) btn.classList.add("is-active");
    btn.textContent = f.label;
    btn.addEventListener("click", () => {
      quality = f.q;
      els.qualityPills.querySelectorAll(".quality-pill").forEach((p) =>
        p.classList.toggle("is-active", p === btn));
      startDownload("video", f.q, btn);
    });
    els.qualityPills.appendChild(btn);
  }
}

/* ---------------- start a download ---------------- */
async function startDownload(kindArg, qualityArg, btn) {
  if (!meta) { toast("Fetch the video info first.", "error"); return; }
  btn.disabled = true;
  try {
    const body = {
      url: meta.webpage_url || els.urlInput.value.trim(),
      kind: kindArg,
      quality: kindArg === "audio" ? "auto" : qualityArg,
    };
    if (meta.is_playlist) {
      if (!selected.size) { toast("Select at least one video.", "error"); return; }
      body.entries = [...selected].sort((a, b) => a - b)
        .map((i) => meta.entries[i]?.url || meta.entries[i]?.webpage_url || "")
        .filter(Boolean);
      body.title = meta.title;
    }
    const data = await api("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!data.ok) throw new Error(data.error || "Download failed to start.");
    showProgressFor(data.job);
    toast(data.playlist
      ? `Playlist started — ${selected.size} video${selected.size === 1 ? "" : "s"} queued.`
      : "Download started.", "info");
  } catch (err) {
    toast(err.message, "error");
  } finally {
    btn.disabled = false;
  }
}
els.autoPill.addEventListener("click", () => {
  if (kind !== "audio") return;
  startDownload("audio", "auto", els.autoPill);
});

function showProgressFor(job) {
  activeJobId = job.id;
  els.progressPanel.hidden = false;
  els.saveBtn.hidden = true;
  els.cancelBtn.hidden = false;
  els.barFill.classList.remove("bar__fill--done");
  els.progressTitle.textContent = job.title || meta?.title || domainOf(job.url);
  updateProgressUI(job);
}

/* ---------------- polling ---------------- */
async function refresh() {
  try {
    const data = await api("/api/jobs");
    applyJobs(data.jobs || []);
    setServer(true);
  } catch {
    setServer(false);
  }
}

function applyJobs(jobs) {
  for (const job of jobs) {
    const prev = knownJobs.get(job.id);
    if (prev && prev !== job.status &&
        (job.status === "done" || job.status === "error" || job.status === "canceled")) {
      if (job.parent_id) continue;
      if (job.status === "done") toast(`Finished: ${job.title || "download"}`, "ok");
      else if (job.status === "error") toast(job.error || "Download failed.", "error");
      else toast("Download canceled.", "info");
    }
    knownJobs.set(job.id, job.status);
  }
  const active = activeJobId ? jobs.find((j) => j.id === activeJobId) : null;
  if (active) updateProgressUI(active);

  const running = jobs.filter((j) => j.status === "downloading" || j.status === "processing" || j.status === "queued").length;
  const saved = jobs.filter((j) => j.status === "done" && j.files.length).length;
  els.statusRight.textContent = running ? `${running} running · ${saved} saved` : `${saved} saved`;

  const json = JSON.stringify(jobs.map(({ files, ...j }) => j));
  renderLibrary(jobs);
}

/* ---------------- progress ---------------- */
function updateProgressUI(job) {
  if (!job) return;
  if (job.is_playlist) return updatePlaylistProgress(job);
  const pct = Math.round(job.progress);
  els.progressPct.textContent = `${pct}%`;
  els.barFill.style.width = `${Math.min(100, Math.max(0, job.progress))}%`;
  els.progressPhase.textContent = job.phase || job.status;
  els.progressPhase.style.color = "";

  if (job.status === "done") {
    els.barFill.classList.add("bar__fill--done");
    els.cancelBtn.hidden = true;
    els.progressSize.textContent = job.files.some((f) => f.size > 0)
      ? `Size ${fmtBytes(job.files.find((f) => f.size > 0)?.size)}`
      : "Size —";
    els.progressSpeed.textContent = "—";
    els.progressEta.textContent = "—";
    const fileIdx = job.files.findIndex((f) => f.kind === "video" || f.kind === "audio");
    if (fileIdx >= 0) {
      const file = job.files[fileIdx];
      els.saveBtn.hidden = false;
      els.saveBtn.href = `/api/file/${job.id}/${fileIdx}`;
      els.saveBtn.setAttribute("download", file.name);
      if (!autoSaved.has(job.id)) {
        autoSaved.add(job.id);
        triggerDownload(els.saveBtn.href, file.name);
      }
    }
  } else if (job.status === "error" || job.status === "canceled") {
    els.barFill.classList.remove("bar__fill--done");
    els.cancelBtn.hidden = true;
    els.saveBtn.hidden = true;
    els.progressPhase.textContent = job.error || "Canceled";
    els.progressPhase.style.color = "var(--text-dim)";
    els.progressSpeed.textContent = "—";
    els.progressEta.textContent = "—";
  } else {
    els.cancelBtn.hidden = false;
    if (job.total_bytes) {
      els.progressSize.textContent = `${fmtBytes(job.downloaded_bytes)} of ${fmtBytes(job.total_bytes)}`;
    } else if (job.downloaded_bytes) {
      els.progressSize.textContent = fmtBytes(job.downloaded_bytes);
    } else {
      els.progressSize.textContent = "—";
    }
    els.progressSpeed.textContent = `Speed ${fmtSpeed(job.speed)}`;
    els.progressEta.textContent = job.eta != null ? `ETA ${fmtDuration(job.eta)}` : "—";
  }
}

function updatePlaylistProgress(job) {
  const total = job.total_count || job.entries?.length || 0;
  const done = job.done_count || 0;
  const terminal = job.status === "done" || job.status === "error" || job.status === "canceled";
  const pct = total ? Math.round((done / total) * 100) : 0;
  els.progressPct.textContent = `${pct}%`;
  els.barFill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  els.progressPhase.textContent = job.phase || job.status;
  els.progressPhase.style.color = "";
  els.progressSize.textContent = total ? `${done} of ${total} videos` : "—";
  els.progressSpeed.textContent = "—";
  els.progressEta.textContent = "—";
  els.saveBtn.hidden = true;
  if (terminal) {
    if (job.status === "done") els.barFill.classList.add("bar__fill--done");
    else els.barFill.classList.remove("bar__fill--done");
    els.cancelBtn.hidden = true;
    if (job.status === "error" || job.status === "canceled") {
      els.progressPhase.style.color = "var(--text-dim)";
    }
  } else {
    els.barFill.classList.remove("bar__fill--done");
    els.cancelBtn.hidden = false;
  }
}

function triggerDownload(href, name) {
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ---------------- library ---------------- */
function renderLibrary(jobs) {
  const completed = jobs.filter((j) => j.status === "done" && j.files.length);
  els.libCount.textContent = `${completed.length} file${completed.length === 1 ? "" : "s"}`;
  els.libList.querySelectorAll(".file-card").forEach((el) => el.remove());
  els.libEmpty.hidden = completed.length > 0;

  for (const job of completed) {
    const media = job.files.find((f) => f.kind === "video" || f.kind === "audio");
    if (!media) continue;
    const thumb = job.files.find((f) => f.kind === "thumb");
    const ext = media.name.split(".").pop().toUpperCase();
    const size = media.size > 0 ? fmtBytes(media.size) : "—";
    const idx = job.files.indexOf(media);
    const icon = media.kind === "audio"
      ? '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>'
      : '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10.5 9.5v5l4.5-2.5z" fill="currentColor"/></svg>';

    const card = document.createElement("div");
    card.className = "file-card";
    card.innerHTML = `
      <div class="file-card__thumb">
        ${thumb ? `<img src="/api/file/${job.id}/${job.files.indexOf(thumb)}" alt="" loading="lazy">` : icon}
      </div>
      <div class="file-card__body">
        <div class="file-card__name"></div>
        <div class="file-card__meta">
          <span>${ext}${job.kind === "audio" ? " · AUTO" : ""}</span><span>·</span><span>${size}</span><span>·</span><span>${domainOf(job.url)}</span>
        </div>
        <div class="file-card__actions">
          <a class="btn btn--primary" href="/api/file/${job.id}/${idx}" download="${media.name}">Save</a>
          <button class="btn btn--ghost btn--danger" data-del="${job.id}">Delete</button>
        </div>
      </div>`;
    card.querySelector(".file-card__name").textContent = job.title || media.name;
    card.querySelector("[data-del]").addEventListener("click", async (ev) => {
      ev.currentTarget.disabled = true;
      try {
        await api(`/api/jobs/${ev.currentTarget.dataset.del}`, { method: "DELETE" });
        knownJobs.delete(job.id);
        await refresh();
        toast("Download removed.", "info");
      } catch (err) {
        toast(err.message, "error");
        ev.currentTarget.disabled = false;
      }
    });
    els.libList.appendChild(card);
  }
}

/* ---------------- cancel ---------------- */
els.cancelBtn.addEventListener("click", async () => {
  if (!activeJobId) return;
  els.cancelBtn.disabled = true;
  try {
    await api(`/api/jobs/${activeJobId}/cancel`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    els.progressPhase.textContent = "Canceling…";
  } catch (err) {
    toast(err.message, "error");
    els.cancelBtn.disabled = false;
  }
});

/* ---------------- boot ---------------- */
refresh();
setInterval(refresh, 1200);
renderQualityPills();
setKind("video");