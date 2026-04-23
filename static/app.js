const ferStatusEl = document.getElementById("ferStatus");
const scanMoodBtn = document.getElementById("scanMood");
const runFlowBtn = document.getElementById("runFlow");

async function pollFerReady() {
  try {
    const resp = await fetch("/fer_status");
    const data = await resp.json();
    if (data.ready) {
      if (ferStatusEl) {
        if (data.has_detector) {
          ferStatusEl.textContent = "✅ AI model ready – you can now scan your face!";
          ferStatusEl.className = "fer-status-banner ready";
        } else {
          ferStatusEl.textContent = "⚠️ FER not available – mood will default to Neutral.";
          ferStatusEl.className = "fer-status-banner warn";
        }
        setTimeout(() => { if (ferStatusEl) ferStatusEl.style.display = "none"; }, 4000);
      }
      if (scanMoodBtn) { scanMoodBtn.disabled = false; scanMoodBtn.classList.add("primary"); }
      if (runFlowBtn) { runFlowBtn.disabled = false; }
    } else {
      setTimeout(pollFerReady, 1500);
    }
  } catch (e) {
    setTimeout(pollFerReady, 2000);
  }
}
pollFerReady();

// ─── YouTube IFrame Player ──────────────────────────────────────────────────
let ytPlayer = null;
let ytReady = false;

// Dynamically load YouTube IFrame API to ensure it fires after onYouTubeIframeAPIReady is defined
const tag = document.createElement('script');
tag.src = "https://www.youtube.com/iframe_api";
const firstScriptTag = document.getElementsByTagName('script')[0] || document.body;
firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);

window.onYouTubeIframeAPIReady = function () {
  ytPlayer = new YT.Player("youtube-player", {
    width: "260",
    height: "146",
    playerVars: { autoplay: 1, controls: 1, rel: 0, modestbranding: 1, enablejsapi: 1, origin: window.location.origin },
    events: {
      onReady: () => { ytReady = true; },
      onStateChange: (e) => {
        if (e.data === YT.PlayerState.PLAYING) {
          setPlayingUI(true);
          startProgressTimer();
        } else if (e.data === YT.PlayerState.PAUSED) {
          setPlayingUI(false);
          stopProgressTimer();
        } else if (e.data === YT.PlayerState.ENDED) {
          setPlayingUI(false);
          stopProgressTimer();
          playNext();
        }
      },
    },
  });
};

// ─── DOM references ─────────────────────────────────────────────────────────
const video = document.getElementById("video");
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const moodLabel = document.getElementById("moodLabel");
const emotionBars = document.getElementById("emotionBars");
const seedGenres = document.getElementById("seedGenres");
const limitEl = document.getElementById("limit");
const songs = document.getElementById("songs");
const albumCards = document.getElementById("albumCards");
const sortBy = document.getElementById("sortBy");
const npTitle = document.getElementById("npTitle");
const npSub = document.getElementById("npSub");
const npCover = document.getElementById("npCover");
const npProgress = document.getElementById("npProgress");
const playPauseBtn = document.getElementById("playPause");
const ytPlayerWrapper = document.getElementById("ytPlayerWrapper");
const ytToggle = document.getElementById("ytToggle");
const cameraOverlay = document.getElementById("cameraOverlay");
const libraryList = document.getElementById("libraryList");
const libraryEmpty = document.getElementById("libraryEmpty");
const npPlayIcon = document.getElementById("npPlayIcon");

// ─── State ───────────────────────────────────────────────────────────────────
let lastTracks = [];
let currentTrackIndex = -1;
let isPlaying = false;
let progressTimer = null;
let cameraStream = null;
let currentMood = "neutral";
let recentlyPlayed = [];
let autoPlayNext = false;

// ─── Navigation ──────────────────────────────────────────────────────────────
function setActiveView(view) {
  document.querySelectorAll(".nav-item").forEach(item =>
    item.classList.toggle("active", item.dataset.view === view));
  document.querySelectorAll(".view").forEach(section =>
    section.classList.toggle("hidden", section.dataset.view !== view));
  if (view === "library") renderLibrary();
}

// ─── Camera ──────────────────────────────────────────────────────────────────
async function startCamera() {
  if (cameraStream) return;
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: true });
    video.srcObject = cameraStream;
    await new Promise(resolve => {
      if (video.readyState >= 2) return resolve();
      video.onloadedmetadata = () => resolve();
    });
    await video.play();
    if (cameraOverlay) cameraOverlay.style.display = "none";
  } catch (err) {
    alert("Camera access denied: " + err.message);
  }
}

function captureFrame() {
  const w = video.videoWidth || 640;
  const h = video.videoHeight || 480;
  canvas.width = w;
  canvas.height = h;
  ctx.drawImage(video, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.9);
}

// ─── Mood Scan ────────────────────────────────────────────────────────────────
async function scanMood() {
  if (!cameraStream) await startCamera();
  const image = captureFrame();
  try {
    const resp = await fetch("/detect_mood", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Scan failed");
    currentMood = data.mood || "neutral";
    moodLabel.textContent = currentMood;
    renderEmotionBars(data.emotions || {});
    document.querySelectorAll(".mood-chip-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.mood === currentMood));
    autoPlayNext = true;
    await getSongs();
  } catch (err) {
    moodLabel.textContent = "neutral";
    if (emotionBars) emotionBars.innerHTML = `<p class="hint">${err}</p>`;
  }
}

function renderEmotionBars(emotions) {
  if (!emotionBars) return;
  const entries = Object.entries(emotions).sort((a, b) => b[1] - a[1]);
  emotionBars.innerHTML = entries.map(([emotion, score]) => `
    <div class="emotion-bar-row">
      <span class="emotion-label">${emotion}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.round(score * 100)}%"></div></div>
      <span class="emotion-score">${Math.round(score * 100)}%</span>
    </div>`).join("");
}

// ─── Fetch Recommendations ───────────────────────────────────────────────────
async function getSongs() {
  songs.innerHTML = `<div class="loading-spinner"></div>`;
  if (albumCards) albumCards.innerHTML = "";

  try {
    let tracks = [];
    try {
      const resp = await fetch(`/recommend?mood=${encodeURIComponent(currentMood)}&limit=20`);
      if (resp.ok) {
        const data = await resp.json();
        tracks = data.tracks || [];
      }
    } catch (apiErr) {
      console.warn("Music API failed, falling back to local mock database", apiErr);
    }

    // Fallback if mood API fails or returns no tracks
    if (!tracks || tracks.length === 0) {
      const resp = await fetch("/static/music_mock.json");
      if (!resp.ok) throw new Error("Failed to load local music database.");

      const db = await resp.json();
      tracks = db[currentMood];

      // Fallback if mood is missing from JSON
      if (!tracks) {
        tracks = db["neutral"];
      }
    }

    lastTracks = tracks || [];
    renderTracks();

    if (autoPlayNext && lastTracks.length) {
      autoPlayNext = false;
      playTrack(0);
    }
  } catch (err) {
    songs.innerHTML = `<p class="error">${err.message || "Failed to load songs"}</p>`;
  }
}

// ─── Render Tracks ────────────────────────────────────────────────────────────
function renderTracks() {
  songs.innerHTML = "";
  if (albumCards) albumCards.innerHTML = "";

  let tracks = [...lastTracks];
  if (sortBy && sortBy.value === "name_asc")
    tracks.sort((a, b) => a.name.localeCompare(b.name));

  tracks.forEach((t, index) => {
    // Album cards (first 6)
    if (albumCards && index < 6) {
      const card = document.createElement("div");
      card.className = "album-card";
      card.innerHTML = `
        <div class="cover">
          ${t.image ? `<img src="${t.image}" alt="${t.name}" loading="lazy" />` : "<div class='placeholder'></div>"}
          <div class="card-play-overlay"><span class="card-play-icon">▶</span></div>
        </div>
        <div class="card-title">${t.name}</div>
        <div class="card-sub">${t.artists}</div>`;
      card.addEventListener("click", () => playTrack(index));
      albumCards.appendChild(card);
    }

    // Song row
    const row = document.createElement("div");
    row.className = "song row";
    row.id = `track-row-${index}`;
    row.innerHTML = `
      <div class="song-index">${String(index + 1).padStart(2, "0")}</div>
      <div class="song-cover">
        ${t.image ? `<img src="${t.image}" alt="${t.name}" loading="lazy" />` : "<div class='placeholder'></div>"}
      </div>
      <div class="song-info">
        <div class="title">${t.name}</div>
        <div class="artist">${t.artists}</div>
      </div>
      <div class="song-album">${t.album || ""}</div>
      <div class="song-duration">${t.duration || ""}</div>
      <div class="song-actions">
        <button class="row-play-btn" data-index="${index}" title="Play">
          <span class="row-play-icon">▶</span>
        </button>
        <a class="btn small yt-link" href="https://www.youtube.com/watch?v=${t.id}" target="_blank" rel="noopener" title="Open on YouTube">YT ↗</a>
      </div>`;

    // Stop propagation so clicking YT link doesn't trigger track play
    const ytLink = row.querySelector(".yt-link");
    if (ytLink) ytLink.addEventListener("click", (e) => e.stopPropagation());

    // Make the entire row clickable to play/pause
    row.addEventListener("click", () => {
      if (currentTrackIndex === index) {
        if (isPlaying) pauseTrack();
        else resumeTrack();
      } else {
        playTrack(index);
      }
    });

    // Ensure play button explicitly triggers row click
    const playBtn = row.querySelector(".row-play-btn");
    if (playBtn) playBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      row.click();
    });

    songs.appendChild(row);
  });
}

// update row-play-btn icons to reflect current state
function updateRowButtons() {
  document.querySelectorAll(".row-play-btn").forEach(btn => {
    const idx = parseInt(btn.dataset.index, 10);
    const icon = btn.querySelector(".row-play-icon");
    if (idx === currentTrackIndex && isPlaying) {
      btn.classList.add("playing");
      if (icon) icon.textContent = "⏸";
    } else {
      btn.classList.remove("playing");
      if (icon) icon.textContent = "▶";
    }
  });
}

// ─── Playback ─────────────────────────────────────────────────────────────────
function playTrack(index) {
  if (!lastTracks.length) return;
  if (index < 0) index = lastTracks.length - 1;
  if (index >= lastTracks.length) index = 0;

  currentTrackIndex = index;
  const track = lastTracks[index];

  // Highlight active row
  document.querySelectorAll(".song.row").forEach(r => r.classList.remove("active"));
  const activeRow = document.getElementById(`track-row-${index}`);
  if (activeRow) {
    activeRow.classList.add("active");
    activeRow.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  setNowPlaying(track);
  addToRecent(track);

  // Load + play in YouTube player
  if (ytReady && ytPlayer) {
    ytPlayerWrapper.classList.add("visible");
    ytPlayer.loadVideoById(track.id);
    // Directly play without setTimeout to maintain user-interaction context
    try { ytPlayer.playVideo(); } catch (e) { }
  }
}

function pauseTrack() {
  if (ytReady && ytPlayer) {
    try { ytPlayer.pauseVideo(); } catch (e) { }
  }
}

function resumeTrack() {
  if (ytReady && ytPlayer) {
    try { ytPlayer.playVideo(); } catch (e) { }
  }
}

function playNext() {
  playTrack(currentTrackIndex + 1);
}

function playPrevFn() {
  playTrack(currentTrackIndex - 1);
}

// ─── Now Playing bar ─────────────────────────────────────────────────────────
function setNowPlaying(track) {
  if (!track) return;
  if (npTitle) npTitle.textContent = track.name || "Now Playing";
  if (npSub) npSub.textContent = track.artists || "";
  if (npCover) {
    npCover.innerHTML = track.image
      ? `<img src="${track.image}" alt="cover" />`
      : `<div class="np-cover-placeholder">🎵</div>`;
  }
  // reset progress bar
  if (npProgress) npProgress.style.width = "0%";
  stopProgressTimer();
}

// ─── Play/Pause UI sync ──────────────────────────────────────────────────────
function setPlayingUI(playing) {
  isPlaying = playing;

  // Main player bar button (icon only, removed text label for space)
  if (playPauseBtn) {
    playPauseBtn.innerHTML = playing
      ? `<span class="pp-icon" style="font-size:18px;">⏸</span>`
      : `<span class="pp-icon" style="font-size:18px;">▶</span>`;
    playPauseBtn.classList.toggle("is-playing", playing);
  }

  // Animated music bars in player bar (show when playing)
  const bars = document.getElementById("npBars");
  if (bars) bars.style.display = playing ? "flex" : "none";

  // Row-level play/pause icons
  updateRowButtons();
}

// ─── Main play/pause button handler ─────────────────────────────────────────
function handlePlayPause() {
  if (!ytReady || !ytPlayer) return;

  if (currentTrackIndex === -1) {
    if (lastTracks && lastTracks.length > 0) playTrack(0);
    return;
  }

  const state = typeof ytPlayer.getPlayerState === 'function' ? ytPlayer.getPlayerState() : -1;
  if (state === YT.PlayerState.PLAYING) {
    pauseTrack();
  } else {
    resumeTrack();
  }
}

// ─── Progress Timer ──────────────────────────────────────────────────────────
function startProgressTimer() {
  stopProgressTimer();
  if (!npProgress || !ytReady || !ytPlayer) return;
  progressTimer = setInterval(() => {
    try {
      const dur = ytPlayer.getDuration();
      const cur = ytPlayer.getCurrentTime();
      if (dur > 0) npProgress.style.width = `${(cur / dur) * 100}%`;
    } catch (e) { }
  }, 500);
}

function stopProgressTimer() {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = null;
}

// ─── Library ─────────────────────────────────────────────────────────────────
function addToRecent(track) {
  recentlyPlayed = [track, ...recentlyPlayed.filter(t => t.id !== track.id)].slice(0, 30);
}

function renderLibrary() {
  if (!libraryList) return;
  libraryList.innerHTML = "";
  if (!recentlyPlayed.length) {
    if (libraryEmpty) libraryEmpty.style.display = "block";
    return;
  }
  if (libraryEmpty) libraryEmpty.style.display = "none";
  recentlyPlayed.forEach(t => {
    const row = document.createElement("div");
    row.className = "song row";
    row.innerHTML = `
      <div class="song-cover">
        ${t.image ? `<img src="${t.image}" alt="${t.name}" loading="lazy" />` : "<div class='placeholder'></div>"}
      </div>
      <div class="song-info">
        <div class="title">${t.name}</div>
        <div class="artist">${t.artists}</div>
      </div>
      <div class="song-actions">
        <!-- Made row clickable instead of needing button -->
        <span class="row-play-icon" style="color:var(--accent-2);font-size:18px;">▶</span>
      </div>`;
    row.addEventListener("click", () => {
      const idx = lastTracks.findIndex(lt => lt.id === t.id);
      if (idx >= 0) playTrack(idx);
      else { lastTracks.unshift(t); playTrack(0); }
    });
    libraryList.appendChild(row);
  });
}

// ─── YouTube player collapse toggle ──────────────────────────────────────────
let ytCollapsed = false;
ytToggle.addEventListener("click", () => {
  ytCollapsed = !ytCollapsed;
  ytPlayerWrapper.classList.toggle("collapsed", ytCollapsed);
  ytToggle.textContent = ytCollapsed ? "+" : "−";
});

// ─── Run Flow (Scan + Play) ───────────────────────────────────────────────────
async function runFlow() {
  autoPlayNext = true;
  await scanMood();
}

// ─── Refresh Playlist ────────────────────────────────────────────────────────
async function refreshPlaylist() {
  autoPlayNext = true;
  await getSongs();
}

// ─── Browse tiles ─────────────────────────────────────────────────────────────
document.querySelectorAll(".browse-tile").forEach(tile => {
  tile.addEventListener("click", () => {
    currentMood = tile.dataset.mood || "neutral";
    moodLabel.textContent = currentMood;
    setActiveView("home");
    autoPlayNext = true;
    getSongs();
  });
});

// ─── Mood chips (sidebar) ─────────────────────────────────────────────────────
document.querySelectorAll(".mood-chip-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".mood-chip-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    currentMood = btn.dataset.mood;
    moodLabel.textContent = currentMood;
    getSongs();
  });
});

// ─── Bind events ─────────────────────────────────────────────────────────────
function bindClick(id, handler) {
  const el = document.getElementById(id);
  if (el) el.addEventListener("click", handler);
}

bindClick("startCam", startCamera);
bindClick("scanMood", scanMood);
bindClick("getSongs", getSongs);
bindClick("refreshSongs", refreshPlaylist);
bindClick("runFlow", runFlow);
bindClick("playPause", handlePlayPause);
bindClick("prevBtn", playPrevFn);
bindClick("nextBtn", playNext);


if (sortBy) sortBy.addEventListener("change", renderTracks);

document.querySelectorAll(".nav-item").forEach(item =>
  item.addEventListener("click", () => setActiveView(item.dataset.view)));
