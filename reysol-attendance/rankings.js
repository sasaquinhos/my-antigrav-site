const API_URL = 'https://script.google.com/macros/s/AKfycbzEVd4owVNNMDI-zMaf_Cwx6q_U02jyB_uhu0pjb9Z5dshrVn5HG6CJkt-M5FF20Kiw/exec';

const state = {
    matches: [],
    attendance: {},
    attendanceByMatch: {}, // Grouped: { matchId: [ { memberName, data }, ... ] }
    members: [],
    leagues: [],
    selectedLeague: null,
    selectedLocation: 'home',
    loading: false
};

const STORAGE_KEY = 'reysol_attendance_data';

async function init() {
    console.log('Initializing rankings... URL:', API_URL);

    // 1. Try to load from local data (Stale)
    const hasLocalData = loadFromLocal();

    if (hasLocalData) {
        console.log('Using local data for immediate render');
        setupLeagueSelect();
        renderRankings();
        setupEventListeners();
    } else {
        console.log('No local data, blocking UI');
        showLoading(true);
    }

    try {
        // 2. Fetch fresh data (Revalidate)
        await loadData();

        // Update selection and UI
        setupLeagueSelect();
        renderRankings();

        if (!hasLocalData) {
            setupEventListeners();
        }
    } catch (e) {
        console.error('Data sync failed:', e);
        if (!hasLocalData) {
            alert('データの読み込みに失敗しました: ' + e.message);
        }
    } finally {
        showLoading(false);
    }
}

function setupEventListeners() {
    setupYearSelectListener();
    setupLocationToggle();
}

async function loadData() {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
        const res = await fetch(`${API_URL}?t=${new Date().getTime()}`, {
            signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);

        const data = await res.json();

        if (data.members) state.members = data.members;
        if (data.matches) state.matches = data.matches;
        if (data.attendance) state.attendance = data.attendance;

        if (data.settings && data.settings.leagues) {
            try {
                state.leagues = JSON.parse(data.settings.leagues);
            } catch (e) {
                console.error('Failed to parse leagues settings:', e);
                state.leagues = [];
            }
        }

        // Reset dynamic cache
        state.attendanceByMatch = {};

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
        if (data.attendance) state.attendance = data.attendance;
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
            leagues: state.leagues,
            timestamp: new Date().getTime()
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
        console.error('Error saving to local storage:', e);
    }
}

// Helper to get records for specific matches only
function ensureGroupedData(matchIds) {
    console.log('Ensuring grouped data for matches:', matchIds);
    // logToPage(`Grouping data for ${matchIds.length} matches`);
    matchIds.forEach(id => {
        const idStr = String(id); // Ensure string ID
        if (state.attendanceByMatch[idStr]) return;

        state.attendanceByMatch[idStr] = [];
        state.members.forEach(member => {
            const key = `${idStr}_${member.name}`;
            if (state.attendance[key]) {
                state.attendanceByMatch[idStr].push({
                    memberName: member.name,
                    data: state.attendance[key]
                });
            }
        });
    });
}

function parseDate(input) {
    if (!input) return new Date();
    if (input instanceof Date) {
        return isNaN(input.getTime()) ? new Date() : new Date(input.getTime());
    }
    if (typeof input === 'number') return new Date(input);
    const str = String(input).trim();

    if (str.includes('T') || str.includes('Z')) {
        const d = new Date(str);
        if (!isNaN(d.getTime())) return d;
    }

    let d;
    const matchFull = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (matchFull) {
        d = new Date(parseInt(matchFull[1], 10), parseInt(matchFull[2], 10) - 1, parseInt(matchFull[3], 10));
    } else {
        const matchMonth = str.match(/^(\d{4})[-/](\d{1,2})$/);
        if (matchMonth) {
            d = new Date(parseInt(matchMonth[1], 10), parseInt(matchMonth[2], 10) - 1, 1);
        } else {
            d = new Date(str.replace(/-/g, '/'));
        }
    }

    if (isNaN(d.getTime())) {
        console.warn('parseDate failed for:', input);
        return new Date();
    }
    return d;
}

function normalizeToYYYYMM(dateInput) {
    if (!dateInput) return "";
    const dStr = String(dateInput);

    // Check for ISO string with time indicating potential TZ shift need (e.g., from GAS)
    // GAS often returns ISO strings in UTC. We need JST (UTC+9).
    if (dStr.includes('T') && dStr.endsWith('Z')) {
        try {
            const d = new Date(dateInput);
            if (!isNaN(d.getTime())) {
                // Shift to JST (UTC+9)
                const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
                const y = jst.getUTCFullYear();
                const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
                return `${y}-${m}`;
            }
        } catch (e) { console.error('Date parse error', e); }
    }

    // Handle YYYY-MM-DD... or YYYY/MM/DD... or YYYY-M-D (Plain strings)
    const match = dStr.match(/^(\d{4})[-/](\d{1,2})/);
    if (match) {
        const year = match[1];
        const month = match[2].padStart(2, '0');
        return `${year}-${month}`;
    }

    // Fallback: try new Date()
    try {
        const d = new Date(dateInput);
        if (isNaN(d.getTime())) return "";
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        return `${y}-${m}`;
    } catch (e) {
        return "";
    }
}

function setupLeagueSelect() {
    const leagueSelect = document.getElementById('year-select');
    if (!leagueSelect) return;

    if (!state.leagues || state.leagues.length === 0) {
        leagueSelect.innerHTML = '<option value="">リーグが登録されていません</option>';
        state.selectedLeague = null;
        return;
    }

    // Sort leagues by start date descending (newest first)
    const sortedLeagues = [...state.leagues].sort((a, b) => {
        const da = parseDate(a.start);
        const db = parseDate(b.start);
        return db - da; // Descending
    });

    leagueSelect.innerHTML = sortedLeagues.map(l => `<option value="${l.id}">${l.name}</option>`).join('');

    const currentId = state.selectedLeague ? state.selectedLeague.id : null;
    let selectedLeague = null;

    if (currentId && sortedLeagues.find(l => String(l.id) === String(currentId))) {
        selectedLeague = sortedLeagues.find(l => String(l.id) === String(currentId));
    } else {
        const today = new Date();

        // Logic A: Active League (Today inside Start ~ End) and has matches
        const activeLeague = sortedLeagues.find(l => {
            const s = parseDate(l.start);
            s.setHours(0, 0, 0, 0);

            let e = parseDate(l.end);
            if (l.end && String(l.end).match(/^\d{4}[-/]\d{1,2}$/)) {
                const d = parseDate(l.end);
                e = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
            } else {
                e.setHours(23, 59, 59, 999);
            }

            const isWithin = today >= s && today <= e;

            const hasMatches = state.matches && state.matches.some(m => {
                if (m.leagueId && String(m.leagueId) === String(l.id)) return true;
                const d = parseDate(m.date);
                return d >= s && d <= e;
            });

            return isWithin && hasMatches;
        });

        if (activeLeague) {
            selectedLeague = activeLeague;
        } else {
            // Logic B: Fallback to Latest Match's League
            const latestMatch = state.matches && [...state.matches].sort((a, b) => parseDate(b.date) - parseDate(a.date))[0];
            if (latestMatch) {
                if (latestMatch.leagueId) {
                    selectedLeague = sortedLeagues.find(l => String(l.id) === String(latestMatch.leagueId)) || null;
                }
                if (!selectedLeague) {
                    const matchDate = parseDate(latestMatch.date);
                    selectedLeague = sortedLeagues.find(l => {
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
                }
            }
        }

        // Logic C: Fallback to latest league in sorted array
        if (!selectedLeague) {
            selectedLeague = sortedLeagues[0];
        }
    }

    state.selectedLeague = selectedLeague;
    leagueSelect.value = selectedLeague ? String(selectedLeague.id) : '';
}

function setupYearSelectListener() {
    const leagueSelect = document.getElementById('year-select');
    if (!leagueSelect) return;
    leagueSelect.addEventListener('change', (e) => {
        const leagueId = e.target.value;
        state.selectedLeague = state.leagues.find(l => l.id === leagueId);
        renderRankings();
    });
}

function setupLocationToggle() {
    document.querySelectorAll('.toggle-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const targetBtn = e.target.closest('.toggle-btn');
            if (!targetBtn) return;
            document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
            targetBtn.classList.add('active');
            state.selectedLocation = targetBtn.dataset.location;
            renderRankings();
        });
    });
}

function renderRankings() {
    console.time('renderRankings');
    const grid = document.getElementById('rankings-grid');
    if (!grid) return;

    if (state.selectedLocation === 'home') {
        grid.innerHTML = `
            <div id="janken-confirmed-ranking" class="ranking-card">
                <div class="ranking-header">
                    <h3>じゃんけん大会参加者</h3>
                    <span class="ranking-sub-title">（参加回数の多い順）</span>
                </div>
                <div class="ranking-body">集計中...</div>
            </div>
            <div id="janken-candidate-ranking" class="ranking-card">
                <div class="ranking-header">
                    <h3>じゃんけん大会立候補者</h3>
                    <span class="ranking-sub-title">（立候補回数の多い順）</span>
                </div>
                <div class="ranking-body">集計中...</div>
            </div>
            <div id="morning-withdraw-ranking" class="ranking-card">
                <div class="ranking-header">
                    <h3>朝の引き込み</h3>
                    <span class="ranking-sub-title">（参加回数の多い順）</span>
                </div>
                <div class="ranking-body">集計中...</div>
            </div>
            <div id="big-flag-ranking" class="ranking-card">
                <div class="ranking-header">
                    <h3>ビッグフラッグ搬入手伝い</h3>
                    <span class="ranking-sub-title">（参加回数の多い順）</span>
                </div>
                <div class="ranking-body">集計中...</div>
            </div>
        `;
        renderHomeRankings();
    } else {
        grid.innerHTML = `
            <div id="queue-start-ranking" class="ranking-card">
                <div class="ranking-header">
                    <h3>並び開始（シート貼り）</h3>
                    <span class="ranking-sub-title">（参加回数の多い順）</span>
                </div>
                <div class="ranking-body">集計中...</div>
            </div>
            <div id="line-org-ranking" class="ranking-card">
                <div class="ranking-header">
                    <h3>列整理</h3>
                    <span class="ranking-sub-title">（参加回数の多い順）</span>
                </div>
                <div class="ranking-body">集計中...</div>
            </div>
        `;
        renderAwayRankings();
    }
    console.timeEnd('renderRankings');
}

function renderHomeRankings() {
    if (!state.selectedLeague) {
        clearRankings();
        return;
    }

    const { start, end } = state.selectedLeague;
    const normalizedStart = normalizeToYYYYMM(start);
    const normalizedEnd = normalizeToYYYYMM(end);

    console.log(`Filtering for Home: ${normalizedStart} to ${normalizedEnd}`);

    if (state.matches.length > 0) {
        const sample = state.matches[0];
        const norm = normalizeToYYYYMM(sample.date);
        console.log(`Sample Match: Raw=${sample.date} -> Norm=${norm}, Loc=${sample.location}`);
    }

    const leagueMatches = state.matches.filter(m => {
        const mMonth = normalizeToYYYYMM(m.date);
        const isMatchInLeague = mMonth >= normalizedStart && mMonth <= normalizedEnd;

        const loc = String(m.location || 'home').trim().toLowerCase();
        const isHome = loc === 'home';

        return isMatchInLeague && isHome;
    });

    console.log('Found Home Matches:', leagueMatches.length);

    const jConf = {};
    leagueMatches.forEach(m => {
        if (m.jankenConfirmed) {
            String(m.jankenConfirmed).split(',').map(s => s.trim()).filter(s => s).forEach(n => {
                jConf[n] = (jConf[n] || 0) + 1;
            });
        }
    });
    renderRankingCard('janken-confirmed-ranking', jConf);

    const jCand = {};
    const mWit = {};
    const bFlag = {};

    ensureGroupedData(leagueMatches.map(m => m.id));

    leagueMatches.forEach(match => {
        (state.attendanceByMatch[match.id] || []).forEach(rec => {
            const d = rec.data;
            if (d.jankenParticipate) jCand[rec.memberName] = (jCand[rec.memberName] || 0) + 1;
            if (d.morningWithdraw) mWit[rec.memberName] = (mWit[rec.memberName] || 0) + 1;
            if (d.bigFlag) bFlag[rec.memberName] = (bFlag[rec.memberName] || 0) + 1;
        });
    });

    renderRankingCard('janken-candidate-ranking', jCand);
    renderRankingCard('morning-withdraw-ranking', mWit);
    renderRankingCard('big-flag-ranking', bFlag);
}

function renderAwayRankings() {
    if (!state.selectedLeague) {
        clearRankings();
        return;
    }

    const { start, end } = state.selectedLeague;
    const normalizedStart = normalizeToYYYYMM(start);
    const normalizedEnd = normalizeToYYYYMM(end);

    console.log(`Filtering for Away: ${normalizedStart} to ${normalizedEnd}`);

    const leagueMatches = state.matches.filter(m => {
        const mMonth = normalizeToYYYYMM(m.date);
        const isMatchInLeague = mMonth >= normalizedStart && mMonth <= normalizedEnd;

        const loc = String(m.location || '').trim().toLowerCase();
        return isMatchInLeague && loc === 'away';
    });

    console.log('Found Away Matches:', leagueMatches.length);

    const qStart = {};
    const lOrg = {};

    ensureGroupedData(leagueMatches.map(m => m.id));

    leagueMatches.forEach(match => {
        (state.attendanceByMatch[match.id] || []).forEach(rec => {
            const d = rec.data;
            if (d.status === 6) qStart[rec.memberName] = (qStart[rec.memberName] || 0) + 1;
            if (d.status === 7) lOrg[rec.memberName] = (lOrg[rec.memberName] || 0) + 1;
        });
    });

    renderRankingCard('queue-start-ranking', qStart);
    renderRankingCard('line-org-ranking', lOrg);
}

function clearRankings() {
    document.querySelectorAll('.ranking-body').forEach(c => {
        c.innerHTML = '<div class="no-data">リーグを選択してください</div>';
    });
}

function renderRankingCard(id, counts) {
    const card = document.getElementById(id);
    if (!card) return;
    const container = card.querySelector('.ranking-body');
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);

    if (sorted.length === 0) {
        container.innerHTML = '<div class="no-data">データがありません</div>';
        return;
    }

    let currentRank = 1;
    let prevCount = null;

    container.innerHTML = sorted.map(([name, count], index) => {
        if (prevCount !== null && count < prevCount) {
            currentRank = index + 1;
        }
        prevCount = count;

        let rankClass = '';
        if (currentRank === 1) rankClass = 'rank-gold';
        else if (currentRank === 2) rankClass = 'rank-silver';
        else if (currentRank === 3) rankClass = 'rank-bronze';

        return `
            <div class="ranking-item">
                <div class="rank-badge ${rankClass}">${currentRank}</div>
                <div class="rank-name">${name}</div>
                <div class="rank-count">${count}回</div>
            </div>
        `;
    }).join('');
}

function showLoading(show) {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.style.display = show ? 'flex' : 'none';
}

// Kick off
init();
