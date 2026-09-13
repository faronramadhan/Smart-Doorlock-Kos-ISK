/* ===== KONEKSI FIREBASE ===== */
const firebaseConfig = {
  apiKey: "AIzaSyDQbNT5P1naNasch6GHjBXPrP5assqJ3Yo",
  authDomain: "isk-house.firebaseapp.com",
  databaseURL: "https://isk-house-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "isk-house",
  storageBucket: "isk-house.firebasestorage.app",
  messagingSenderId: "519460203814",
  appId: "1:519460203814:web:b057f2af72b53a6fc065e7"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.database();

const MAX_ROOMS = 20;
const MAX_HISTORY_PER_ROOM = 1000; // riwayat disimpan maks 1000 terakhir per kamar
const AUTO_LOCK_SECONDS = 5;       // ganti angka ini untuk atur durasi pintu terbuka

// Firebase Auth butuh format email, jadi username tanpa "@" diubah jadi email sintetis dengan domain ini
const AUTH_EMAIL_DOMAIN = 'isk-house.local';

let locationsData = {};
let currentLoc = null;
let currentGw = null;
let editingRoomNumber = null;
let currentUserEmail = '';
let currentUserRole = '';
let currentUserLabel = '';
let userRecordRef = null;      // listener realtime ke users/{uid} milik user yang sedang login
let pendingUsersRef = null;    // listener realtime ke daftar pendaftar yang menunggu persetujuan (khusus admin)
let autoLockTimers = {}; // menyimpan setTimeout aktif per kamar

/* Username tanpa "@" (misal "AdminISK-House") diubah jadi email sintetis untuk Firebase Auth */
function toAuthEmail(raw) {
    const value = raw.trim();
    return value.includes('@') ? value.toLowerCase() : `${value.toLowerCase()}@${AUTH_EMAIL_DOMAIN}`;
}

/* Nomor urut "User-1", "User-2", dst — dipakai sebagai label tampilan, bukan sebagai key database */
function nextUserLabel() {
    return db.ref('meta/userCounter').transaction(current => (current || 0) + 1)
        .then(result => `User-${result.snapshot.val()}`);
}

/* ===== ELEMEN: AUTH ===== */
const authView = document.getElementById('authView');
const verifyView = document.getElementById('verifyView');
const pendingView = document.getElementById('pendingView');
const appView = document.getElementById('appView');
const authForm = document.getElementById('authForm');
const authEmail = document.getElementById('authEmail');
const authPassword = document.getElementById('authPassword');
const authError = document.getElementById('authError');
const authSubmit = document.getElementById('authSubmit');
const authTabs = document.querySelectorAll('.auth-tab');
const userEmailEl = document.getElementById('userEmail');
const logoutBtn = document.getElementById('logoutBtn');

const verifyEmailLabel = document.getElementById('verifyEmailLabel');
const verifyError = document.getElementById('verifyError');
const verifyCheckBtn = document.getElementById('verifyCheckBtn');
const verifyResendBtn = document.getElementById('verifyResendBtn');
const verifyLogoutBtn = document.getElementById('verifyLogoutBtn');

const pendingTitle = document.getElementById('pendingTitle');
const pendingMessage = document.getElementById('pendingMessage');
const pendingLogoutBtn = document.getElementById('pendingLogoutBtn');

let authMode = 'login';

authTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        authTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        authMode = tab.dataset.mode;
        authSubmit.textContent = authMode === 'login' ? 'Masuk' : 'Daftar';
        authError.textContent = '';
    });
});

authForm.addEventListener('submit', (e) => {
    e.preventDefault();
    authError.textContent = '';
    const email = toAuthEmail(authEmail.value);
    const password = authPassword.value;

    if (authMode === 'login') {
        auth.signInWithEmailAndPassword(email, password)
            .catch(err => { authError.textContent = terjemahkanErrorFirebase(err.code); });
    } else {
        auth.createUserWithEmailAndPassword(email, password)
            .then(cred => {
                return nextUserLabel().then(label => {
                    db.ref(`users/${cred.user.uid}`).set({
                        email: email,
                        label: label,
                        role: 'user',
                        status: 'pending',
                        createdAt: Date.now()
                    });
                    return cred.user.sendEmailVerification();
                });
            })
            .catch(err => { authError.textContent = terjemahkanErrorFirebase(err.code); });
    }
});

logoutBtn.addEventListener('click', () => auth.signOut());
pendingLogoutBtn.addEventListener('click', () => auth.signOut());

/* ===== VERIFIKASI EMAIL ===== */
verifyCheckBtn.addEventListener('click', () => {
    verifyError.textContent = '';
    const user = auth.currentUser;
    if (!user) return;

    user.reload().then(() => {
        if (user.emailVerified) {
            db.ref(`users/${user.uid}`).once('value').then(snap => handleUserRecord(user, snap.val()));
        } else {
            verifyError.textContent = 'Email belum diverifikasi. Cek inbox/folder spam Anda.';
        }
    });
});

verifyResendBtn.addEventListener('click', () => {
    verifyError.textContent = '';
    const user = auth.currentUser;
    if (!user) return;

    verifyResendBtn.disabled = true;
    user.sendEmailVerification()
        .then(() => { verifyError.textContent = 'Email verifikasi terkirim ulang.'; })
        .catch(err => { verifyError.textContent = terjemahkanErrorFirebase(err.code); })
        .finally(() => { verifyResendBtn.disabled = false; });
});

verifyLogoutBtn.addEventListener('click', () => auth.signOut());

function terjemahkanErrorFirebase(code) {
    const map = {
        'auth/email-already-in-use': 'Email sudah terdaftar di Firebase Authentication. Jika ini akun test yang sudah dihapus dari Realtime Database, akun Auth-nya belum ikut terhapus — hapus juga dari Firebase Console > Authentication > Users.',
        'auth/invalid-email': 'Format email tidak valid.',
        'auth/weak-password': 'Kata sandi minimal 6 karakter.',
        'auth/user-not-found': 'Email belum terdaftar.',
        'auth/wrong-password': 'Kata sandi salah.',
        'auth/invalid-credential': 'Email atau kata sandi salah.'
    };
    return map[code] || 'Terjadi kesalahan, coba lagi.';
}

/* ===== AUTH STATE ===== */
function showAppView(user, record) {
    currentUserEmail = user.email;
    currentUserRole = record.role || 'user';
    currentUserLabel = record.label || (currentUserRole === 'admin' ? 'Admin' : user.email);
    userEmailEl.textContent = user.email;
    authView.style.display = 'none';
    verifyView.style.display = 'none';
    pendingView.style.display = 'none';
    appView.classList.add('visible');
    initAppData();
    renderApprovalPanel();
}

function showVerifyView(user) {
    currentUserEmail = '';
    currentUserRole = '';
    authView.style.display = 'none';
    appView.classList.remove('visible');
    pendingView.style.display = 'none';
    verifyView.style.display = 'flex';
    verifyEmailLabel.textContent = user.email;
}

/* state: 'pending' (menunggu persetujuan) atau 'rejected' (ditolak admin) */
function showPendingView(state) {
    currentUserEmail = '';
    currentUserRole = '';
    authView.style.display = 'none';
    verifyView.style.display = 'none';
    appView.classList.remove('visible');
    detachApprovalPanel();

    if (state === 'rejected') {
        pendingTitle.textContent = 'Pendaftaran Ditolak';
        pendingMessage.textContent = 'Maaf, pendaftaran akun Anda ditolak oleh admin. Hubungi admin ISK House jika ini keliru.';
    } else {
        pendingTitle.textContent = 'Menunggu Persetujuan Admin';
        pendingMessage.textContent = 'Akun Anda sudah terverifikasi dan sedang menunggu persetujuan admin ISK House sebelum bisa mengakses dashboard. Halaman ini akan otomatis terbuka begitu disetujui.';
    }
    pendingView.style.display = 'flex';
}

/* Dipanggil tiap kali data users/{uid} berubah (baik saat login maupun saat admin menyetujui/menolak) */
function handleUserRecord(user, record) {
    if (record && record.role === 'admin') {
        showAppView(user, record);
        return;
    }
    if (!user.emailVerified) {
        showVerifyView(user);
        return;
    }
    if (record && record.status === 'approved') {
        showAppView(user, record);
        return;
    }
    if (record && record.status === 'rejected') {
        showPendingView('rejected');
        return;
    }
    if (!record) {
        // Akun lama (dibuat sebelum fitur ini ada) atau data belum sempat dibuat saat daftar
        nextUserLabel().then(label => {
            db.ref(`users/${user.uid}`).set({ email: user.email, label: label, role: 'user', status: 'pending', createdAt: Date.now() });
        });
        return; // listener akan terpanggil lagi otomatis setelah data tersimpan
    }
    showPendingView('pending');
}

function attachUserRecordListener(user) {
    detachUserRecordListener();
    userRecordRef = db.ref(`users/${user.uid}`);
    userRecordRef.on('value',
        (snap) => handleUserRecord(user, snap.val()),
        (err) => console.error('Gagal membaca data users/{uid}. Cek Realtime Database Rules.', err)
    );
}

function detachUserRecordListener() {
    if (userRecordRef) { userRecordRef.off(); userRecordRef = null; }
}

auth.onAuthStateChanged(user => {
    if (user) {
        attachUserRecordListener(user);
    } else {
        detachUserRecordListener();
        detachApprovalPanel();
        currentUserEmail = '';
        currentUserRole = '';
        verifyView.style.display = 'none';
        pendingView.style.display = 'none';
        appView.classList.remove('visible');
        authView.style.display = 'flex';
    }
});

/* ===== PANEL PERSETUJUAN PENDAFTAR (khusus admin) ===== */
const approvalBlock = document.getElementById('approvalBlock');
const pendingUsersList = document.getElementById('pendingUsersList');
const pendingCountEl = document.getElementById('pendingCount');

function renderApprovalPanel() {
    if (currentUserRole !== 'admin') {
        detachApprovalPanel();
        return;
    }
    approvalBlock.style.display = 'block';
    if (pendingUsersRef) return; // listener sudah aktif

    pendingUsersRef = db.ref('users').orderByChild('status').equalTo('pending');
    pendingUsersRef.on('value', (snapshot) => {
        const entries = [];
        snapshot.forEach(child => { entries.push({ uid: child.key, ...child.val() }); return false; });
        entries.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

        pendingCountEl.textContent = entries.length;

        if (entries.length === 0) {
            pendingUsersList.innerHTML = `<p class="pending-empty">Tidak ada pendaftar yang menunggu persetujuan.</p>`;
            return;
        }

        pendingUsersList.innerHTML = entries.map(u => {
            const date = u.createdAt ? new Date(u.createdAt).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) : '';
            return `
                <div class="pending-user-item">
                    <div class="pu-info">
                        <div class="pu-email">${u.label ? `${u.label} — ${u.email}` : u.email}</div>
                        <div class="pu-date">Daftar ${date}</div>
                    </div>
                    <div class="pu-actions">
                        <button class="icon-btn" data-action="approve-user" data-uid="${u.uid}">Setujui</button>
                        <button class="icon-btn danger" data-action="reject-user" data-uid="${u.uid}">Tolak</button>
                    </div>
                </div>
            `;
        }).join('');

        pendingUsersList.querySelectorAll('[data-action]').forEach(btn => {
            const uid = btn.dataset.uid;
            btn.addEventListener('click', () => {
                const newStatus = btn.dataset.action === 'approve-user' ? 'approved' : 'rejected';
                db.ref(`users/${uid}`).update({ status: newStatus });
            });
        });
    }, (err) => {
        console.error('Gagal membaca daftar pendaftar (users). Cek Realtime Database Rules & index "status".', err);
        pendingUsersList.innerHTML = `<p class="pending-empty">Gagal memuat daftar pendaftar (izin database ditolak). Cek Rules di Firebase Console.</p>`;
    });
}

function detachApprovalPanel() {
    if (pendingUsersRef) { pendingUsersRef.off(); pendingUsersRef = null; }
    if (approvalBlock) approvalBlock.style.display = 'none';
}

/* ===== ELEMEN: APP ===== */
const locationSelect = document.getElementById('locationSelect');
const locationAddress = document.getElementById('locationAddress');
const addLocationBtn = document.getElementById('addLocationBtn');
const deleteLocationBtn = document.getElementById('deleteLocationBtn');
const gatewayTabs = document.getElementById('gatewayTabs');
const addGatewayBtn = document.getElementById('addGatewayBtn');
const gatewaySummary = document.getElementById('gatewaySummary');
const roomList = document.getElementById('roomList');
const roomCount = document.getElementById('roomCount');
const addRoomBtn = document.getElementById('addRoomBtn');
const historyTableBody = document.querySelector('#historyTable tbody');

const modalOverlay = document.getElementById('modalOverlay');
const modalTitle = document.getElementById('modalTitle');
const roomNumberInput = document.getElementById('roomNumberInput');
const tenantNameInput = document.getElementById('tenantNameInput');
const rfidInput = document.getElementById('rfidInput');

const locModalOverlay = document.getElementById('locModalOverlay');
const locNameInput = document.getElementById('locNameInput');
const locAddressInput = document.getElementById('locAddressInput');

const gwModalOverlay = document.getElementById('gwModalOverlay');
const gwNameInput = document.getElementById('gwNameInput');

let dataListenerAttached = false;

function initAppData() {
    if (dataListenerAttached) return;
    dataListenerAttached = true;

    seedIfEmpty();

    db.ref('locations').on('value', (snapshot) => {
        locationsData = snapshot.val() || {};

        if (!currentLoc || !locationsData[currentLoc]) {
            currentLoc = Object.keys(locationsData)[0] || null;
        }
        if (currentLoc) {
            const gateways = locationsData[currentLoc].gateways || {};
            if (!currentGw || !gateways[currentGw]) {
                currentGw = Object.keys(gateways)[0] || null;
            }
        }

        ensureAutoLockTimers();
        renderLocations();
        renderGatewayTabs();
        renderAll();
    });

    // Perbarui hitung mundur tombol tiap 1 detik selama ada kamar yang sedang terbuka
    setInterval(() => {
        const rooms = getRoomsArray();
        if (rooms.some(r => r.status === 'unlocked')) {
            renderRooms();
        }
    }, 1000);
}

/* ===== SEED DATA AWAL ===== */
function seedIfEmpty() {
    db.ref('locations').once('value', (snapshot) => {
        if (snapshot.exists()) return;

        db.ref('locations').set({
            loc1: {
                name: "ISK House Kemanggisan",
                address: "Jl. Kemanggisan Raya, Jakarta Barat",
                gateways: {
                    gw1: { name: "Lantai 1", rooms: {
                        1: { tenant: "Budi Santoso", rfidAccess: true, status: "locked" },
                        3: { tenant: "Rian Pratama", rfidAccess: false, status: "locked" },
                        5: { tenant: "", rfidAccess: true, status: "locked" }
                    }}
                }
            }
        });
    });
}

/* ===== AUTO-LOCK: pastikan setiap kamar yang sedang terbuka punya timer aktif ===== */
/* Ini juga menangani kasus refresh browser di tengah hitung mundur */
function ensureAutoLockTimers() {
    Object.entries(locationsData).forEach(([locId, loc]) => {
        Object.entries(loc.gateways || {}).forEach(([gwId, gw]) => {
            Object.entries(gw.rooms || {}).forEach(([roomNum, room]) => {
                const timerKey = `${locId}_${gwId}_${roomNum}`;

                if (room.status === 'unlocked' && !autoLockTimers[timerKey]) {
                    const elapsed = Date.now() - (room.unlockedAt || Date.now());
                    const remainingMs = AUTO_LOCK_SECONDS * 1000 - elapsed;
                    const path = `locations/${locId}/gateways/${gwId}/rooms/${roomNum}`;

                    if (remainingMs <= 0) {
                        db.ref(path).update({ status: 'locked', unlockedAt: null });
                        logHistory(locId, gwId, parseInt(roomNum), 'lock', 'Sistem (Auto-kunci)');
                    } else {
                        autoLockTimers[timerKey] = setTimeout(() => {
                            db.ref(path).update({ status: 'locked', unlockedAt: null });
                            logHistory(locId, gwId, parseInt(roomNum), 'lock', 'Sistem (Auto-kunci)');
                            delete autoLockTimers[timerKey];
                        }, remainingMs);
                    }
                }

                if (room.status === 'locked' && autoLockTimers[timerKey]) {
                    clearTimeout(autoLockTimers[timerKey]);
                    delete autoLockTimers[timerKey];
                }
            });
        });
    });
}

/* ===== RENDER: Lokasi ===== */
function renderLocations() {
    locationSelect.innerHTML = Object.entries(locationsData)
        .map(([id, loc]) => `<option value="${id}">${loc.name}</option>`).join('');
    if (currentLoc) {
        locationSelect.value = currentLoc;
        locationAddress.textContent = locationsData[currentLoc]?.address || '';
    } else {
        locationAddress.textContent = '';
    }
}

locationSelect.addEventListener('change', () => {
    currentLoc = locationSelect.value;
    locationAddress.textContent = locationsData[currentLoc]?.address || '';
    const gateways = locationsData[currentLoc].gateways || {};
    currentGw = Object.keys(gateways)[0] || null;
    renderGatewayTabs();
    renderAll();
});

/* ===== MODAL: Tambah Lokasi ===== */
addLocationBtn.addEventListener('click', () => {
    locNameInput.value = '';
    locAddressInput.value = '';
    locModalOverlay.classList.add('open');
});
document.getElementById('locModalCancel').addEventListener('click', () => locModalOverlay.classList.remove('open'));
locModalOverlay.addEventListener('click', (e) => { if (e.target === locModalOverlay) locModalOverlay.classList.remove('open'); });

/* Bikin key Firebase yang enak dibaca dari Nama + Alamat, mis. "ISK House - Kemayoran" */
function generateLocationKey(name, address) {
    let base = address ? `${name} - ${address}` : name;
    base = base.replace(/[.#$\[\]/]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!base) base = 'Kos';

    let key = base;
    let i = 2;
    while (locationsData[key]) {
        key = `${base} (${i})`;
        i++;
    }
    return key;
}

document.getElementById('locModalSave').addEventListener('click', () => {
    const name = locNameInput.value.trim();
    const address = locAddressInput.value.trim();
    if (!name) return;

    const key = generateLocationKey(name, address);
    db.ref(`locations/${key}`).set({ name, address, gateways: {} }).then(() => {
        currentLoc = key;
        currentGw = null;
    });

    locModalOverlay.classList.remove('open');
});

deleteLocationBtn.addEventListener('click', () => {
    if (!currentLoc) return;
    const name = locationsData[currentLoc]?.name || '';
    if (!confirm(`Hapus kos "${name}" beserta semua lantai & kamarnya? Tindakan ini tidak bisa dibatalkan.`)) return;
    db.ref(`locations/${currentLoc}`).remove();
    currentLoc = null;
    currentGw = null;
});

/* ===== RENDER: Tab Gateway/Lantai ===== */
function renderGatewayTabs() {
    if (!currentLoc) { gatewayTabs.innerHTML = ''; return; }
    const gateways = locationsData[currentLoc].gateways || {};
    gatewayTabs.innerHTML = Object.entries(gateways).map(([id, gw]) => `
        <button class="gateway-tab ${id === currentGw ? 'active' : ''}" data-gw="${id}">${gw.name}</button>
    `).join('');

    gatewayTabs.querySelectorAll('.gateway-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            currentGw = btn.dataset.gw;
            renderAll();
        });
    });
}

/* ===== MODAL: Tambah Gateway/Lantai ===== */
addGatewayBtn.addEventListener('click', () => {
    if (!currentLoc) { alert('Tambahkan lokasi kos dulu.'); return; }
    gwNameInput.value = '';
    gwModalOverlay.classList.add('open');
});
document.getElementById('gwModalCancel').addEventListener('click', () => gwModalOverlay.classList.remove('open'));
gwModalOverlay.addEventListener('click', (e) => { if (e.target === gwModalOverlay) gwModalOverlay.classList.remove('open'); });

/* Key gateway dibuat "Gateway 1", "Gateway 2", dst secara berurutan per lokasi (bukan push key acak) */
function generateGatewayKey(locId) {
    const gateways = locationsData[locId]?.gateways || {};
    let n = Object.keys(gateways).length + 1;
    let key = `Gateway ${n}`;
    while (gateways[key]) {
        n++;
        key = `Gateway ${n}`;
    }
    return key;
}

document.getElementById('gwModalSave').addEventListener('click', () => {
    const name = gwNameInput.value.trim();
    if (!name || !currentLoc) return;

    const key = generateGatewayKey(currentLoc);
    db.ref(`locations/${currentLoc}/gateways/${key}`).set({ name, rooms: {} }).then(() => { currentGw = key; });

    gwModalOverlay.classList.remove('open');
});

/* ===== Helper: ambil array kamar ===== */
function getRoomsArray() {
    if (!currentLoc || !currentGw) return [];
    const rooms = locationsData[currentLoc]?.gateways?.[currentGw]?.rooms || {};
    return Object.entries(rooms)
        .map(([number, data]) => ({ number: parseInt(number), ...data }))
        .sort((a, b) => a.number - b.number);
}

/* ===== RENDER: Ringkasan Gateway ===== */
function renderSummary() {
    if (!currentLoc || !currentGw) { gatewaySummary.innerHTML = ''; return; }
    const rooms = getRoomsArray();
    const lockedCount = rooms.filter(r => r.status === 'locked').length;
    const unlockedCount = rooms.filter(r => r.status === 'unlocked').length;
    const rfidBlockedCount = rooms.filter(r => !r.rfidAccess).length;

    gatewaySummary.innerHTML = `
        <div>
            <div class="gs-title">${locationsData[currentLoc].gateways[currentGw].name}</div>
            <div class="gs-sub">${rooms.length}/${MAX_ROOMS} kamar terpasang</div>
        </div>
        <div class="gs-stats">
            <div class="gs-stat"><div class="gs-stat-num safe">${lockedCount}</div><div class="gs-stat-label">Terkunci</div></div>
            <div class="gs-stat"><div class="gs-stat-num alert">${unlockedCount}</div><div class="gs-stat-label">Terbuka</div></div>
            <div class="gs-stat"><div class="gs-stat-num alert">${rfidBlockedCount}</div><div class="gs-stat-label">RFID Blokir</div></div>
        </div>
    `;
}

/* ===== RENDER: Daftar Kamar ===== */
function renderRooms() {
    const rooms = getRoomsArray();
    roomCount.textContent = `${rooms.length}/${MAX_ROOMS}`;

    if (!currentGw) {
        roomList.innerHTML = `<p style="color:var(--text-muted); font-size:13px;">Pilih atau tambahkan lantai dulu.</p>`;
        addRoomBtn.style.display = 'none';
        return;
    }
    addRoomBtn.style.display = 'block';

    if (rooms.length === 0) {
        roomList.innerHTML = `<p style="color:var(--text-muted); font-size:13px; grid-column:1/-1;">Belum ada kamar ditambahkan</p>`;
    } else {
        roomList.innerHTML = rooms.map(r => {
            let lockBtnLabel = 'Buka';
            let lockBtnDisabled = '';

            if (r.status === 'unlocked') {
                const elapsed = Date.now() - (r.unlockedAt || Date.now());
                const remaining = Math.max(0, Math.ceil((AUTO_LOCK_SECONDS * 1000 - elapsed) / 1000));
                lockBtnLabel = `Menutup (${remaining}s)`;
                lockBtnDisabled = 'disabled';
            }

            return `
            <div class="room-item">
                <div class="room-item-top">
                    <div class="room-number">${String(r.number).padStart(2, '0')}</div>
                    <div class="room-info">
                        <div class="room-tenant ${!r.tenant ? 'empty' : ''}">${r.tenant || 'Kamar kosong'}</div>
                        <div class="room-badges">
                            <span class="badge ${r.status}">${r.status === 'locked' ? 'Terkunci' : 'Terbuka'}</span>
                            <span class="badge ${r.rfidAccess ? 'rfid-on' : 'rfid-off'}">${r.rfidAccess ? 'RFID Aktif' : 'RFID Diblokir'}</span>
                        </div>
                    </div>
                </div>
                <div class="room-actions">
                    <button class="icon-btn" data-action="toggle-lock" data-number="${r.number}" ${lockBtnDisabled}>
                        ${lockBtnLabel}
                    </button>
                    <button class="icon-btn ${r.rfidAccess ? 'warn' : ''}" data-action="toggle-rfid" data-number="${r.number}">
                        ${r.rfidAccess ? 'Blokir RFID' : 'Izinkan RFID'}
                    </button>
                    <button class="icon-btn" data-action="edit" data-number="${r.number}">Edit</button>
                    <button class="icon-btn danger" data-action="delete" data-number="${r.number}">Hapus</button>
                </div>
            </div>
        `;
        }).join('');
    }

    addRoomBtn.disabled = rooms.length >= MAX_ROOMS;
    addRoomBtn.textContent = rooms.length >= MAX_ROOMS ? 'Maksimal 15 kamar tercapai' : '+ Tambah Kamar';

    roomList.querySelectorAll('[data-action]').forEach(btn => {
        const number = parseInt(btn.dataset.number);
        const action = btn.dataset.action;
        btn.addEventListener('click', () => {
            if (action === 'toggle-lock') toggleLock(number);
            if (action === 'toggle-rfid') toggleRfid(number);
            if (action === 'edit') openModal(number);
            if (action === 'delete') deleteRoom(number);
        });
    });
}

/* ===== RENDER: Riwayat (gabungan riwayat semua kamar di lantai ini, terbaru & lama) ===== */
function renderHistory() {
    const rooms = getRoomsArray();
    let allEntries = [];

    rooms.forEach(r => {
        if (r.history) {
            Object.values(r.history).forEach(h => {
                allEntries.push({ ...h, roomNumber: r.number });
            });
        }
    });

    allEntries.sort((a, b) => b.timestamp - a.timestamp);
    allEntries = allEntries.slice(0, 20); // tampilkan maksimal 20 baris terbaru di tabel

    if (!currentGw || allEntries.length === 0) {
        historyTableBody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--text-muted);">Belum ada aktivitas</td></tr>`;
        return;
    }

    const tagMap = {
        unlock: ['tag--unlock', 'Unlock'],
        lock: ['tag--lock', 'Lock'],
        rfid_block: ['tag--rfid', 'RFID Diblokir'],
        rfid_unblock: ['tag--rfid', 'RFID Diizinkan']
    };

    historyTableBody.innerHTML = allEntries.map(h => {
        const date = new Date(h.timestamp);
        const formatted = date.toLocaleDateString('id-ID', { day: '2-digit', month: 'short' }) +
            ', ' + date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const [tagClass, tagLabel] = tagMap[h.action] || ['tag--lock', h.action];
        return `
            <tr>
                <td class="mono">${formatted}</td>
                <td><span class="tag ${tagClass}">${tagLabel}</span></td>
                <td>Kmr ${h.roomNumber}</td>
                <td>${h.by}</td>
            </tr>
        `;
    }).join('');
}

function renderAll() {
    renderSummary();
    renderRooms();
    renderHistory();
}

/* ===== Catat riwayat: disimpan nested di dalam kamar, dibatasi jumlahnya ===== */
function logHistory(loc, gw, roomNumber, action, by) {
    const histRef = db.ref(`locations/${loc}/gateways/${gw}/rooms/${roomNumber}/history`);
    histRef.push({ action, by, timestamp: Date.now() });

    // Trim: hapus entri paling lama kalau sudah melebihi batas
    histRef.orderByChild('timestamp').once('value', (snapshot) => {
        const entries = [];
        snapshot.forEach(child => entries.push({ key: child.key, timestamp: child.val().timestamp }));
        if (entries.length > MAX_HISTORY_PER_ROOM) {
            entries.sort((a, b) => a.timestamp - b.timestamp);
            const excess = entries.length - MAX_HISTORY_PER_ROOM;
            for (let i = 0; i < excess; i++) {
                histRef.child(entries[i].key).remove();
            }
        }
    });
}

/* ===== AKSI: Buka/Kunci Pintu ===== */
function toggleLock(number) {
    const loc = currentLoc, gw = currentGw;
    const path = `locations/${loc}/gateways/${gw}/rooms/${number}`;
    const room = getRoomsArray().find(r => r.number === number);
    const newStatus = room.status === 'locked' ? 'unlocked' : 'locked';
    const timerKey = `${loc}_${gw}_${number}`;

    if (autoLockTimers[timerKey]) {
        clearTimeout(autoLockTimers[timerKey]);
        delete autoLockTimers[timerKey];
    }

    if (newStatus === 'unlocked') {
        db.ref(path).update({ status: 'unlocked', unlockedAt: Date.now() });
        logHistory(loc, gw, number, 'unlock', currentUserLabel || 'Admin');

        autoLockTimers[timerKey] = setTimeout(() => {
            db.ref(path).update({ status: 'locked', unlockedAt: null });
            logHistory(loc, gw, number, 'lock', 'Sistem (Auto-kunci)');
            delete autoLockTimers[timerKey];
        }, AUTO_LOCK_SECONDS * 1000);
    } else {
        db.ref(path).update({ status: 'locked', unlockedAt: null });
        logHistory(loc, gw, number, 'lock', currentUserLabel || 'Admin');
    }

    // TODO: ESP32 Gateway membaca perubahan status di path ini via HTTP polling / listener
}

/* ===== AKSI: Blokir/Izinkan RFID ===== */
function toggleRfid(number) {
    const loc = currentLoc, gw = currentGw;
    const roomRef = db.ref(`locations/${loc}/gateways/${gw}/rooms/${number}`);
    const room = getRoomsArray().find(r => r.number === number);
    const newAccess = !room.rfidAccess;

    roomRef.update({ rfidAccess: newAccess });
    logHistory(loc, gw, number, newAccess ? 'rfid_unblock' : 'rfid_block', currentUserLabel || 'Admin');
    // TODO: ESP32-C3 mengecek field rfidAccess ini sebelum mengizinkan kartu membuka pintu
}

/* ===== AKSI: Hapus Kamar ===== */
function deleteRoom(number) {
    const room = getRoomsArray().find(r => r.number === number);
    if (!confirm(`Hapus Kamar ${number} (${room.tenant || 'kosong'})?`)) return;
    db.ref(`locations/${currentLoc}/gateways/${currentGw}/rooms/${number}`).remove();
}

/* ===== MODAL: Tambah/Edit Kamar ===== */
function openModal(number = null) {
    editingRoomNumber = number;
    const rooms = getRoomsArray();
    const usedNumbers = rooms.map(r => r.number);

    const availableNumbers = [];
    for (let i = 1; i <= MAX_ROOMS; i++) {
        if (!usedNumbers.includes(i) || i === number) availableNumbers.push(i);
    }
    roomNumberInput.innerHTML = availableNumbers.map(n => `<option value="${n}">Kamar ${n}</option>`).join('');

    if (number) {
        const room = rooms.find(r => r.number === number);
        modalTitle.textContent = `Edit Kamar ${number}`;
        roomNumberInput.value = number;
        tenantNameInput.value = room.tenant;
        rfidInput.checked = room.rfidAccess;
    } else {
        modalTitle.textContent = 'Tambah Kamar';
        tenantNameInput.value = '';
        rfidInput.checked = true;
    }

    modalOverlay.classList.add('open');
}

function closeModal() { modalOverlay.classList.remove('open'); editingRoomNumber = null; }

addRoomBtn.addEventListener('click', () => openModal());
document.getElementById('modalCancel').addEventListener('click', closeModal);
modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });

document.getElementById('modalSave').addEventListener('click', () => {
    const newNumber = parseInt(roomNumberInput.value);
    const newTenant = tenantNameInput.value.trim();
    const newRfid = rfidInput.checked;
    const basePath = `locations/${currentLoc}/gateways/${currentGw}/rooms`;

    if (editingRoomNumber) {
        if (editingRoomNumber !== newNumber) db.ref(`${basePath}/${editingRoomNumber}`).remove();
        db.ref(`${basePath}/${newNumber}`).set({
            tenant: newTenant, rfidAccess: newRfid,
            status: getRoomsArray().find(r => r.number === editingRoomNumber)?.status || 'locked'
        });
    } else {
        db.ref(`${basePath}/${newNumber}`).set({ tenant: newTenant, rfidAccess: newRfid, status: 'locked' });
    }

    closeModal();
});