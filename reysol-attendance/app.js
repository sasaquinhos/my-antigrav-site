// App State
const state = {
    members: [],
    matches: [],
    attendance: {}, // { "matchId_memberName": { status, guestsMain, guestsBack } }
    expandedMatches: new Set(), // Set of match IDs that are expanded
    loading: false,
    matchLimit: 10,
    leagues: []
};

const API_URL = 'https://script.google.com/macros/s/AKfycbyYBnoIPxRRkmt-3LCfZ7lNcgSVPRcN8uR3YMSbYG0O28XmkMytExEgrJx4OuTlyi_spg/exec';

// DOM Elements
const matchesContainer = document.getElementById('matches-container');
const newMemberNameInput = document.getElementById('new-member-name');
const addMemberBtn = document.getElementById('add-member-btn');
const newMatchDateInput = document.getElementById('new-match-date');
const newMatchOpponentInput = document.getElementById('new-match-opponent');
const newMatchKickoffInput = document.getElementById('new-match-kickoff');
const newMatchVenueInput = document.getElementById('new-match-venue');
const newMatchOpeningInput = document.getElementById('new-match-opening');
const newMatchOpeningContainer = document.getElementById('new-match-opening-container');

const editMatchKickoffInput = document.getElementById('edit-match-kickoff');
const editMatchVenueInput = document.getElementById('edit-match-venue');
const editMatchOpeningInput = document.getElementById('edit-match-opening');
const editMatchOpeningContainer = document.getElementById('edit-match-opening-container');

const addMatchBtn = document.getElementById('add-match-btn');
const currentUserSelect = document.getElementById('current-user-select');

// Constants
const STATUS_OPTIONS = [
    { id: 1, label: '開場30分前まで' },
    { id: 2, label: '開場後' },
    { id: 3, label: 'キックオフ後' },
    { id: 4, label: '柏熱以外' },
    { id: 5, label: '欠席' },
    { id: 6, label: '並び開始' },
    { id: 7, label: '列整理' }
];

const SECTION_LABELS = {
    1: 'TOP',
    2: 'FRONT'
};

// Caching Constants
const STORAGE_KEY = 'reysol_attendance_data';

// Helper: Robust Date Parser (Safe handling for Mobile/Safari)
function parseDate(input) {
    if (!input) return new Date();
    if (input instanceof Date) {
        return isNaN(input.getTime()) ? new Date() : new Date(input.getTime());
    }
    if (typeof input === 'number') return new Date(input);
    const str = String(input).trim();

    // 1. If it's a full ISO string (contains T or Z), let native parser handle it.
    // Modern browsers handle ISO strings correctly as UTC.
    if (str.includes('T') || str.includes('Z')) {
        const d = new Date(str);
        if (!isNaN(d.getTime())) return d;
    }

    let d;
    // 2. Try YYYY-MM-DD (Exact match)
    // We use anchor $ to ensure we don't partially match ISO strings.
    const matchFull = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (matchFull) {
        // Constructing with year, monthIndex, day treats it as LOCAL time.
        d = new Date(parseInt(matchFull[1], 10), parseInt(matchFull[2], 10) - 1, parseInt(matchFull[3], 10));
    } else {
        // 3. Try YYYY-MM (for League Start/End)
        const matchMonth = str.match(/^(\d{4})[-/](\d{1,2})$/);
        if (matchMonth) {
            d = new Date(parseInt(matchMonth[1], 10), parseInt(matchMonth[2], 10) - 1, 1);
        } else {
            // 4. Fallback to standard parser (with slash replacement for Safari compatibility)
            // Replacing - with / makes "YYYY-MM-DD" be parsed as Local in most browsers.
            d = new Date(str.replace(/-/g, '/'));
        }
    }

    // Final Safety Check
    if (isNaN(d.getTime())) {
        console.warn('parseDate failed for:', input);
        return new Date();
    }
    return d;
}

// Helper: Format Time safely for GAS UTC Time
function formatTime(timeStr) {
    if (!timeStr) return '';
    if (timeStr.includes('T')) {
        const d = new Date(timeStr);
        if (isNaN(d.getTime())) return timeStr;
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }
    return timeStr;
}

// Helper: Calculate Home Opening Time
function calculateHomeOpeningTime(kickoffTime) {
    if (!kickoffTime) return '';
    const parts = kickoffTime.split(':');
    if (parts.length !== 2) return '';
    const h = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10);
    const koMin = h * 60 + m;
    let opMin = koMin <= 14 * 60 ? koMin - 210 : koMin - 240;
    if (opMin < 0) opMin += 1440;
    return String(Math.floor(opMin / 60)).padStart(2, '0') + ':' + String(opMin % 60).padStart(2, '0');
}

// Helper: Update Flag Notice preserving extra custom text
function updateFlagNoticeText(currentNotice, formattedTime) {
    const flagPattern = /\d{1,2}:\d{2}～\s*ビッグフラッグ設置実施/;
    const newFlagText = `${formattedTime}～ ビッグフラッグ設置実施`;
    
    if (!currentNotice || !currentNotice.trim()) {
        return newFlagText;
    }
    
    if (flagPattern.test(currentNotice)) {
        return currentNotice.replace(flagPattern, newFlagText);
    } else {
        return `${newFlagText}\n${currentNotice}`;
    }
}

// Initialization
async function init() {
    console.log('Current API URL:', API_URL);

    // Initial Authentication for Admin
    const isAdminPage = !!document.getElementById('matches-select-admin');
    if (isAdminPage) {
        await authenticate();
    }

    // 1. Try to load from local storage (Stale)
    const hasLocalData = loadFromLocal();

    if (hasLocalData) {
        // If we have local data, render immediately and setup listeners
        setupUserSelect();
        renderMatches();
        setupEventListeners();

        // Background loading indicator removed per user request
        // setLoading(true, 'background');
    } else {
        // First time load: show full blocker
        setLoading(true, 'full');
    }

    try {
        // 2. Fetch fresh data (Revalidate)
        await loadData();

        // Update UI with fresh data
        setupUserSelect();
        renderMatches();

        // If listeners weren't set up yet (no local data), do it now
        if (!hasLocalData) {
            setupEventListeners();
        }

    } catch (e) {
        console.error('Data sync failed:', e);
        if (!hasLocalData) {
            alert('データの読み込みに失敗しました: ' + e.message);
        }
    } finally {
        setLoading(false);
    }

}



async function loadData() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout for GAS cold starts

    try {
        const res = await fetch(`${API_URL}?t=${new Date().getTime()}`, {
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);

        const data = await res.json();

        if (data.members) state.members = data.members;
        else state.members = [];

        if (data.matches) state.matches = data.matches;
        else state.matches = [];

        if (data.settings && data.settings.matchLimit) {
            state.matchLimit = data.settings.matchLimit;
        }

        if (data.settings && data.settings.leagues) {
            try {
                state.leagues = JSON.parse(data.settings.leagues);
            } catch (e) {
                console.error('Failed to parse leagues settings:', e);
                state.leagues = [];
            }
        }

        if (data.attendance) {
            state.attendance = data.attendance;
            sanitizeAttendanceData();
        } else {
            state.attendance = {};
        }

        // Save to local storage
        saveToLocal();
    } catch (e) {
        clearTimeout(timeoutId);
        throw e;
    }
}

function loadFromLocal() {
    try {
        const json = localStorage.getItem(STORAGE_KEY);
        if (!json) return false;

        const data = JSON.parse(json);
        if (!data) return false;

        if (data.members) state.members = data.members;
        if (data.matches) state.matches = data.matches;
        if (data.attendance) {
            state.attendance = data.attendance;
            sanitizeAttendanceData();
        }

        if (data.matchLimit) state.matchLimit = data.matchLimit;
        if (data.leagues) state.leagues = data.leagues;

        return true;
    } catch (e) {
        console.error('Error loading from local storage:', e);
        return false;
    }
}

function saveToLocal() {
    try {
        const data = {
            members: state.members,
            matches: state.matches,
            attendance: state.attendance,
            matchLimit: state.matchLimit,
            leagues: state.leagues,
            timestamp: new Date().getTime()
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
        console.error('Error saving to local storage:', e);
    }
}

function sanitizeAttendanceData() {
    Object.keys(state.attendance).forEach(key => {
        const att = state.attendance[key];
        if (att.status === undefined) att.status = null;
        if (att.guestsMain === undefined) att.guestsMain = '';
        if (att.guestsBack === undefined) att.guestsBack = '';
        if (att.bigFlag === undefined) att.bigFlag = false;
        if (att.jankenParticipate === undefined) att.jankenParticipate = false;
        if (att.morningWithdraw === undefined) att.morningWithdraw = false;
    });
}

function setLoading(isLoading, mode = 'full') {
    state.loading = isLoading;
    const overlayId = 'loading-overlay';
    // Removed indicatorId as we no longer show subtle updates

    // Cleanup existing
    const existingOverlay = document.getElementById(overlayId);
    if (existingOverlay) existingOverlay.remove();

    const existingIndicator = document.getElementById('loading-indicator-subtle');
    if (existingIndicator) existingIndicator.remove();

    if (isLoading && mode === 'full') {
        const overlay = document.createElement('div');
        overlay.id = overlayId;
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(255,255,255,0.7);display:flex;justify-content:center;align-items:center;z-index:9999;font-size:1.5rem;';
        overlay.innerText = '読み込み中...';
        document.body.appendChild(overlay);
    }
}

/**
 * Handles admin authentication via server-side verification.
 */
async function authenticate() {
    if (sessionStorage.getItem('isAdmin') === 'true') {
        document.body.classList.add('authenticated');
        return;
    }

    const password = prompt('管理者パスワードを入力してください:');
    if (!password) {
        window.location.href = '../index.html';
        return;
    }

    setLoading(true, 'full');
    try {
        const res = await fetch(API_URL, {
            method: 'POST',
            body: JSON.stringify({ action: 'verify_admin', password: password })
        });
        const json = await res.json();

        if (json.result === 'success' && json.data.success) {
            sessionStorage.setItem('isAdmin', 'true');
            document.body.classList.add('authenticated');
        } else {
            alert('パスワードが違います。トップページに戻ります。');
            window.location.href = '../index.html';
        }
    } catch (e) {
        console.error('Authentication error:', e);
        alert('通信エラーが発生しました。トップページに戻ります。');
        window.location.href = '../index.html';
    } finally {
        setLoading(false);
    }
}

function setupUserSelect() {
    if (!currentUserSelect) return;

    // Save current selection if re-rendering
    const currentVal = currentUserSelect.value || localStorage.getItem('reysol_currentUser') || '';

    currentUserSelect.innerHTML = '<option value="">-- 選択してください --</option>' +
        state.members.map(m => `<option value="${m.name}">${m.name}</option>`).join('');

    currentUserSelect.value = currentVal;

    currentUserSelect.addEventListener('change', (e) => {
        localStorage.setItem('reysol_currentUser', e.target.value);
        renderMatches();
    });
}

// API Interaction
async function apiCall(action, payload = {}) {
    console.log('API Call:', action, payload);
    const body = { action, ...payload };

    try {
        const res = await fetch(API_URL, {
            method: 'POST',
            mode: 'cors',
            cache: 'no-cache',
            headers: {
                'Content-Type': 'text/plain;charset=utf-8', // GAS handles text/plain best for POST bodies
            },
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            throw new Error(`Server returned ${res.status} ${res.statusText}`);
        }

        const json = await res.json();
        if (json.result !== 'success') {
            throw new Error(json.error || 'Unknown server error');
        }

    } catch (e) {
        console.error('API Error:', e);
        // Only alert if it's not a generic "Failed to fetch" on unload (optional, but good for UX)
        alert('保存に失敗しました: ' + (e.message || e.toString()));
    }
}

// Render Functions
// Render Functions
function renderMatches() {
    // Admin Mode: Render selections only
    const isAdmin = !!document.getElementById('matches-select-admin');

    // Sort matches by date (descending)
    const sortedMatches = [...state.matches].sort((a, b) => parseDate(b.date) - parseDate(a.date));

    // Initialize expandedMatches if empty and we have matches (Might not be needed for admin anymore, but good for user side)
    if (state.expandedMatches.size === 0 && sortedMatches.length > 0) {
        state.expandedMatches.add(sortedMatches[0].id);
    }

    if (isAdmin) {
        // ADMIN MODE: Populate Select Boxes
        const matchesSelect = document.getElementById('matches-select-admin');
        const jankenConfig = document.getElementById('janken-admin-config');

        if (matchesSelect) {
            const currentVal = matchesSelect.value;
            matchesSelect.innerHTML = '<option value="">-- 試合を選択 --</option>' +
                sortedMatches.map(m => {
                    const d = parseDate(m.date);
                    const dateStr = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
                    return `<option value="${m.id}">${dateStr} ${m.opponent}</option>`;
                }).join('');
            matchesSelect.value = currentVal;

            matchesSelect.onchange = () => renderMatches();

            // Handle Janken Config for selected match
            if (currentVal && jankenConfig) {
                const selectedMatch = sortedMatches.find(m => m.id == currentVal);
                if (selectedMatch && selectedMatch.location !== 'away') {
                    renderJankenAdminConfig(selectedMatch, jankenConfig);
                    jankenConfig.style.display = 'block';
                } else {
                    jankenConfig.innerHTML = '';
                    jankenConfig.style.display = 'none';
                }
            } else if (jankenConfig) {
                jankenConfig.innerHTML = '';
                jankenConfig.style.display = 'none';
            }
        }

        renderMembersAdmin();
        renderLeaguesAdmin();
    } else {
        // USER MODE: Render Match Cards
        matchesContainer.innerHTML = '';

        const currentUser = currentUserSelect ? currentUserSelect.value : null;

        // User View Logic (League & Match Selection)
        let matchesToRender = sortedMatches;

        const userLeagueSelect = document.getElementById('current-league-select');
        const userMatchSelect = document.getElementById('current-match-select');

        // 1. League Selection & Filtering
        let leagueFilteredMatches = sortedMatches;

        if (userLeagueSelect) {
            // --- 1. Populate Options (Idempotent) ---
            if (userLeagueSelect.options.length <= 1 && state.leagues && state.leagues.length > 0) {
                // Sort leagues by start date descending
                const sortedLeagues = [...state.leagues].sort((a, b) => {
                    const da = parseDate(a.start);
                    const db = parseDate(b.start);
                    return db - da; // Descending
                });

                // REMOVED: '-- All Periods --' option as requested by user.
                userLeagueSelect.innerHTML = sortedLeagues.map(l => `<option value="${l.id}">${l.name}</option>`).join('');

                // Force empty value initially so we can trigger default selection below logic if needed,
                // although browser might select first option automatically.
                userLeagueSelect.value = "";
            }

            // --- 2. Determine Default Selection (If empty) ---
            // Run this if value is empty, OR if we think the UI might have reset (mobile issue)
            if (!userLeagueSelect.value && state.leagues && state.leagues.length > 0) {
                const sortedLeagues = [...state.leagues].sort((a, b) => parseDate(b.start) - parseDate(a.start));

                const today = new Date();

                let defaultLeagueId = null;

                // Logic A: Active League (Today inside Start ~ End)
                const activeLeague = sortedLeagues.find(l => {
                    const s = parseDate(l.start);
                    s.setHours(0, 0, 0, 0);

                    // End Date Logic: If YYYY-MM, assume End of Month
                    let e = parseDate(l.end);
                    if (l.end && String(l.end).match(/^\d{4}[-/]\d{1,2}$/)) {
                        const d = parseDate(l.end);
                        e = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
                    } else {
                        e.setHours(23, 59, 59, 999);
                    }

                    const isWithin = today >= s && today <= e;

                    // Check if matches exist for this league (ID check OR Date check)
                    const hasMatches = state.matches.some(m => {
                        if (m.leagueId && String(m.leagueId) === String(l.id)) return true;
                        // Date Fallback
                        const d = parseDate(m.date);
                        return d >= s && d <= e;
                    });

                    return isWithin && hasMatches;
                });

                if (activeLeague) {
                    defaultLeagueId = activeLeague.id;
                } else {
                    // Logic B: Fallback to Latest Match's League
                    const latestMatch = [...state.matches].sort((a, b) => parseDate(b.date) - parseDate(a.date))[0];
                    if (latestMatch) {
                        if (latestMatch.leagueId) {
                            defaultLeagueId = latestMatch.leagueId;
                        } else {
                            const matchDate = parseDate(latestMatch.date);
                            const matchedLeague = sortedLeagues.find(l => {
                                const s = parseDate(l.start);
                                s.setHours(0, 0, 0, 0);
                                let e = parseDate(l.end);
                                if (l.end && String(l.end).match(/^\d{4}[-/]\d{1,2}$/)) {
                                    const d = parseDate(l.end);
                                    e = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
                                } else {
                                    e.setHours(23, 59, 59, 999);
                                }
                                return matchDate >= s && matchDate <= e;
                            });
                            if (matchedLeague) {
                                defaultLeagueId = matchedLeague.id;
                            }
                        }
                    }
                }

                if (defaultLeagueId) {
                    userLeagueSelect.value = String(defaultLeagueId);

                    // Forced UI Update
                    requestAnimationFrame(() => {
                        const el = document.getElementById('current-league-select');
                        if (el) {
                            el.value = String(defaultLeagueId);
                        }
                    });
                }
            }

            // --- 3. Apply Filtering ---
            const selectedLeagueId = userLeagueSelect.value;
            if (selectedLeagueId) {
                const league = state.leagues.find(l => l.id == selectedLeagueId);
                if (league) {
                    const s = parseDate(league.start);
                    s.setHours(0, 0, 0, 0);

                    let e = parseDate(league.end);
                    if (league.end && String(league.end).match(/^\d{4}[-/]\d{1,2}$/)) {
                        const d = parseDate(league.end);
                        e = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
                    } else {
                        e.setHours(23, 59, 59, 999);
                    }

                    leagueFilteredMatches = sortedMatches.filter((m, index) => {
                        const d = parseDate(m.date);
                        const isDateMatch = d >= s && d <= e;

                        // Check explicit league ID if available
                        let isIdMatch = false;
                        if (m.leagueId) {
                            isIdMatch = String(m.leagueId) === String(league.id);
                        }

                        // RELAXED FILTERING: Match by Date OR ID
                        const isMatch = isDateMatch || isIdMatch;
                        return isMatch;
                    });
                }
            }

            userLeagueSelect.onchange = () => renderMatches();
        }

        // 2. Match Selection
        if (userMatchSelect) {
            const currentSelection = userMatchSelect.value;

            // Generate Options from Filtered List
            userMatchSelect.innerHTML = leagueFilteredMatches.map(m => {
                const d = parseDate(m.date);
                const dateStr = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
                return `<option value="${m.id}">${dateStr} ${m.opponent}</option>`;
            }).join('');

            // Restore Selection or Set Default
            if (currentSelection && leagueFilteredMatches.some(m => m.id == currentSelection)) {
                userMatchSelect.value = currentSelection;
            } else {
                // Default: Closest Future Match in LIST
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                const futureMatches = leagueFilteredMatches.filter(m => parseDate(m.date) >= today);

                if (futureMatches.length > 0) {
                    userMatchSelect.value = futureMatches[futureMatches.length - 1].id;
                } else if (leagueFilteredMatches.length > 0) {
                    userMatchSelect.value = leagueFilteredMatches[0].id;
                }
            }

            // Final Render Selection
            const selectedId = userMatchSelect.value;
            if (selectedId) {
                matchesToRender = sortedMatches.filter(m => m.id == selectedId);
                if (matchesToRender.length > 0) {
                    state.expandedMatches.add(matchesToRender[0].id);
                }
            } else {
                // If filtering resulted in NO matches (e.g. empty league), render nothing
                matchesToRender = [];
            }

            // Bind change event
            userMatchSelect.onchange = () => renderMatches();
        } else {
            // Fallback to old Limit logic
            const limitInput = document.getElementById('match-limit-input');
            if (limitInput && document.activeElement !== limitInput) {
                limitInput.value = state.matchLimit;
            }
            const limitCount = parseInt(state.matchLimit);
            if (!isNaN(limitCount)) {
                matchesToRender = sortedMatches.slice(0, limitCount);
            }
        }


        const today = new Date();
        today.setHours(0, 0, 0, 0);

        if (currentUserSelect && !currentUser) {
            // Filter out past matches. They can be rendered even without a user.
            const futureMatchesToRender = matchesToRender.filter(m => {
                const md = parseDate(m.date);
                md.setHours(0, 0, 0, 0);
                return md >= today;
            });

            if (futureMatchesToRender.length > 0) {
                matchesContainer.innerHTML = '<p style="text-align:center; padding:2rem; color:#666;">ユーザーを選択してください。</p>';
                return;
            }
        }

        matchesToRender.forEach(match => {
            const matchDate = parseDate(match.date);
            matchDate.setHours(0, 0, 0, 0);
            const isPastMatch = matchDate < today;

            const matchEl = document.createElement('div');
            const isExpanded = state.expandedMatches.has(match.id);
            matchEl.className = `match-card ${isExpanded ? '' : 'collapsed'}`;
            matchEl.dataset.matchId = match.id;

            // User: No admin controls
            const adminControlsHtml = '';
            const jankenAdminHtml = '';

            // Filter members: 
            // User: Show only SELECTED user
            let membersToRender = [];
            let hideName = false;

            if (currentUser) {
                // Find the member object
                const memberObj = state.members.find(m => m.name === currentUser);
                if (memberObj) {
                    membersToRender = [memberObj];
                    hideName = true;
                }
            }

            // Hide members-list (input area) for past matches
            const membersListHtml = isPastMatch ? '' : `
                <div class="members-list">
                    ${membersToRender.map(member => createMemberRow(match.id, member, hideName)).join('')}
                </div>
            `;

            matchEl.innerHTML = `
                <div class="match-header ${match.location === 'away' ? 'location-away' : 'location-home'}">
                    <div class="match-info">
                        <h2>${match.opponent}</h2>
                        <span class="match-date">${formatDate(match.date)}${match.kickoff ? ' ' + formatTime(match.kickoff) + ' K.O.' : ''}${match.location === 'home' && match.opening ? ' (開場 ' + formatTime(match.opening) + ')' : ''}${match.venue ? ' @ ' + match.venue : ''}</span>
                        <span class="match-location-badge ${match.location === 'away' ? 'location-away' : 'location-home'}">
                            ${match.location === 'away' ? 'アウェイ' : 'ホーム'}
                            ${match.location === 'away' ? (match.seatType === 'reserved' ? ' (指定席)' : ' (自由席)') : ''}
                        </span>
                    </div>
                    ${adminControlsHtml}
                </div>
                ${jankenAdminHtml}
                ${membersListHtml}
                <div id="summary-${match.id}" class="match-summary-container">
                    ${generateMatchSummaryContent(match.id)}
                </div>
            `;
            matchesContainer.appendChild(matchEl);
        });

        attachMatchListeners();
    }
}

function autoSelectJankenCandidate(matchId, silent = false) {
    const currentMatch = state.matches.find(m => m.id == matchId);
    if (!currentMatch) return;

    // 0. Check if already confirmed
    if (currentMatch.jankenConfirmed && currentMatch.jankenConfirmed.trim() !== '') {
        if (!silent) alert('既に確定者がいるため、自動選出をスキップしました。');
        return;
    }

    // 1. Identify the league for this match
    let league = state.leagues.find(l => String(l.id) === String(currentMatch.leagueId));
    if (!league) {
        // Fallback: match by date
        const mDate = parseDate(currentMatch.date);
        league = state.leagues.find(l => {
            const s = parseDate(l.start);
            s.setHours(0, 0, 0, 0);
            let eDate = parseDate(l.end);
            if (l.end && String(l.end).match(/^\d{4}[-/]\d{1,2}$/)) {
                const d = parseDate(l.end);
                eDate = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
            } else {
                eDate.setHours(23, 59, 59, 999);
            }
            return mDate >= s && mDate <= eDate;
        });
    }

    if (!league) {
        if (!silent) alert('この試合が属するリーグが特定できないため、自動選出ができません。');
        return;
    }

    // 2. Filter matches within this league
    const s = parseDate(league.start);
    s.setHours(0, 0, 0, 0);
    let eDate = parseDate(league.end);
    if (league.end && String(league.end).match(/^\d{4}[-/]\d{1,2}$/)) {
        const d = parseDate(league.end);
        eDate = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
    } else {
        eDate.setHours(23, 59, 59, 999);
    }

    const leagueMatches = state.matches.filter(m => {
        if (m.leagueId && String(m.leagueId) === String(league.id)) return true;
        const d = parseDate(m.date);
        return d >= s && d <= eDate;
    });

    // 3. Count wins for each candidate in this league
    const winCounts = {};
    leagueMatches.forEach(m => {
        if (m.jankenConfirmed) {
            const winners = m.jankenConfirmed.split(',').map(s => s.trim()).filter(s => s);
            winners.forEach(w => {
                winCounts[w] = (winCounts[w] || 0) + 1;
            });
        }
    });

    // 4. Get current candidates
    const currentCandidates = state.members.filter(member => {
        const key = `${currentMatch.id}_${member.name}`;
        const data = state.attendance[key];
        return data && data.jankenParticipate;
    });

    if (currentCandidates.length === 0) {
        if (!silent) alert('立候補者がいません。');
        return;
    }

    // 5. Pick the one with the minimum wins
    let minWins = Infinity;
    let selectedCandidates = [];

    currentCandidates.forEach(c => {
        const count = winCounts[c.name] || 0;
        if (count < minWins) {
            minWins = count;
            selectedCandidates = [c.name];
        } else if (count === minWins) {
            selectedCandidates.push(c.name);
        }
    });

    // If multiple candidates have the same min wins, pick one randomly
    const winner = selectedCandidates[Math.floor(Math.random() * selectedCandidates.length)];

    // 6. Update match.jankenConfirmed (Strictly one person)
    currentMatch.jankenConfirmed = winner;
    saveToLocal();
    renderMatches();
    apiCall('update_match', { id: matchId, jankenConfirmed: winner });
}

function renderJankenAdminConfig(match, container) {
    const confirmedList = (match.jankenConfirmed || '').split(',').map(s => s.trim()).filter(s => s);

    // Filter candidates: members who have jankenParticipate = true for THIS match
    const candidates = state.members.filter(member => {
        const key = `${match.id}_${member.name}`;
        const data = state.attendance[key];
        return data && data.jankenParticipate;
    });

    const jankenOptions = candidates.map(c => `<option value="${c.name}">${c.name}</option>`).join('');
    const tagsHtml = confirmedList.map(name => `
        <span class="janken-tag" style="display:inline-flex; align-items:center; background:#f3e5f5; border:1px solid #ce93d8; color:#7b1fa2; padding:2px 8px; border-radius:12px; font-size:0.85rem; margin-right:4px; margin-bottom:4px;">
            ${name}
            <span class="remove-janken-tag" data-match-id="${match.id}" data-name="${name}" style="margin-left:5px; cursor:pointer; font-weight:bold;">×</span>
        </span>
    `).join('');

    container.innerHTML = `
        <div style="font-weight:bold; font-size:0.9rem; color:#7b1fa2; margin-bottom:0.5rem; display:flex; align-items:center; justify-content:space-between;">
            じゃんけん大会参加確定者の設定
            <button class="btn janken-auto-select-btn" data-match-id="${match.id}" style="padding: 2px 10px; font-size: 0.8rem; background: #7b1fa2; color: white; border-radius: 4px;">参加確定</button>
        </div>
        <div style="display:flex; flex-wrap:wrap; align-items:center; gap:0.5rem;">
            <select class="janken-add-select" data-match-id="${match.id}" style="padding:0.3rem; border-radius:4px; border:1px solid #ddd; font-size:0.9rem;">
                <option value="">-- 確定者を追加 (立候補者のみ) --</option>
                ${jankenOptions}
            </select>
            <div class="janken-tags-container" style="display:flex; flex-wrap:wrap; align-items:center;">
                ${tagsHtml}
            </div>
        </div>
    `;

    // Attach listeners for newly added elements
    container.querySelector('.janken-auto-select-btn')?.addEventListener('click', (e) => {
        autoSelectJankenCandidate(e.target.dataset.matchId);
    });

    container.querySelectorAll('.janken-add-select').forEach(select => {
        select.addEventListener('change', (e) => {
            const mId = e.target.dataset.matchId;
            const name = e.target.value;
            if (!name) return;

            const m = state.matches.find(matchObj => matchObj.id == mId);
            if (m) {
                // Strictly one person - overwrite existing
                m.jankenConfirmed = name;
                saveToLocal();
                renderMatches();
                apiCall('update_match', { id: mId, jankenConfirmed: name });
            }
        });
    });

    container.querySelectorAll('.remove-janken-tag').forEach(span => {
        span.addEventListener('click', (e) => {
            const mId = e.target.dataset.matchId;
            const name = e.target.dataset.name;

            const m = state.matches.find(matchObj => matchObj.id == mId);
            if (m) {
                const current = (m.jankenConfirmed || '').split(',').map(s => s.trim()).filter(s => s);
                const newVal = current.filter(n => n !== name).join(', ');
                m.jankenConfirmed = newVal;
                saveToLocal();
                renderMatches();
                apiCall('update_match', { id: mId, jankenConfirmed: newVal });
            }
        });
    });
}

function createMemberRow(matchId, member, hideName = false) {
    const memberName = member.name;
    const key = `${matchId}_${memberName}`;
    const data = state.attendance[key] || { status: null, guestsMain: '', guestsBack: '', bigFlag: false, jankenParticipate: false, morningWithdraw: false };

    // Ensure default values
    if (data.bigFlag === undefined) data.bigFlag = false;
    if (data.jankenParticipate === undefined) data.jankenParticipate = false;
    if (data.morningWithdraw === undefined) data.morningWithdraw = false;

    const match = state.matches.find(m => m.id == matchId);
    const jankenConfirmedText = match ? (match.jankenConfirmed || '') : '';
    let effectiveStatus = data.status;
    if (effectiveStatus == 6 && !match.queueFlag) effectiveStatus = null;
    if (effectiveStatus == 7 && !match.lineOrgFlag) effectiveStatus = null;

    const isAbsent = effectiveStatus == 5;
    const isAttending = effectiveStatus !== null && effectiveStatus !== "" && effectiveStatus != 5;

    const isAway = match && match.location === 'away';
    const isAwayFree = isAway && match.seatType === 'free';

    const formatDateWithDayAndTime = (dateStr) => {
        if (!dateStr) return '';
        const d = parseDate(dateStr);
        if (isNaN(d.getTime())) return dateStr;
        const days = ['日', '月', '火', '水', '木', '金', '土'];
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} (${days[d.getDay()]}) ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };

    const subStatuses = [...STATUS_OPTIONS.filter(opt => opt.id !== 5 && opt.id !== 6 && opt.id !== 7)];
    if (isAwayFree) {
        if (match.lineOrgFlag) subStatuses.unshift(STATUS_OPTIONS.find(o => o.id === 7));
        if (match.queueFlag) subStatuses.unshift(STATUS_OPTIONS.find(o => o.id === 6));
    }

    let radiosHtml = subStatuses.map(opt => {
        let label = opt.label;
        if (isAway && opt.id === 4) label = 'ゴール裏以外';
        return `
            <label class="radio-label">
                <input type="radio" name="status_${key}" value="${opt.id}" ${effectiveStatus == opt.id ? 'checked' : ''} ${!isAttending ? 'disabled' : ''}>
                ${label}
            </label>
        `;
    }).join('');

    const nameHtml = hideName ? '' : `<div class="member-name">${memberName}</div>`;

    const currentGuests = (parseInt(data.guestsMain) || 0) + (parseInt(data.guestsBack) || 0);
    const guestValue = currentGuests > 0 ? currentGuests : '';

    const matchDate = match ? parseDate(match.date) : null;

    if (isAway) {
        let noticeHtml = '';
        if (match.awayNotice) {
            noticeHtml = `<div class="away-notice-box"><div class="away-notice-title">連絡事項</div>${match.awayNotice}</div>`;
        }

        let awayHeaderInfo = '';
        if (match.deadline) {
            awayHeaderInfo += `<div style="font-size:0.9rem; color:#d32f2f; font-weight:bold; margin-top:0.3rem;">回答期限: ${formatDateWithDayAndTime(match.deadline)}</div>`;
        }

        let awayDetailsHtml = '';
        if (isAwayFree) {
            if (match.queueFlag && match.queueTime) {
                awayDetailsHtml += `<div style="font-size: 0.9rem; margin-bottom: 0.3rem;"><span style="font-weight:bold; color:#1976d2;">並び開始（シート貼り）：</span>${formatDateWithDayAndTime(match.queueTime)}</div>`;
            }
            if (match.lineOrgFlag && match.lineOrgTime) {
                awayDetailsHtml += `<div style="font-size: 0.9rem; margin-bottom: 0.5rem;"><span style="font-weight:bold; color:#388e3c;">列整理：</span>${formatDateWithDayAndTime(match.lineOrgTime)}</div>`;
            }
        }

        return `
            <div class="attendance-row" data-key="${key}">
                <div class="attendance-input-container">
                    ${noticeHtml}
                    <div class="input-box" style="width: 100%; border: 2px solid #e0e0e0;">
                        ${awayHeaderInfo}
                        ${nameHtml}

                        <!-- Attend or Absent -->
                        <div class="presence-selection" style="margin-top: 0.5rem; padding-bottom: 0.75rem; border-bottom: 2px solid #e0e0e0;">
                            <label class="radio-label">
                                <input type="radio" class="presence-radio" name="presence_${key}" value="attendance" ${isAttending ? 'checked' : ''}>
                                出席
                            </label>
                            <label class="radio-label">
                                <input type="radio" class="presence-radio" name="presence_${key}" value="absence" ${isAbsent ? 'checked' : ''}>
                                欠席
                            </label>
                        </div>

                        <!-- Details (Only enabled if Attendance is selected) -->
                        <div class="attendance-details ${!isAttending ? 'disabled-section' : ''}">
                            ${isAwayFree ? `
                                ${awayDetailsHtml}
                                <div class="status-options">
                                    ${radiosHtml}
                                </div>
                            ` : ''}
                            <div class="extra-guests">
                                <label>自分以外の人数:</label>
                                <div class="guest-inputs-container" style="margin-top:0;">
                                    <div class="guest-input-group">
                                        <input type="number" class="guest-input guest-input-unified" min="0" value="${guestValue}" placeholder="0" style="width: 60px;" ${!isAttending ? 'disabled' : ''}>
                                        <span style="font-size: 0.8rem; color: #666; margin-left: 0.5rem;">名</span>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div style="margin-top: 0.5rem; text-align: center;">
                        <button class="btn btn-primary submit-attendance-btn" style="width: 100%; padding: 0.75rem;" onclick="submitAttendance('${matchId}', '${memberName}')">この内容で登録する</button>
                    </div>
                </div>
            </div>
        `;
    }

    // Default Home View
    let jankenLabelSuffix = '';
    if (matchDate) {
        const prevDate = new Date(matchDate);
        prevDate.setDate(matchDate.getDate() - 1);
        const mmdd = `${prevDate.getMonth() + 1}/${prevDate.getDate()}`;
        const days = ['日', '月', '火', '水', '木', '金', '土'];
        const dayStr = days[prevDate.getDay()];
        jankenLabelSuffix = `<br>（日立台公園 ${mmdd}(${dayStr}) 15:00）`;
    }

    let jankenHeader = '';
    let jankenTitle = 'じゃんけん大会';
    if (matchDate) {
        const twoDaysBefore = new Date(matchDate);
        twoDaysBefore.setDate(matchDate.getDate() - 2);
        const mmdd = `${twoDaysBefore.getMonth() + 1}/${twoDaysBefore.getDate()}`;
        const days = ['日', '月', '火', '水', '木', '金', '土'];
        const dayStr = days[twoDaysBefore.getDay()];
        jankenHeader = '【前日】';
        jankenTitle = `回答期限：${mmdd}(${dayStr}) 20:00`;
    }

    let generalTitle = '出欠情報';
    if (matchDate) {
        const prevDate = new Date(matchDate);
        prevDate.setDate(matchDate.getDate() - 1);
        const mmdd = `${prevDate.getMonth() + 1}/${prevDate.getDate()}`;
        const days = ['日', '月', '火', '水', '木', '金', '土'];
        const dayStr = days[prevDate.getDay()];
        generalTitle = `回答期限：${mmdd}(${dayStr}) 20:00`;
    }

    let noticeHtml = '';
    if (match.awayNotice) {
        noticeHtml = `<div class="away-notice-box"><div class="away-notice-title">連絡事項</div>${match.awayNotice}</div>`;
    }

    return `
        <div class="attendance-row" data-key="${key}">
            <div class="attendance-input-container">
                ${noticeHtml}
                <!-- Janken Box -->
                <div class="janken-box-wrapper">
                    <div class="janken-outside-header">${jankenHeader}</div>
                    <div class="input-box janken-box" style="margin-top:0;">
                        <div class="input-box-title">${jankenTitle}</div>
                        <div class="janken-section">
                            <label class="checkbox-label" style="font-weight:bold; color:#d32f2f;">
                                <input type="checkbox" class="janken-participate-checkbox" ${data.jankenParticipate ? 'checked' : ''}>
                                じゃんけん大会参加${jankenLabelSuffix}
                            </label>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- General Box -->
                <div class="general-box-wrapper">
                    <div class="janken-outside-header">【当日】</div>
                    <div class="input-box general-box" style="margin-top:0;">
                        <div class="input-box-title">${generalTitle}</div>
                        ${nameHtml}
                        <div class="morning-withdraw-section" style="margin-bottom: 0.75rem; padding-bottom: 0.75rem; border-bottom: 2px solid #e3f2fd;">
                            <label class="checkbox-label">
                                <input type="checkbox" class="morning-withdraw-checkbox" ${data.morningWithdraw ? 'checked' : ''}>
                                朝の引き込み(9:00)
                            </label>
                        </div>

                        <!-- Attend or Absent -->
                        <div class="presence-selection">
                            <label class="radio-label">
                                <input type="radio" class="presence-radio" name="presence_${key}" value="attendance" ${isAttending ? 'checked' : ''}>
                                出席
                            </label>
                            <label class="radio-label">
                                <input type="radio" class="presence-radio" name="presence_${key}" value="absence" ${isAbsent ? 'checked' : ''}>
                                欠席
                            </label>
                        </div>

                        <!-- Details (Only enabled if Attendance is selected) -->
                        <div class="attendance-details ${!isAttending ? 'disabled-section' : ''}">
                            <div class="status-options">
                                ${radiosHtml}
                            </div>
                            <div class="extra-guests">
                                <label>自分以外の人数:</label>
                                <div class="guest-inputs-container" style="margin-top:0;">
                                    <div class="guest-input-group">
                                        <input type="number" class="guest-input guest-input-unified" min="0" value="${guestValue}" placeholder="0" style="width: 60px;" ${!isAttending ? 'disabled' : ''}>
                                        <span style="font-size: 0.8rem; color: #666; margin-left: 0.5rem;">名 (${SECTION_LABELS[member.section] || 'TOP'})</span>
                                    </div>
                                </div>
                            </div>
                            <div class="big-flag-section">
                                <label class="checkbox-label">
                                    <input type="checkbox" class="big-flag-checkbox" ${data.bigFlag ? 'checked' : ''} ${!isAttending ? 'disabled' : ''}>
                                    ビッグフラッグ搬入手伝い
                                </label>
                                <div class="big-flag-note" style="font-size: 0.8rem; color: #666; margin-left: 1.6rem;">
                                    （開場30分後にGATE9前集合）
                                </div>
                            </div>
                        </div>
                        </div>
                    </div>
                    <div style="margin-top: 0.5rem; text-align: center;">
                        <button class="btn btn-primary submit-attendance-btn" style="width: 100%; padding: 0.75rem;" onclick="submitAttendance('${matchId}', '${memberName}')">この内容で登録する</button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

// Submit Attendance manually
async function submitAttendance(matchId, memberName) {
    const key = `${matchId}_${memberName}`;
    const row = document.querySelector(`.attendance-row[data-key="${key}"]`);
    if (!row) return;

    if (!state.attendance[key]) {
        state.attendance[key] = { status: null, guestsMain: '', guestsBack: '', bigFlag: false, jankenParticipate: false, morningWithdraw: false };
    }

    // Read DOM values
    const presenceRadio = row.querySelector('.presence-radio:checked');
    const isAbsent = presenceRadio && presenceRadio.value === 'absence';
    const isAttending = presenceRadio && presenceRadio.value === 'attendance';
    
    if (!isAbsent && !isAttending) {
        alert('出席か欠席かを選択してください。');
        return;
    }

    if (isAbsent) {
        state.attendance[key].status = 5;
        state.attendance[key].guestsMain = '';
        state.attendance[key].guestsBack = '';
        state.attendance[key].bigFlag = false;
        state.attendance[key].morningWithdraw = false;
        state.attendance[key].jankenParticipate = false;
    } else {
        const statusRadio = row.querySelector('.status-options input[type="radio"]:checked');
        const match = state.matches.find(m => m.id == matchId);
        const isAwayReserved = match && match.location === 'away' && match.seatType === 'reserved';
        
        let statusVal = null;
        if (statusRadio) {
            statusVal = parseInt(statusRadio.value);
        } else if (isAwayReserved) {
            statusVal = 1;
        }

        if (statusVal === null) {
            alert('出席時の状態（開場30分前まで、開場後など）を選択してください。');
            return;
        }
        
        state.attendance[key].status = statusVal;

        const guestInput = row.querySelector('.guest-input-unified');
        const member = state.members.find(m => m.name === memberName);
        const section = member ? (member.section || 1) : 1;
        const guestVal = guestInput ? guestInput.value : '';

        if (section === 2) {
            state.attendance[key].guestsMain = '';
            state.attendance[key].guestsBack = guestVal;
        } else {
            state.attendance[key].guestsMain = guestVal;
            state.attendance[key].guestsBack = '';
        }

        const bigFlagCb = row.querySelector('.big-flag-checkbox');
        state.attendance[key].bigFlag = bigFlagCb ? bigFlagCb.checked : false;

        const morningCb = row.querySelector('.morning-withdraw-checkbox');
        state.attendance[key].morningWithdraw = morningCb ? morningCb.checked : false;

        const jankenCb = row.querySelector('.janken-participate-checkbox');
        state.attendance[key].jankenParticipate = jankenCb ? jankenCb.checked : false;
    }

    // Save
    saveToLocal();
    updateMatchSummary(matchId);
    
    const btn = row.querySelector('.submit-attendance-btn');
    let originalText = 'この内容で登録する';
    if (btn) {
        originalText = btn.innerText;
        btn.innerText = '登録中...';
        btn.disabled = true;
    }
    
    await apiCall('update_attendance', {
        matchId: matchId,
        memberName: memberName,
        status: state.attendance[key].status,
        guestsMain: state.attendance[key].guestsMain,
        guestsBack: state.attendance[key].guestsBack,
        bigFlag: state.attendance[key].bigFlag,
        jankenParticipate: state.attendance[key].jankenParticipate,
        morningWithdraw: state.attendance[key].morningWithdraw
    });

    if (btn) {
        btn.innerText = '登録完了！';
        btn.style.backgroundColor = '#4CAF50';
        btn.style.color = 'white';
        setTimeout(() => {
            btn.innerText = originalText;
            btn.style.backgroundColor = '';
            btn.style.color = '';
            btn.disabled = false;
        }, 2000);
    }
}

// Event Listeners
function setupEventListeners() {
    // Add Member
    if (addMemberBtn) {
        addMemberBtn.addEventListener('click', () => {
            const name = newMemberNameInput.value.trim();
            const sectionRadio = document.querySelector('input[name="new-member-section"]:checked');
            const section = parseInt(sectionRadio ? sectionRadio.value : 1);

            if (name && !state.members.some(m => m.name === name)) {
                // Optimistic Update
                state.members.push({ name, section });
                saveToLocal();
                renderMatches();
                newMemberNameInput.value = '';

                // API Call
                apiCall('add_member', { name, section });
            } else if (state.members.some(m => m.name === name)) {
                alert('そのメンバーは既に存在します');
            }
        });
    }

    // Match Limit Change
    const limitInput = document.getElementById('match-limit-input');
    if (limitInput) {
        // Immediate local update
        limitInput.addEventListener('input', (e) => {
            state.matchLimit = e.target.value;
            saveToLocal();
            renderMatches();
        });

        // Sync to server only on blur/change to avoid race conditions and excessive calls
        limitInput.addEventListener('change', (e) => {
            apiCall('update_setting', {
                key: 'matchLimit',
                value: state.matchLimit
            });
        });
    }

    // Add Match
    if (addMatchBtn) {
        addMatchBtn.addEventListener('click', () => {
            const date = newMatchDateInput.value;
            const opponent = newMatchOpponentInput.value.trim();

            const locationRadio = document.querySelector('input[name="new-match-location"]:checked');
            const location = locationRadio ? locationRadio.value : 'home';
            const seatTypeRadio = document.querySelector('input[name="new-match-seat-type"]:checked');
            const seatType = (location === 'away' && seatTypeRadio) ? seatTypeRadio.value : '';

            // New fields
            const deadline = document.getElementById('new-match-deadline').value;
            const queueFlag = document.getElementById('new-match-queue-flag').checked;
            const queueTime = document.getElementById('new-match-queue-time').value;
            const lineOrgFlag = document.getElementById('new-match-line-org-flag').checked;
            const lineOrgTime = document.getElementById('new-match-line-org-time').value;
            const awayNotice = document.getElementById('new-match-away-notice').value;

            const kickoff = newMatchKickoffInput ? newMatchKickoffInput.value : '';
            const venue = newMatchVenueInput ? newMatchVenueInput.value.trim() : '';
            const opening = newMatchOpeningInput ? newMatchOpeningInput.value : '';

            if (date && opponent) {
                const isAwayFree = (location === 'away' && seatType === 'free');
                const newMatch = {
                    id: Date.now(),
                    date,
                    opponent,
                    kickoff,
                    venue,
                    opening,
                    location,
                    seatType,
                    deadline: (location === 'away' ? deadline : ''),
                    queueFlag: (isAwayFree ? queueFlag : false),
                    queueTime: (isAwayFree ? queueTime : ''),
                    lineOrgFlag: (isAwayFree ? lineOrgFlag : false),
                    lineOrgTime: (isAwayFree ? lineOrgTime : ''),
                    awayNotice: awayNotice
                };
                // Optimistic Update
                state.matches.push(newMatch);
                saveToLocal();
                renderMatches();
                newMatchDateInput.value = '';
                newMatchOpponentInput.value = '';
                if (newMatchKickoffInput) newMatchKickoffInput.value = '';
                if (newMatchVenueInput) newMatchVenueInput.value = '日立台';
                if (newMatchOpeningInput) newMatchOpeningInput.value = '';

                // Reset radio buttons and fields
                const homeRadio = document.querySelector('input[name="new-match-location"][value="home"]');
                if (homeRadio) homeRadio.checked = true;

                const seatContainer = document.getElementById('away-seat-type-container');
                if (seatContainer) seatContainer.style.display = 'none';

                const detailContainer = document.getElementById('away-general-details');
                if (detailContainer) detailContainer.style.display = 'none';

                document.getElementById('new-match-deadline').value = '';
                document.getElementById('new-match-queue-flag').checked = false;
                document.getElementById('new-match-queue-time').value = '';
                document.getElementById('queue-time-container').style.display = 'none';

                document.getElementById('new-match-line-org-flag').checked = false;
                document.getElementById('new-match-line-org-time').value = '';
                document.getElementById('line-org-time-container').style.display = 'none';
                document.getElementById('new-match-away-notice').value = ''; // Reset awayNotice

                // API Call
                apiCall('add_match', newMatch);
            } else {
                alert('日付と対戦相手を入力してください');
            }
        });

        // Auto-calculate Opening Time
        if (newMatchKickoffInput) {
            newMatchKickoffInput.addEventListener('input', () => {
                const locRadio = document.querySelector('input[name="new-match-location"]:checked');
                const loc = locRadio ? locRadio.value : 'home';
                if (loc === 'home' && newMatchOpeningInput) {
                    newMatchOpeningInput.value = calculateHomeOpeningTime(newMatchKickoffInput.value);
                    
                    const awayNoticeInput = document.getElementById('new-match-away-notice');
                    if (awayNoticeInput && newMatchOpeningInput.value) {
                        const parts = newMatchOpeningInput.value.split(':');
                        if (parts.length === 2) {
                            let h = parseInt(parts[0], 10);
                            let m = parseInt(parts[1], 10);
                            m += 30;
                            if (m >= 60) {
                                m -= 60;
                                h += 1;
                            }
                            const formattedTime = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
                            awayNoticeInput.value = updateFlagNoticeText(awayNoticeInput.value, formattedTime);
                        }
                    }
                }
            });
        }

        // Manual change Opening Time listener
        if (newMatchOpeningInput) {
            newMatchOpeningInput.addEventListener('input', () => {
                const locRadio = document.querySelector('input[name="new-match-location"]:checked');
                const loc = locRadio ? locRadio.value : 'home';
                if (loc === 'home') {
                    const awayNoticeInput = document.getElementById('new-match-away-notice');
                    if (awayNoticeInput && newMatchOpeningInput.value) {
                        const parts = newMatchOpeningInput.value.split(':');
                        if (parts.length === 2) {
                            let h = parseInt(parts[0], 10);
                            let m = parseInt(parts[1], 10);
                            m += 30;
                            if (m >= 60) {
                                m -= 60;
                                h += 1;
                            }
                            const formattedTime = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
                            awayNoticeInput.value = updateFlagNoticeText(awayNoticeInput.value, formattedTime);
                        }
                    }
                }
            });
        }

        // Toggle Listeners
        const locationRadios = document.querySelectorAll('input[name="new-match-location"]');
        const awaySeatTypeContainer = document.getElementById('away-seat-type-container');
        const awayGeneralDetails = document.getElementById('away-general-details');

        function updateAwayUI(e) {
            const isManualChange = !!e;
            const loc = document.querySelector('input[name="new-match-location"]:checked').value;
            const seat = document.querySelector('input[name="new-match-seat-type"]:checked').value;

            const isAway = (loc === 'away');
            const isFree = (seat === 'free');

            const queueSec = document.getElementById('new-match-queue-section');
            const lineSec = document.getElementById('new-match-line-org-section');

            // Detect if the Away/Free details were previously hidden to trigger auto-check
            const wasAwayFreeVisible = (awayGeneralDetails.style.display === 'flex' &&
                queueSec && queueSec.style.display === 'flex');

            if (isAway) {
                awaySeatTypeContainer.style.display = 'flex';
                awayGeneralDetails.style.display = 'flex';

                if (queueSec) queueSec.style.display = isFree ? 'flex' : 'none';
                if (lineSec) lineSec.style.display = isFree ? 'flex' : 'none';

                if (isManualChange && isAway && isFree && !wasAwayFreeVisible) {
                    const qFlag = document.getElementById('new-match-queue-flag');
                    if (qFlag) {
                        qFlag.checked = true;
                        document.getElementById('queue-time-container').style.display = 'flex';
                    }
                    const lFlag = document.getElementById('new-match-line-org-flag');
                    if (lFlag) {
                        lFlag.checked = true;
                        document.getElementById('line-org-time-container').style.display = 'flex';
                    }
                }
                
                if (isManualChange) {
                    if (newMatchVenueInput) newMatchVenueInput.value = '';
                    const awayNoticeInput = document.getElementById('new-match-away-notice');
                    if (awayNoticeInput) awayNoticeInput.value = '';
                }
            } else {
                awaySeatTypeContainer.style.display = 'none';
                awayGeneralDetails.style.display = 'none';
                
                if (isManualChange) {
                    if (newMatchVenueInput) newMatchVenueInput.value = '日立台';
                    const awayNoticeInput = document.getElementById('new-match-away-notice');
                    if (awayNoticeInput && newMatchOpeningInput && newMatchOpeningInput.value) {
                        const parts = newMatchOpeningInput.value.split(':');
                        if (parts.length === 2) {
                            let h = parseInt(parts[0], 10);
                            let m = parseInt(parts[1], 10);
                            m += 30;
                            if (m >= 60) {
                                m -= 60;
                                h += 1;
                            }
                            const formattedTime = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
                            awayNoticeInput.value = updateFlagNoticeText(awayNoticeInput.value, formattedTime);
                        }
                    }
                }
            }
            if (newMatchOpeningContainer) newMatchOpeningContainer.style.display = 'flex';
        }

        locationRadios.forEach(radio => {
            radio.addEventListener('change', updateAwayUI);
        });

        document.querySelectorAll('input[name="new-match-seat-type"]').forEach(radio => {
            radio.addEventListener('change', updateAwayUI);
        });

        const queueFlagCheckbox = document.getElementById('new-match-queue-flag');
        const queueTimeContainer = document.getElementById('queue-time-container');
        if (queueFlagCheckbox && queueTimeContainer) {
            queueFlagCheckbox.addEventListener('change', (e) => {
                queueTimeContainer.style.display = e.target.checked ? 'flex' : 'none';
            });
        }

        const lineOrgFlagCheckbox = document.getElementById('new-match-line-org-flag');
        const lineOrgTimeContainer = document.getElementById('line-org-time-container');
        if (lineOrgFlagCheckbox && lineOrgTimeContainer) {
            lineOrgFlagCheckbox.addEventListener('change', (e) => {
                lineOrgTimeContainer.style.display = e.target.checked ? 'flex' : 'none';
            });
        }

        // League Registration
        const addLeagueBtn = document.getElementById('add-league-btn');
        if (addLeagueBtn) {
            addLeagueBtn.addEventListener('click', addLeague);

            // League Admin Actions (Dropdown style)
            const leagueSelect = document.getElementById('leagues-select-admin');
            const editLeagueBtn = document.getElementById('edit-league-btn-admin');
            const deleteLeagueBtn = document.getElementById('delete-league-btn-admin');

            if (editLeagueBtn && leagueSelect) {
                editLeagueBtn.addEventListener('click', () => {
                    const leagueId = leagueSelect.value;
                    if (leagueId) {
                        openEditLeagueModal(leagueId);
                    } else {
                        alert('編集するリーグを選択してください');
                    }
                });
            }

            if (deleteLeagueBtn && leagueSelect) {
                deleteLeagueBtn.addEventListener('click', () => {
                    const leagueId = leagueSelect.value;
                    if (leagueId) {
                        deleteLeague(leagueId);
                    } else {
                        alert('削除するリーグを選択してください');
                    }
                });
            }
        }
    }

    // Admin Match Actions (Dropdown style)
    const matchesSelect = document.getElementById('matches-select-admin');
    const editMatchBtn = document.getElementById('edit-match-btn-admin');
    const deleteMatchBtn = document.getElementById('delete-match-btn-admin');

    if (editMatchBtn && matchesSelect) {
        editMatchBtn.addEventListener('click', () => {
            const matchId = matchesSelect.value;
            if (matchId) {
                openEditMatchModal(parseInt(matchId));
            } else {
                alert('編集する試合を選択してください');
            }
        });
    }

    if (deleteMatchBtn && matchesSelect) {
        deleteMatchBtn.addEventListener('click', () => {
            const matchId = matchesSelect.value;
            if (matchId) {
                if (confirm('本当にこの試合を削除しますか？')) {
                    const id = parseInt(matchId);
                    state.matches = state.matches.filter(m => m.id != id);
                    saveToLocal();
                    renderMatches();
                    apiCall('delete_match', { id: id });
                }
            } else {
                alert('削除する試合を選択してください');
            }
        });
    }

    // Admin Member Actions (Delete/Edit)
    const membersSelect = document.getElementById('members-select-admin');
    const editBtn = document.getElementById('edit-member-btn-admin');
    const deleteBtn = document.getElementById('delete-member-btn-admin');

    if (editBtn && membersSelect) {
        editBtn.addEventListener('click', () => {
            const memberName = membersSelect.value;
            if (memberName) {
                openEditMemberModal(memberName);
            } else {
                alert('編集するメンバーを選択してください');
            }
        });
    }

    if (deleteBtn && membersSelect) {
        deleteBtn.addEventListener('click', () => {
            const memberName = membersSelect.value;
            if (memberName) {
                if (confirm(`メンバー「${memberName}」を削除しますか？\n(過去の出欠データからも削除されます)`)) {
                    state.members = state.members.filter(m => m.name !== memberName);
                    // Cleanup attendance data for this member locally
                    Object.keys(state.attendance).forEach(key => {
                        if (key.endsWith(`_${memberName} `)) {
                            delete state.attendance[key];
                        }
                    });
                    saveToLocal();
                    renderMatches();
                    apiCall('delete_member', { name: memberName });
                }
            } else {
                alert('削除するメンバーを選択してください');
            }
        });
    }

    // Edit Member Modal Elements
    const editModal = document.getElementById('edit-member-modal');
    const editNameInput = document.getElementById('edit-member-name');
    const saveEditBtn = document.getElementById('save-edit-member');
    const cancelEditBtn = document.getElementById('cancel-edit-member');
    let currentEditingMemberName = null;

    function openEditMemberModal(name) {
        const member = state.members.find(m => m.name === name);
        if (member) {
            currentEditingMemberName = name;
            editNameInput.value = member.name;
            const radios = document.getElementsByName('edit-member-section');
            radios.forEach(r => {
                r.checked = (parseInt(r.value) === (member.section || 1));
            });
            editModal.style.display = 'flex';
        }
    }

    if (saveEditBtn) {
        saveEditBtn.onclick = () => {
            const newName = editNameInput.value.trim();
            const sectionRadio = document.querySelector('input[name="edit-member-section"]:checked');
            const newSection = parseInt(sectionRadio ? sectionRadio.value : 1);

            if (!newName) {
                alert('名前を入力してください');
                return;
            }

            if (newName !== currentEditingMemberName && state.members.some(m => m.name === newName)) {
                alert('その名前は既に使用されています');
                return;
            }

            const member = state.members.find(m => m.name === currentEditingMemberName);
            if (member) {
                // Update attendance keys if name changed locally
                if (newName !== currentEditingMemberName) {
                    const newAttendance = {};
                    Object.keys(state.attendance).forEach(key => {
                        if (key.endsWith(`_${currentEditingMemberName} `)) {
                            const matchId = key.split('_')[0];
                            newAttendance[`${matchId}_${newName} `] = state.attendance[key];
                        } else {
                            newAttendance[key] = state.attendance[key];
                        }
                    });
                    state.attendance = newAttendance;
                }

                // Update member data
                member.name = newName;
                member.section = newSection;

                saveToLocal();
                renderMatches();
                editModal.style.display = 'none';

                apiCall('update_member', {
                    originalName: currentEditingMemberName,
                    name: newName,
                    section: newSection
                });

                currentEditingMemberName = null;
            }
        };
    }

    if (cancelEditBtn) {
        cancelEditBtn.onclick = () => {
            editModal.style.display = 'none';
            currentEditingMemberName = null;
        };
    }

    // Password Update
    const updatePasswordBtn = document.getElementById('update-password-btn');
    if (updatePasswordBtn) {
        updatePasswordBtn.addEventListener('click', async () => {
            const oldPassword = document.getElementById('admin-old-password').value;
            const newPassword = document.getElementById('admin-new-password').value;

            if (!oldPassword || !newPassword) {
                alert('現在のパスワードと新しいパスワードの両方を入力してください。');
                return;
            }

            if (newPassword.length < 3) {
                alert('新しいパスワードは3文字以上で入力してください。');
                return;
            }

            if (confirm('パスワードを変更しますか？')) {
                setLoading(true, 'full');
                try {
                    const res = await fetch(API_URL, {
                        method: 'POST',
                        body: JSON.stringify({
                            action: 'update_admin_password',
                            oldPassword: oldPassword,
                            newPassword: newPassword
                        })
                    });
                    const json = await res.json();
                    if (json.result === 'success') {
                        alert('パスワードを更新しました。');
                        document.getElementById('admin-old-password').value = '';
                        document.getElementById('admin-new-password').value = '';
                    } else {
                        alert('エラー: ' + (json.error || '更新に失敗しました。'));
                    }
                } catch (e) {
                    console.error('Password update error:', e);
                    alert('通信エラーが発生しました。');
                } finally {
                    setLoading(false);
                }
            }
        });
    }

    // Initialize League Modal Listeners
    setupEditLeagueModalListeners();
}

function attachMatchListeners() {
    // Match Header Toggle (Expand/Collapse)
    document.querySelectorAll('.match-header').forEach(header => {
        header.addEventListener('click', (e) => {
            // Don't toggle if clicking on admin buttons
            if (e.target.closest('.match-controls')) return;

            const matchEl = e.target.closest('.match-card');
            const matchId = parseInt(matchEl.dataset.matchId);

            if (state.expandedMatches.has(matchId)) {
                state.expandedMatches.delete(matchId);
                matchEl.classList.add('collapsed');
            } else {
                state.expandedMatches.add(matchId);
                matchEl.classList.remove('collapsed');
            }
        });
    });

    // Attendance Changes (Sub-status)
    document.querySelectorAll('.status-options input[type="radio"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            const row = e.target.closest('.attendance-row');
            const key = row.dataset.key;
            const matchId = key.split('_')[0];
            const memberName = key.split('_')[1];
            const status = parseInt(e.target.value);

            if (!state.attendance[key]) state.attendance[key] = { status: null, guestsMain: '', guestsBack: '', bigFlag: false, jankenParticipate: false, morningWithdraw: false };
            state.attendance[key].status = status;
        });
    });

    // Presence Changes (Attendance vs Absence)
    document.querySelectorAll('.presence-radio').forEach(radio => {
        radio.addEventListener('change', (e) => {
            const row = e.target.closest('.attendance-row');
            const details = row.querySelector('.attendance-details');
            const key = row.dataset.key;
            const matchId = key.split('_')[0];
            const namePart = key.substring(matchId.length + 1);
            const val = e.target.value;

            if (!state.attendance[key]) state.attendance[key] = { status: null, guestsMain: '', guestsBack: '', bigFlag: false, jankenParticipate: false, morningWithdraw: false };

            if (val === 'absence') {
                state.attendance[key].status = 5;
                state.attendance[key].guestsMain = '';
                state.attendance[key].guestsBack = '';
                state.attendance[key].bigFlag = false;

                // UI Reset
                const guestInput = row.querySelector('.guest-input-unified');
                if (guestInput) guestInput.value = '';
                const bigFlagCheckbox = row.querySelector('.big-flag-checkbox');
                if (bigFlagCheckbox) bigFlagCheckbox.checked = false;

                details.classList.add('disabled-section');
                details.querySelectorAll('input').forEach(input => input.disabled = true);
            } else {
                // Return to attendance.
                const match = state.matches.find(m => m.id == matchId);
                const isAwayReserved = match && match.location === 'away' && match.seatType === 'reserved';

                // If switching from Absent (5) or it's current null/empty, reset sub-status
                // BUT for Away Reserved, we don't have sub-radios, so we use 1 as default "Attending"
                if (state.attendance[key].status === 5 || !state.attendance[key].status) {
                    state.attendance[key].status = isAwayReserved ? 1 : 0; // 0: Attending but sub-status unpicked
                }

                details.classList.remove('disabled-section');
                details.querySelectorAll('input').forEach(input => input.disabled = false);

                const currentStatus = state.attendance[key].status;
                const subRadios = row.querySelectorAll('.status-options input[type="radio"]');
                subRadios.forEach(r => {
                    r.checked = (parseInt(r.value) === currentStatus);
                });
            }
        });
    });

    // Guest Count Changes (Unified)
    document.querySelectorAll('.guest-input-unified').forEach(input => {
        input.addEventListener('input', (e) => {
            const row = e.target.closest('.attendance-row');
            const key = row.dataset.key;
            const matchId = key.split('_')[0];
            const namePart = key.substring(matchId.length + 1);

            const member = state.members.find(m => m.name === namePart);
            const section = member ? (member.section || 1) : 1;

            if (!state.attendance[key]) state.attendance[key] = { status: null, guestsMain: '', guestsBack: '', bigFlag: false, jankenParticipate: false, morningWithdraw: false };

            const val = e.target.value;

            if (section === 2) { // Back
                state.attendance[key].guestsMain = '';
                state.attendance[key].guestsBack = val;
            } else { // Main
                state.attendance[key].guestsMain = val;
                state.attendance[key].guestsBack = '';
            }
        });
    });

    // Big Flag Checkbox
    document.querySelectorAll('.big-flag-checkbox').forEach(checkbox => {
        checkbox.addEventListener('change', (e) => {
            const row = e.target.closest('.attendance-row');
            const key = row.dataset.key;
            const matchId = key.split('_')[0];
            const namePart = key.substring(matchId.length + 1);

            if (!state.attendance[key]) state.attendance[key] = { status: null, guestsMain: '', guestsBack: '', bigFlag: false, jankenParticipate: false, morningWithdraw: false };
            state.attendance[key].bigFlag = e.target.checked;
        });
    });

    // Janken Participate Checkbox
    document.querySelectorAll('.janken-participate-checkbox').forEach(checkbox => {
        checkbox.addEventListener('change', (e) => {
            const row = e.target.closest('.attendance-row');
            const key = row.dataset.key;
            const matchId = key.split('_')[0];
            const namePart = key.substring(matchId.length + 1);

            if (!state.attendance[key]) state.attendance[key] = { status: null, guestsMain: '', guestsBack: '', bigFlag: false, jankenParticipate: false, morningWithdraw: false };
            state.attendance[key].jankenParticipate = e.target.checked;
        });
    });

    // Morning Withdraw Checkbox
    document.querySelectorAll('.morning-withdraw-checkbox').forEach(checkbox => {
        checkbox.addEventListener('change', (e) => {
            const row = e.target.closest('.attendance-row');
            const key = row.dataset.key;
            const matchId = key.split('_')[0];
            const namePart = key.substring(matchId.length + 1);

            if (!state.attendance[key]) state.attendance[key] = { status: null, guestsMain: '', guestsBack: '', bigFlag: false, jankenParticipate: false, morningWithdraw: false };
            state.attendance[key].morningWithdraw = e.target.checked;
        });
    });

    // Save Janken Confirmed (Admin)
    // Janken Admin Actions (Dropdown & Tags)
    // Add Member
    document.querySelectorAll('.janken-add-select').forEach(select => {
        select.addEventListener('change', (e) => {
            const matchId = e.target.dataset.matchId;
            const name = e.target.value;
            if (!name) return;

            const match = state.matches.find(m => m.id == matchId);
            if (match) {
                const current = (match.jankenConfirmed || '').split(',').map(s => s.trim()).filter(s => s);
                if (!current.includes(name)) {
                    current.push(name);
                    const val = current.join(', ');
                    match.jankenConfirmed = val;
                    saveToLocal();
                    renderMatches(); // Re-render to update UI
                    apiCall('update_match', { id: matchId, jankenConfirmed: val });
                }
            }
        });
    });

    // Remove Tag
    document.querySelectorAll('.remove-janken-tag').forEach(span => {
        span.addEventListener('click', (e) => {
            const matchId = e.target.dataset.matchId;
            const name = e.target.dataset.name;

            const match = state.matches.find(m => m.id == matchId);
            if (match) {
                const current = (match.jankenConfirmed || '').split(',').map(s => s.trim()).filter(s => s);
                const newVal = current.filter(n => n !== name).join(', ');
                match.jankenConfirmed = newVal;
                saveToLocal();
                renderMatches();
                apiCall('update_match', { id: matchId, jankenConfirmed: newVal });
            }
        });
    });

    // Delete Match
    document.querySelectorAll('.delete-match-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            if (confirm('この試合を削除しますか？')) {
                const id = parseInt(e.target.dataset.id);
                state.matches = state.matches.filter(m => m.id !== id);
                saveToLocal();
                renderMatches();
                apiCall('delete_match', { id: id });
            }
        });
    });

    // Edit Match
    document.querySelectorAll('.edit-match-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const id = parseInt(e.target.dataset.id);
            openEditMatchModal(id);
        });
    });
}

function openEditMatchModal(matchId) {
    const match = state.matches.find(m => m.id === matchId);
    if (!match) return;

    const modal = document.getElementById('edit-match-modal');
    const dateInput = document.getElementById('edit-match-date');
    const opponentInput = document.getElementById('edit-match-opponent');
    const deadlineInput = document.getElementById('edit-match-deadline');
    const queueFlagInput = document.getElementById('edit-match-queue-flag');
    const queueTimeInput = document.getElementById('edit-match-queue-time');
    const lineOrgFlagInput = document.getElementById('edit-match-line-org-flag');
    const lineOrgTimeInput = document.getElementById('edit-match-line-org-time');

    const formatForInput = (dateStr, isDateTime = false) => {
        if (!dateStr) return '';
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr;

        const pad = (num) => String(num).padStart(2, '0');
        const year = d.getFullYear();
        const month = pad(d.getMonth() + 1);
        const day = pad(d.getDate());

        if (isDateTime) {
            const hours = pad(d.getHours());
            const minutes = pad(d.getMinutes());
            return `${year}-${month}-${day}T${hours}:${minutes}`;
        }
        return `${year}-${month}-${day}`;
    };

    dateInput.value = formatForInput(match.date);
    opponentInput.value = match.opponent;

    if (editMatchKickoffInput) editMatchKickoffInput.value = formatTime(match.kickoff) || '';
    if (editMatchVenueInput) editMatchVenueInput.value = match.venue || '';
    if (editMatchOpeningInput) editMatchOpeningInput.value = formatTime(match.opening) || '';

    // Set radios
    const locRadios = document.getElementsByName('edit-match-location');
    locRadios.forEach(r => r.checked = (r.value === (match.location || 'home')));

    const seatRadios = document.getElementsByName('edit-match-seat-type');
    seatRadios.forEach(r => r.checked = (r.value === (match.seatType || 'free')));

    // Set other fields with proper formatting
    deadlineInput.value = formatForInput(match.deadline, true);
    queueFlagInput.checked = !!match.queueFlag;
    queueTimeInput.value = formatForInput(match.queueTime, true);
    lineOrgFlagInput.checked = !!match.lineOrgFlag;
    lineOrgTimeInput.value = formatForInput(match.lineOrgTime, true);
    document.getElementById('edit-match-away-notice').value = match.awayNotice || '';
    
    // Auto-populate notice if empty for home matches
    if (match.location !== 'away' && !match.awayNotice && match.opening) {
        const parts = match.opening.split(':');
        if (parts.length === 2) {
            let h = parseInt(parts[0], 10);
            let m = parseInt(parts[1], 10);
            m += 30;
            if (m >= 60) {
                m -= 60;
                h += 1;
            }
            const formattedTime = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
            document.getElementById('edit-match-away-notice').value = updateFlagNoticeText(document.getElementById('edit-match-away-notice').value, formattedTime);
        }
    }

    // Function for modal UI updates
    const updateModalUI = (isManualChange = false) => {
        const loc = Array.from(locRadios).find(r => r.checked)?.value || 'home';
        const seat = Array.from(seatRadios).find(r => r.checked)?.value || 'free';

        const seatContainer = document.getElementById('edit-away-seat-type-container');
        const generalDetails = document.getElementById('edit-away-general-details');
        const queueSec = document.getElementById('edit-match-queue-section');
        const lineSec = document.getElementById('edit-match-line-org-section');

        const isAway = (loc === 'away');
        const isFree = (seat === 'free');

        const wasAwayFreeVisible = (generalDetails.style.display === 'flex' &&
            queueSec && queueSec.style.display === 'flex');

        if (isAway) {
            seatContainer.style.display = 'flex';
            generalDetails.style.display = 'flex';

            if (queueSec) queueSec.style.display = isFree ? 'flex' : 'none';
            if (lineSec) lineSec.style.display = isFree ? 'flex' : 'none';

            if (isManualChange && isAway && isFree && !wasAwayFreeVisible) {
                queueFlagInput.checked = true;
                lineOrgFlagInput.checked = true;
            }
            
            if (isManualChange) {
                if (editMatchVenueInput) editMatchVenueInput.value = '';
                const editNoticeInput = document.getElementById('edit-match-away-notice');
                if (editNoticeInput) editNoticeInput.value = '';
            }
        } else {
            seatContainer.style.display = 'none';
            generalDetails.style.display = 'none';
            
            if (isManualChange) {
                if (editMatchVenueInput) {
                    if (!editMatchVenueInput.value) editMatchVenueInput.value = '日立台';
                }
                const editNoticeInput = document.getElementById('edit-match-away-notice');
                if (editNoticeInput && editMatchOpeningInput && editMatchOpeningInput.value) {
                    const parts = editMatchOpeningInput.value.split(':');
                    if (parts.length === 2) {
                        let h = parseInt(parts[0], 10);
                        let m = parseInt(parts[1], 10);
                        m += 30;
                        if (m >= 60) {
                            m -= 60;
                            h += 1;
                        }
                        const formattedTime = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
                        editNoticeInput.value = updateFlagNoticeText(editNoticeInput.value, formattedTime);
                    }
                }
            }
        }
        if (editMatchOpeningContainer) editMatchOpeningContainer.style.display = 'flex';

        document.getElementById('edit-queue-time-container').style.display = queueFlagInput.checked ? 'flex' : 'none';
        document.getElementById('edit-line-org-time-container').style.display = lineOrgFlagInput.checked ? 'flex' : 'none';
    };

    // Attach listeners for modal
    locRadios.forEach(r => r.onchange = () => updateModalUI(true));
    seatRadios.forEach(r => r.onchange = () => updateModalUI(true));
    queueFlagInput.onchange = () => updateModalUI(false);
    lineOrgFlagInput.onchange = () => updateModalUI(false);

    updateModalUI(false);

    if (editMatchKickoffInput) {
        editMatchKickoffInput.oninput = () => {
            const loc = Array.from(locRadios).find(r => r.checked)?.value || 'home';
            if (loc === 'home' && editMatchOpeningInput) {
                editMatchOpeningInput.value = calculateHomeOpeningTime(editMatchKickoffInput.value);
                
                const editNoticeInput = document.getElementById('edit-match-away-notice');
                if (editNoticeInput && editMatchOpeningInput.value) {
                    const parts = editMatchOpeningInput.value.split(':');
                    if (parts.length === 2) {
                        let h = parseInt(parts[0], 10);
                        let m = parseInt(parts[1], 10);
                        m += 30;
                        if (m >= 60) {
                            m -= 60;
                            h += 1;
                        }
                        const formattedTime = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
                        editNoticeInput.value = updateFlagNoticeText(editNoticeInput.value, formattedTime);
                    }
                }
            }
        };
    }

    if (editMatchOpeningInput) {
        editMatchOpeningInput.oninput = () => {
            const loc = Array.from(locRadios).find(r => r.checked)?.value || 'home';
            if (loc === 'home') {
                const editNoticeInput = document.getElementById('edit-match-away-notice');
                if (editNoticeInput && editMatchOpeningInput.value) {
                    const parts = editMatchOpeningInput.value.split(':');
                    if (parts.length === 2) {
                        let h = parseInt(parts[0], 10);
                        let m = parseInt(parts[1], 10);
                        m += 30;
                        if (m >= 60) {
                            m -= 60;
                            h += 1;
                        }
                        const formattedTime = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
                        editNoticeInput.value = updateFlagNoticeText(editNoticeInput.value, formattedTime);
                    }
                }
            }
        };
    }
    modal.style.display = 'flex';

    // Save/Cancel
    document.getElementById('save-edit-match').onclick = () => {
        const loc = Array.from(locRadios).find(r => r.checked)?.value || 'home';
        const seat = Array.from(seatRadios).find(r => r.checked)?.value || 'free';

        const updatedMatch = {
            id: matchId,
            date: dateInput.value,
            opponent: opponentInput.value.trim(),
            kickoff: editMatchKickoffInput ? editMatchKickoffInput.value : '',
            venue: editMatchVenueInput ? editMatchVenueInput.value.trim() : '',
            opening: editMatchOpeningInput ? editMatchOpeningInput.value : '',
            location: loc,
            seatType: (loc === 'away' ? seat : ''),
            deadline: (loc === 'away' ? deadlineInput.value : ''),
            awayNotice: document.getElementById('edit-match-away-notice').value,
            queueFlag: (loc === 'away' && seat === 'free' ? queueFlagInput.checked : false),
            queueTime: (loc === 'away' && seat === 'free' && queueFlagInput.checked ? queueTimeInput.value : ''),
            lineOrgFlag: (loc === 'away' && seat === 'free' ? lineOrgFlagInput.checked : false),
            lineOrgTime: (loc === 'away' && seat === 'free' && lineOrgFlagInput.checked ? lineOrgTimeInput.value : '')
        };

        if (!updatedMatch.date || !updatedMatch.opponent) {
            alert('日付と対戦相手を入力してください');
            return;
        }

        // Update local state
        const idx = state.matches.findIndex(m => m.id === matchId);
        if (idx !== -1) {
            state.matches[idx] = { ...state.matches[idx], ...updatedMatch };
            saveToLocal();
            renderMatches();
            modal.style.display = 'none';
            apiCall('update_match', updatedMatch);
        }
    };

    document.getElementById('cancel-edit-match').onclick = () => {
        modal.style.display = 'none';
    };
}

function renderMembersAdmin() {
    const select = document.getElementById('members-select-admin');
    if (!select) return;

    const currentValue = select.value;
    select.innerHTML = '<option value="">-- メンバーを選択 --</option>' +
        state.members.sort((a, b) => a.name.localeCompare(b.name)).map(member => `
            <option value="${member.name}" ${member.name === currentValue ? 'selected' : ''}>${member.name} (${SECTION_LABELS[member.section] || 'TOP'})</option>
        `).join('');
}

function updateMatchSummary(matchId) {
    const container = document.getElementById(`summary-${matchId}`);
    if (container) {
        container.innerHTML = generateMatchSummaryContent(matchId);
    }
}

function generateMatchSummaryContent(matchId) {
    const summary = {}; // { statusId: [names] }
    let memberMain = 0;
    let memberBack = 0;
    let guestMain = 0;
    let guestBack = 0;
    let outsideTotal = 0;

    // Initialize map
    STATUS_OPTIONS.forEach(opt => summary[opt.id] = []);

    const unansweredMembers = [];

    const match = state.matches.find(m => m.id == matchId);
    if (!match) return '';

    state.members.forEach(member => {
        const key = `${matchId}_${member.name}`;
        const data = state.attendance[key];

        if (data && data.status !== null && data.status !== "") {
            let effectiveStatus = data.status;

            // Validate away-specific statuses
            if (effectiveStatus == 6 && !match.queueFlag) effectiveStatus = null;
            if (effectiveStatus == 7 && !match.lineOrgFlag) effectiveStatus = null;

            if (effectiveStatus && summary[effectiveStatus]) {
                const guestCount = (parseInt(data.guestsMain) || 0) + (parseInt(data.guestsBack) || 0);
                const displayName = guestCount > 0 ? `${member.name} (+${guestCount})` : member.name;
                summary[effectiveStatus].push(displayName);
            }

            // Exclude Absent (5) and Outside Hakunetsu (4) from section totals
            // Allow status 0 (Attending but pending) to be counted
            if (effectiveStatus !== null && effectiveStatus != 5 && effectiveStatus !== 4) {
                if (member.section === 2) {
                    memberBack += 1;
                } else {
                    memberMain += 1;
                }

                // Count guests for section totals
                if (data.guestsMain) guestMain += parseInt(data.guestsMain) || 0;
                if (data.guestsBack) guestBack += parseInt(data.guestsBack) || 0;
            } else if (effectiveStatus === 4) {
                // Count status 4 ("柏熱以外で") separately
                outsideTotal += 1; // The member themselves
                outsideTotal += (parseInt(data.guestsMain) || 0) + (parseInt(data.guestsBack) || 0);
            }
        } else {
            unansweredMembers.push(member.name);
        }
    });

    const isAway = match && match.location === 'away';
    let html = '<div class="match-summary"><div class="summary-title">集計</div>';

    if (!isAway) {
        const jankenConfirmed = (match.jankenConfirmed || '').split(',').map(s => s.trim()).filter(s => s);
        const jankenParticipants = state.members.filter(member => {
            const key = `${matchId}_${member.name}`;
            const data = state.attendance[key];
            return data && data.jankenParticipate;
        }).map(m => m.name);

        if (jankenConfirmed.length > 0 || jankenParticipants.length > 0) {
            html += `
                <div class="summary-item active" style="background-color: #ffebee; border: 1px solid #ef5350; flex-direction: column; align-items: flex-start; gap: 0.4rem;">
            `;

            if (jankenConfirmed.length > 0) {
                html += `
                    <div style="width: 100%; padding-bottom: 0.3rem; border-bottom: 1px dashed #ef5350;">
                        <span class="summary-count" style="color: #7b1fa2; font-size: 1rem;">じゃんけん大会参加確定者:</span>
                        <span style="color: #7b1fa2; font-weight: 900; font-size: 1.15rem; margin-left: 0.3rem;">${jankenConfirmed.join(', ')}</span>
                    </div>
                `;
            }

            if (jankenParticipants.length > 0) {
                html += `
                    <div style="font-size: 0.9rem;">
                        <span class="summary-count" style="color: #c62828;">じゃんけん大会立候補者: ${jankenParticipants.length}名</span>
                        <span class="summary-names">(${jankenParticipants.join(', ')})</span>
                    </div>
                `;
            }

            html += `</div>`;
        }

        // Morning Withdraw Summary (Moved below Janken Candidates)
        const morningMembers = state.members.filter(member => {
            const key = `${matchId}_${member.name}`;
            const data = state.attendance[key];
            return data && data.morningWithdraw;
        }).map(m => m.name);

        if (morningMembers.length > 0) {
            html += `
                <div class="summary-item active" style="background-color: #f1f8e9; border: 1px solid #8bc34a; margin-top: 0.5rem;">
                    <span class="summary-count" style="color: #33691e;">朝の引き込み: ${morningMembers.length}名</span>
                    <span class="summary-names">(${morningMembers.join(', ')})</span>
                </div>
            `;
        }
    }

    const totalMain = memberMain + guestMain;
    const totalBack = memberBack + guestBack;

    // Add Total Count Breakdown
    if (totalMain > 0 || totalBack > 0 || outsideTotal > 0) {
        let sectionTotalsHtml = '';
        let reservedNamesHtml = '';

        if (isAway) {
            // Away: Simple total
            sectionTotalsHtml += `<div>合計 ${totalMain + totalBack}名 <small style="font-weight:normal;">(メンバー${memberMain + memberBack} / 同伴${guestMain + guestBack})</small></div>`;
            if (outsideTotal > 0) sectionTotalsHtml += `<div style="padding-top: 0.1rem; margin-top: 0.1rem;">ゴール裏以外 合計${outsideTotal}名</div>`;

            // If Away Reserved, prepare names list
            if (match.seatType === 'reserved') {
                const attendees = [];
                state.members.forEach(member => {
                    const key = `${matchId}_${member.name}`;
                    const data = state.attendance[key];
                    if (data && data.status && data.status != 5) {
                        const guestCount = (parseInt(data.guestsMain) || 0) + (parseInt(data.guestsBack) || 0);
                        const displayName = guestCount > 0 ? `${member.name} (+${guestCount})` : member.name;
                        attendees.push(displayName);
                    }
                });
                if (attendees.length > 0) {
                    reservedNamesHtml = `<div class="summary-item active" style="margin-top: 0.3rem;"><span class="summary-names" style="font-size: 0.85rem;">出席者: (${attendees.join(', ')})</span></div>`;
                }
            }
        } else {
            // Home: Breakdown by section
            if (totalMain > 0) sectionTotalsHtml += `<div>TOP 合計${totalMain}名 <small style="font-weight:normal;">(メンバー${memberMain} / 同伴${guestMain})</small></div>`;
            if (totalBack > 0) sectionTotalsHtml += `<div>FRONT 合計${totalBack}名 <small style="font-weight:normal;">(メンバー${memberBack} / 同伴${guestBack})</small></div>`;
            if (outsideTotal > 0) sectionTotalsHtml += `<div style="padding-top: 0.1rem; margin-top: 0.1rem;">柏熱以外 合計${outsideTotal}名</div>`;
        }

        html += `
            <div class="summary-item active" style="font-weight: bold; background-color: #fff8e1; border: 2px solid #FCD116; border-radius: 4px; flex-direction: column; align-items: flex-start; gap: 0.2rem;">
                ${sectionTotalsHtml}
            </div>
            ${reservedNamesHtml}
        `;
    }


    const isAwayFree = isAway && match.seatType === 'free';

    // Determine order of status items to display (Explicitly exclude 5 for manual placement)
    let displayOrder = [...STATUS_OPTIONS.filter(opt => opt.id !== 5 && opt.id !== 6 && opt.id !== 7)]; // Default order
    if (isAwayFree) {
        // For Away Free, match radio button order: Queue(6), LineOrg(7), then others
        const awayOrder = [];
        if (match.lineOrgFlag) awayOrder.unshift(STATUS_OPTIONS.find(o => o.id === 7));
        if (match.queueFlag) awayOrder.unshift(STATUS_OPTIONS.find(o => o.id === 6));
        displayOrder = [...awayOrder, ...displayOrder];
    } else if (!isAway) {
        // For Home, append 6 and 7 at the end (though they usually aren't used for Home)
        displayOrder = [...displayOrder, STATUS_OPTIONS.find(o => o.id === 6), STATUS_OPTIONS.find(o => o.id === 7)];
    }

    if (!isAway || isAwayFree) {
        displayOrder.forEach(opt => {
            if (!opt) return;
            const names = summary[opt.id];
            if (names && names.length > 0) {
                let label = opt.label;
                if (isAway && opt.id === 4) label = 'ゴール裏以外';
                html += `
                    <div class="summary-item active">
                        <span class="summary-count">${label}: ${names.length}名</span>
                        <span class="summary-names">(${names.join(', ')})</span>
                    </div>
                `;
            }
        });
    }

    // Function to render Absent Item
    const renderAbsentItem = () => {
        const names = summary[5];
        if (names && names.length > 0) {
            html += `
                <div class="summary-item active">
                    <span class="summary-count">欠席: ${names.length}名</span>
                    <span class="summary-names">(${names.join(', ')})</span>
                </div>
            `;
        }
    };

    // Function to render Unanswered Item
    const renderUnansweredItem = () => {
        if (unansweredMembers.length > 0) {
            html += `
                <div class="summary-item active" style="opacity: 0.8;">
                    <span class="summary-count" style="color:red; font-weight:bold;">未回答: ${unansweredMembers.length}名</span>
                    <span class="summary-names" style="color:red;">(${unansweredMembers.join(', ')})</span>
                </div>
            `;
        }
    };

    // Home: Absent comes BEFORE Big Flag
    if (!isAway) {
        renderAbsentItem();
        renderUnansweredItem();
    }

    // Big Flag Summary (Home only)
    if (!isAway) {
        const bigFlagMembers = state.members.filter(member => {
            const key = `${matchId}_${member.name}`;
            const data = state.attendance[key];
            return data && data.bigFlag;
        }).map(m => m.name);

        if (bigFlagMembers.length > 0) {
            html += `
                <div class="summary-item active" style="background-color: #e3f2fd; border: 1px solid #64b5f6; margin-top: 0.5rem;">
                    <span class="summary-count" style="color: #0d47a1;">ビッグフラッグ搬入手伝い: ${bigFlagMembers.length}名</span>
                    <span class="summary-names">(${bigFlagMembers.join(', ')})</span>
                </div>
            `;
        }
    }

    // Away: Absent comes AFTER Big Flag (at the very bottom)
    if (isAway) {
        renderAbsentItem();
        renderUnansweredItem();
    }

    html += '</div>';
    return html;
}


function generateAttendanceTable(matchId) {
    let html = `
        <details class="attendance-table-details">
            <summary>詳細リストを表示</summary>
            <table class="attendance-table">
                <thead>
                    <tr>
                        <th>名前</th>
                        <th>区分</th>
                        <th>回答</th>
                        <th>同伴(Main)</th>
                        <th>同伴(Back)</th>
                    </tr>
                </thead>
                <tbody>
    `;

    // Sort members for consistency (e.g. by Section then Name)
    const sortedMembers = [...state.members].sort((a, b) => {
        if (a.section !== b.section) return a.section - b.section; // 1 (TOP) then 2 (FRONT)
        return a.name.localeCompare(b.name);
    });

    sortedMembers.forEach(member => {
        const key = `${matchId}_${member.name}`;
        const data = state.attendance[key] || {};

        let statusLabel = '-';
        if (data.status) {
            const statusObj = STATUS_OPTIONS.find(s => s.id == data.status);
            statusLabel = statusObj ? statusObj.label : '-';
        }

        const sectionLabel = SECTION_LABELS[member.section] || 'TOP';
        const guestsMain = data.guestsMain || '-';
        const guestsBack = data.guestsBack || '-';

        // Row highlighting based on status
        let rowClass = '';
        if (data.status === 5) rowClass = 'status-absent'; // 欠席
        else if (data.status) rowClass = 'status-attending'; // 出席

        html += `
            <tr class="${rowClass}">
                <td>${member.name}</td>
                <td><span class="badge section-${member.section}">${sectionLabel}</span></td>
                <td>${statusLabel}</td>
                <td style="text-align:center;">${guestsMain}</td>
                <td style="text-align:center;">${guestsBack}</td>
            </tr>
        `;
    });

    html += `
                </tbody>
            </table>
        </details>
        `;
    return html;
}

function renderLeaguesAdmin() {
    const select = document.getElementById('leagues-select-admin');
    if (!select) return;

    // Sort by start date (newest first)
    const sortedLeagues = [...state.leagues].sort((a, b) => {
        if (a.start < b.start) return 1;
        if (a.start > b.start) return -1;
        return 0;
    });

    const currentVal = select.value;

    select.innerHTML = '<option value="">-- リーグ名を選択 --</option>' +
        sortedLeagues.map(league => `
                <option value="${league.id}">${league.name} (${league.start} ～ ${league.end})</option>
            `).join('');

    if (currentVal && state.leagues.some(l => l.id === currentVal)) {
        select.value = currentVal;
    }
}

function addLeague() {
    const nameInput = document.getElementById('new-league-name');
    const startInput = document.getElementById('new-league-start');
    const endInput = document.getElementById('new-league-end');

    const name = nameInput.value.trim();
    // Convert YYYY-MM-DD to YYYY-MM for storage
    const start = startInput.value ? startInput.value.slice(0, 7) : '';
    const end = endInput.value ? endInput.value.slice(0, 7) : '';

    if (!name || !start || !end) {
        alert('リーグ名と期間を入力してください');
        return;
    }

    const newLeague = {
        id: Date.now().toString(),
        name,
        start,
        end
    };

    state.leagues.push(newLeague);
    saveToLocal();
    renderLeaguesAdmin();

    // Reset inputs
    nameInput.value = '';
    startInput.value = '';
    endInput.value = '';

    // API Call
    syncLeagues();
}

function deleteLeague(leagueId) {
    if (confirm('このリーグを削除しますか？')) {
        state.leagues = state.leagues.filter(l => l.id !== leagueId);
        saveToLocal();
        renderLeaguesAdmin();
        syncLeagues();
    }
}

async function syncLeagues() {
    await apiCall('update_setting', {
        key: 'leagues',
        value: JSON.stringify(state.leagues)
    });
}

// --- Edit League Modal Logic ---
function setupEditLeagueModalListeners() {
    const modal = document.getElementById('edit-league-modal');
    // closeBtn removed to match other modals
    const cancelBtn = document.getElementById('cancel-edit-league');
    const saveBtn = document.getElementById('save-edit-league');

    const closeModal = () => modal.style.display = 'none';

    if (cancelBtn) cancelBtn.onclick = closeModal;

    window.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    if (saveBtn) {
        saveBtn.onclick = updateLeague;
    }
}

function openEditLeagueModal(leagueId) {
    const league = state.leagues.find(l => l.id === leagueId);
    if (!league) return;

    document.getElementById('edit-league-id').value = league.id;
    document.getElementById('edit-league-name').value = league.name;
    // Append -01 to YYYY-MM to make it valid for date input
    document.getElementById('edit-league-start').value = league.start ? league.start + '-01' : '';
    document.getElementById('edit-league-end').value = league.end ? league.end + '-01' : '';

    document.getElementById('edit-league-modal').style.display = 'flex';
}

function updateLeague() {
    const id = document.getElementById('edit-league-id').value;
    const name = document.getElementById('edit-league-name').value.trim();
    const startVal = document.getElementById('edit-league-start').value;
    const endVal = document.getElementById('edit-league-end').value;

    const start = startVal ? startVal.slice(0, 7) : '';
    const end = endVal ? endVal.slice(0, 7) : '';

    if (!name || !start || !end) {
        alert('全ての項目を入力してください');
        return;
    }

    const index = state.leagues.findIndex(l => l.id === id);
    if (index === -1) return;

    state.leagues[index] = { ...state.leagues[index], name, start, end };

    saveToLocal();
    renderLeaguesAdmin();
    syncLeagues();

    document.getElementById('edit-league-modal').style.display = 'none';
}

// Utilities
function formatDate(dateString) {
    const d = parseDate(dateString);
    return `${d.getMonth() + 1}/${d.getDate()} (${['日', '月', '火', '水', '木', '金', '土'][d.getDay()]})`;
}

// Start
init();
