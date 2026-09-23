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
let currentFloor = null;
let currentGw = null;
let editingRoomNumber = null;
let currentUserEmail = '';
let currentUserRole = '';
let currentUserLabel = '';
let userRecordRef = null;      // listener realtime ke users/{uid} milik user yang sedang login
let pendingUsersRef = null;    // listener realtime ke daftar pendaftar yang menunggu persetujuan (khusus admin)
let pendingDevicesRef = null;  // listener realtime ke daftar doorlock yang sudah dipairing tapi belum diklasifikasikan (khusus admin)
let pendingGatewaysRef = null; // listener realtime ke daftar gateway yang sudah terhubung tapi belum diklasifikasikan (khusus admin)
let autoLockTimers = {}; // menyimpan setTimeout aktif per kamar

const MAX_FLOORS = 20; // batas pilihan "Lantai N" di dropdown Tambah Lantai

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
    renderPairingPanel();
    renderGatewayPairingPanel();
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
    detachPairingPanel();
    detachGatewayPairingPanel();

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
        detachPairingPanel();
        detachGatewayPairingPanel();
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

/* ===== PANEL DOORLOCK MENUNGGU KLASIFIKASI (khusus admin) ===== */
/* Diisi Gateway lewat node pendingDevices/{macDoorlock} begitu pairing HMAC berhasil (lihat HMAC.md) */
const pairingBlock = document.getElementById('pairingBlock');
const pairingDevicesList = document.getElementById('pairingDevicesList');
const pairingCountEl = document.getElementById('pairingCount');

function renderPairingPanel() {
    if (currentUserRole !== 'admin') {
        detachPairingPanel();
        return;
    }
    pairingBlock.style.display = 'block';
    if (pendingDevicesRef) return; // listener sudah aktif

    pendingDevicesRef = db.ref('pendingDevices');
    pendingDevicesRef.on('value', (snapshot) => {
        const entries = [];
        snapshot.forEach(child => { entries.push({ mac: child.key, ...child.val() }); return false; });
        entries.sort((a, b) => (a.pairedAt || 0) - (b.pairedAt || 0));

        pairingCountEl.textContent = entries.length;

        if (entries.length === 0) {
            pairingDevicesList.innerHTML = `<p class="pending-empty">Tidak ada doorlock baru yang menunggu klasifikasi.</p>`;
            return;
        }

        pairingDevicesList.innerHTML = entries.map(d => {
            const date = d.pairedAt ? new Date(d.pairedAt).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) + ', ' + new Date(d.pairedAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '';
            return `
                <div class="pending-user-item">
                    <div class="pu-info">
                        <div class="pu-email mono">${d.mac}</div>
                        <div class="pu-date">Gateway ${d.gatewayMac || '-'} · Dipairing ${date}</div>
                    </div>
                    <div class="pu-actions">
                        <button class="icon-btn" data-mac="${d.mac}">Klasifikasikan</button>
                    </div>
                </div>
            `;
        }).join('');

        pairingDevicesList.querySelectorAll('[data-mac]').forEach(btn => {
            btn.addEventListener('click', () => openClassifyModal(btn.dataset.mac));
        });
    }, (err) => {
        console.error('Gagal membaca daftar doorlock pending (pendingDevices). Cek Realtime Database Rules.', err);
        pairingDevicesList.innerHTML = `<p class="pending-empty">Gagal memuat daftar doorlock (izin database ditolak). Cek Rules di Firebase Console.</p>`;
    });
}

function detachPairingPanel() {
    if (pendingDevicesRef) { pendingDevicesRef.off(); pendingDevicesRef = null; }
    if (pairingBlock) pairingBlock.style.display = 'none';
}

/* ===== PANEL GATEWAY MENUNGGU KLASIFIKASI (khusus admin) ===== */
/* Diisi Gateway sendiri lewat node pendingGateways/{macGateway} begitu ia menyala & terhubung ke Firebase
   pertama kali — sebelum punya nama/lokasi/lantai, dan sebelum ada Doorlock manapun yang dipairing ke situ. */
const gwPairingBlock = document.getElementById('gwPairingBlock');
const pairingGatewaysList = document.getElementById('pairingGatewaysList');
const gwPairingCountEl = document.getElementById('gwPairingCount');

function renderGatewayPairingPanel() {
    if (currentUserRole !== 'admin') {
        detachGatewayPairingPanel();
        return;
    }
    gwPairingBlock.style.display = 'block';
    if (pendingGatewaysRef) return; // listener sudah aktif

    pendingGatewaysRef = db.ref('pendingGateways');
    pendingGatewaysRef.on('value', (snapshot) => {
        const entries = [];
        snapshot.forEach(child => { entries.push({ mac: child.key, ...child.val() }); return false; });
        entries.sort((a, b) => (a.pairedAt || 0) - (b.pairedAt || 0));

        gwPairingCountEl.textContent = entries.length;

        if (entries.length === 0) {
            pairingGatewaysList.innerHTML = `<p class="pending-empty">Tidak ada gateway baru yang menunggu klasifikasi.</p>`;
            return;
        }

        pairingGatewaysList.innerHTML = entries.map(g => {
            const date = g.pairedAt ? new Date(g.pairedAt).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) + ', ' + new Date(g.pairedAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '';
            return `
                <div class="pending-user-item">
                    <div class="pu-info">
                        <div class="pu-email mono">${g.mac}</div>
                        <div class="pu-date">Terhubung ${date}</div>
                    </div>
                    <div class="pu-actions">
                        <button class="icon-btn" data-gwmac="${g.mac}">Klasifikasikan</button>
                    </div>
                </div>
            `;
        }).join('');

        pairingGatewaysList.querySelectorAll('[data-gwmac]').forEach(btn => {
            btn.addEventListener('click', () => openClassifyGatewayModal(btn.dataset.gwmac));
        });
    }, (err) => {
        console.error('Gagal membaca daftar gateway pending (pendingGateways). Cek Realtime Database Rules.', err);
        pairingGatewaysList.innerHTML = `<p class="pending-empty">Gagal memuat daftar gateway (izin database ditolak). Cek Rules di Firebase Console.</p>`;
    });
}

function detachGatewayPairingPanel() {
    if (pendingGatewaysRef) { pendingGatewaysRef.off(); pendingGatewaysRef = null; }
    if (gwPairingBlock) gwPairingBlock.style.display = 'none';
}

/* ===== ELEMEN: APP ===== */
const locationSelect = document.getElementById('locationSelect');
const locationAddress = document.getElementById('locationAddress');
const addLocationBtn = document.getElementById('addLocationBtn');
const deleteLocationBtn = document.getElementById('deleteLocationBtn');
const floorTabs = document.getElementById('floorTabs');
const addFloorBtn = document.getElementById('addFloorBtn');
const deleteFloorBtn = document.getElementById('deleteFloorBtn');
const gatewayTabs = document.getElementById('gatewayTabs');
const addGatewayBtn = document.getElementById('addGatewayBtn');
const deleteGatewayBtn = document.getElementById('deleteGatewayBtn');
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
const locModalError = document.getElementById('locModalError');

const floorModalOverlay = document.getElementById('floorModalOverlay');
const floorNameInput = document.getElementById('floorNameInput');
const floorNameMenu = document.getElementById('floorNameMenu');
const floorModalError = document.getElementById('floorModalError');

const gwModalOverlay = document.getElementById('gwModalOverlay');
const gwNameInput = document.getElementById('gwNameInput');
const gwModalError = document.getElementById('gwModalError');

const roomModalError = document.getElementById('roomModalError');

let dataListenerAttached = false;

/* Field metadata milik lokasi (bukan nama lantai) — dipakai untuk memisahkan lantai dari name/address saat iterasi */
const LOCATION_META_FIELDS = ['name', 'address'];

/* Sanitasi teks jadi key Firebase yang aman (key tidak boleh berisi . # $ [ ] /) */
function sanitizeKeyPart(text) {
    return (text || '').replace(/[.#$\[\]/]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

/* Key unik di antara object `existing`, dibuat langsung dari nama yang diketik admin (bukan id auto/counter).
   `reserved` = field metadata di level yang sama yang tidak boleh "ketabrak" nama lantai/gateway. */
function nextAvailableKey(existing, name, reserved, fallback) {
    let base = sanitizeKeyPart(name) || fallback;
    let key = base;
    let i = 2;
    while (existing[key] !== undefined || reserved.includes(key)) {
        key = `${base} (${i})`;
        i++;
    }
    return key;
}

/* Lantai = semua child lokasi selain field metadata name/address */
function getFloors(loc) {
    const result = {};
    Object.entries(loc || {}).forEach(([k, v]) => {
        if (!LOCATION_META_FIELDS.includes(k)) result[k] = v;
    });
    return result;
}

/* Field metadata milik lantai (bukan nama gateway) — "createdAt" cuma placeholder supaya lantai yang masih
   kosong (belum ada gateway) tidak dipangkas Firebase (RTDB tidak bisa menyimpan node tanpa child sama sekali) */
const FLOOR_META_FIELDS = ['createdAt'];

/* Gateway = semua child lantai selain field metadata createdAt */
function getGateways(floor) {
    const result = {};
    Object.entries(floor || {}).forEach(([k, v]) => {
        if (!FLOOR_META_FIELDS.includes(k)) result[k] = v;
    });
    return result;
}

/* Field metadata milik gateway (bukan nama kamar) — gatewayMac dari pairing, createdAt = placeholder yang sama
   seperti di lantai, dipakai supaya gateway yang masih kosong (belum ada kamar) tidak dipangkas Firebase */
const GATEWAY_META_FIELDS = ['gatewayMac', 'createdAt'];

/* Kamar = semua child gateway selain field metadata gatewayMac/createdAt. Disaring juga entri null -
   Firebase kadang merepresentasikan child bernomor sebagai array bercelah (null di slot kosong). */
function getRooms(gw) {
    const result = {};
    Object.entries(gw || {}).forEach(([k, v]) => {
        if (!GATEWAY_META_FIELDS.includes(k) && v != null) result[k] = v;
    });
    return result;
}

/* Key kamar = "Kamar {nomor}" langsung sebagai child gateway (tanpa wrapper "rooms") */
function roomKey(number) {
    return `Kamar ${number}`;
}

function roomNumberFromKey(key) {
    const match = (key || '').match(/\d+/);
    return match ? parseInt(match[0], 10) : NaN;
}

/* Nomor kamar mengikuti angka lantai, mis. "Lantai 2" -> kamar 201-220, "Lantai 3" -> 301-320.
   Kalau nama lantai tidak mengandung angka (mis. "Lantai Dasar"), pakai penomoran polos 1-20. */
function getRoomNumberRange(floorId) {
    const match = (floorId || '').match(/\d+/);
    if (!match) return { start: 1, end: MAX_ROOMS };
    const base = parseInt(match[0], 10) * 100;
    return { start: base + 1, end: base + MAX_ROOMS };
}

function initAppData() {
    if (dataListenerAttached) return;
    dataListenerAttached = true;

    seedIfEmpty();

    db.ref('locations').on('value', (snapshot) => {
        const data = snapshot.val() || {};

        // Skema lama (baik "gateways langsung di lokasi" maupun wrapper "floors/gateways") dimigrasikan
        // otomatis ke skema ringkas locations/{cabang}/{lantai}/{gateway}/Kamar {n}, tanpa kehilangan data.
        const migration = migrateOldSchemaIfNeeded(data);
        if (migration) {
            migration.catch(err => console.error('Migrasi skema lokasi gagal.', err));
            return; // listener ini akan terpanggil lagi otomatis setelah migrasi tersimpan
        }

        const cleanup = stripLegacyCreatedAt(data);
        if (cleanup) {
            cleanup.catch(err => console.error('Bersihkan field createdAt lama gagal.', err));
            return; // listener ini akan terpanggil lagi otomatis setelah pembersihan tersimpan
        }

        const flatten = flattenLegacyRoomsIfNeeded(data);
        if (flatten) {
            flatten.catch(err => console.error('Meratakan wrapper rooms lama gagal.', err));
            return; // listener ini akan terpanggil lagi otomatis setelah perataan tersimpan
        }

        locationsData = data;

        if (!currentLoc || !locationsData[currentLoc]) {
            currentLoc = Object.keys(locationsData)[0] || null;
        }
        if (currentLoc) {
            const floors = getFloors(locationsData[currentLoc]);
            if (!currentFloor || !floors[currentFloor]) {
                currentFloor = Object.keys(floors)[0] || null;
            }
        } else {
            currentFloor = null;
        }
        if (currentFloor) {
            const gateways = getGateways(locationsData[currentLoc][currentFloor]);
            if (!currentGw || !gateways[currentGw]) {
                currentGw = Object.keys(gateways)[0] || null;
            }
        } else {
            currentGw = null;
        }

        ensureAutoLockTimers();
        renderLocations();
        renderFloorTabs();
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

/* ===== MIGRASI: skema lama -> skema ringkas locations/{cabang}/{lantai}/{gateway}/Kamar {n} ===== */
/* Menangani 2 skema lama: (1) gateways langsung di lokasi (tiap entrinya sebenarnya 1 lantai),
   (2) wrapper floors/{..}/gateways/{..}. Return Promise kalau ada yang dimigrasikan, null kalau tidak. */
function migrateOldSchemaIfNeeded(data) {
    const updates = {};
    let needsMigration = false;

    Object.entries(data).forEach(([locId, loc]) => {
        if (!loc) return;

        if (loc.gateways) {
            needsMigration = true;
            const usedFloorKeys = {};
            Object.values(loc.gateways).forEach(oldGw => {
                const floorKey = nextAvailableKey(usedFloorKeys, (oldGw && oldGw.name) || 'Lantai 1', LOCATION_META_FIELDS, 'Lantai');
                usedFloorKeys[floorKey] = true;
                const oldRooms = (oldGw && oldGw.rooms) || {};
                Object.entries(oldRooms).forEach(([roomNum, roomData]) => {
                    if (roomData == null) return;
                    updates[`locations/${locId}/${floorKey}/Gateway 1/${roomKey(roomNum)}`] = roomData;
                });
            });
            updates[`locations/${locId}/gateways`] = null;
        } else if (loc.floors) {
            needsMigration = true;
            const usedFloorKeys = {};
            Object.entries(loc.floors).forEach(([floorKey, floorObj]) => {
                const newFloorKey = nextAvailableKey(usedFloorKeys, (floorObj && floorObj.name) || floorKey, LOCATION_META_FIELDS, 'Lantai');
                usedFloorKeys[newFloorKey] = true;

                const oldGateways = (floorObj && floorObj.gateways) || {};
                const usedGwKeys = {};
                Object.entries(oldGateways).forEach(([gwKey, gwObj]) => {
                    const newGwKey = nextAvailableKey(usedGwKeys, (gwObj && gwObj.name) || gwKey, [], 'Gateway');
                    usedGwKeys[newGwKey] = true;
                    const oldRooms = (gwObj && gwObj.rooms) || {};
                    Object.entries(oldRooms).forEach(([roomNum, roomData]) => {
                        if (roomData == null) return;
                        updates[`locations/${locId}/${newFloorKey}/${newGwKey}/${roomKey(roomNum)}`] = roomData;
                    });
                });
            });
            updates[`locations/${locId}/floors`] = null;
        }
    });

    return needsMigration ? db.ref().update(updates) : null;
}

/* ===== PEMBERSIHAN: hapus placeholder createdAt begitu lantai/gateway sudah punya isi sungguhan ===== */
/* createdAt dipakai di floorModalSave/gwModalSave supaya node lantai/gateway yang masih kosong tidak
   dipangkas Firebase (RTDB tidak bisa menyimpan node tanpa child sama sekali). Begitu lantai itu sudah
   punya gateway sungguhan, atau gateway itu sudah punya kamar sungguhan, placeholder-nya tidak diperlukan
   lagi dan dibersihkan di sini. PENTING: hanya dihapus kalau ada child lain juga - kalau createdAt itu
   satu-satunya field, menghapusnya akan membuat node ikut hilang (dipangkas Firebase), jadi placeholder
   dibiarkan sampai benar-benar ada isi. */
function stripLegacyCreatedAt(data) {
    const updates = {};
    let needsCleanup = false;

    Object.entries(data).forEach(([locId, loc]) => {
        Object.entries(getFloors(loc)).forEach(([floorId, floor]) => {
            const gateways = getGateways(floor);
            const floorHasRealContent = Object.keys(gateways).length > 0;
            if (floor && Object.prototype.hasOwnProperty.call(floor, 'createdAt') && floorHasRealContent) {
                needsCleanup = true;
                updates[`locations/${locId}/${floorId}/createdAt`] = null;
            }
            Object.entries(gateways).forEach(([gwId, gw]) => {
                const gwHasRealContent = Object.keys(getRooms(gw)).length > 0 || !!(gw && gw.gatewayMac);
                if (gw && typeof gw === 'object' && Object.prototype.hasOwnProperty.call(gw, 'createdAt') && gwHasRealContent) {
                    needsCleanup = true;
                    updates[`locations/${locId}/${floorId}/${gwId}/createdAt`] = null;
                }
            });
        });
    });

    return needsCleanup ? db.ref().update(updates) : null;
}

/* ===== PEMBERSIHAN: ratakan wrapper "rooms" lama - kamar sekarang langsung jadi child gateway ("Kamar N") ===== */
function flattenLegacyRoomsIfNeeded(data) {
    const updates = {};
    let needsFlatten = false;

    Object.entries(data).forEach(([locId, loc]) => {
        Object.entries(getFloors(loc)).forEach(([floorId, floor]) => {
            Object.entries(getGateways(floor)).forEach(([gwId, gw]) => {
                if (gw && typeof gw === 'object' && gw.rooms) {
                    needsFlatten = true;
                    Object.entries(gw.rooms).forEach(([roomNum, roomData]) => {
                        if (roomData == null) return;
                        updates[`locations/${locId}/${floorId}/${gwId}/${roomKey(roomNum)}`] = roomData;
                    });
                    updates[`locations/${locId}/${floorId}/${gwId}/rooms`] = null;
                }
            });
        });
    });

    return needsFlatten ? db.ref().update(updates) : null;
}

/* ===== SEED DATA AWAL ===== */
/* Key cabang dibuat dari nama+alamat (generateLocationKey), bukan id generik seperti "loc1" */
function seedIfEmpty() {
    db.ref('locations').once('value', (snapshot) => {
        if (snapshot.exists()) return;

        const name = "ISK House Kemanggisan";
        const address = "Jl. Kemanggisan Raya, Jakarta Barat";
        const key = generateLocationKey(name, address);

        db.ref('locations').set({
            [key]: {
                name, address,
                "Lantai 1": {
                    "Gateway 1": {
                        [roomKey(1)]: { tenant: "Budi Santoso", rfidAccess: true, status: "locked" },
                        [roomKey(3)]: { tenant: "Rian Pratama", rfidAccess: false, status: "locked" },
                        [roomKey(5)]: { tenant: "", rfidAccess: true, status: "locked" }
                    }
                }
            }
        });
    });
}

/* ===== AUTO-LOCK: pastikan setiap kamar yang sedang terbuka punya timer aktif ===== */
/* Ini juga menangani kasus refresh browser di tengah hitung mundur */
function ensureAutoLockTimers() {
    Object.entries(locationsData).forEach(([locId, loc]) => {
        Object.entries(getFloors(loc)).forEach(([floorId, floor]) => {
            Object.entries(getGateways(floor)).forEach(([gwId, gw]) => {
                Object.entries(getRooms(gw)).forEach(([roomKeyStr, room]) => {
                    const roomNum = roomNumberFromKey(roomKeyStr);
                    const timerKey = `${locId}_${floorId}_${gwId}_${roomNum}`;

                    if (room.status === 'unlocked' && !autoLockTimers[timerKey]) {
                        const elapsed = Date.now() - (room.unlockedAt || Date.now());
                        const remainingMs = AUTO_LOCK_SECONDS * 1000 - elapsed;
                        const path = `locations/${locId}/${floorId}/${gwId}/${roomKeyStr}`;

                        if (remainingMs <= 0) {
                            db.ref(path).update({ status: 'locked', unlockedAt: null });
                            logHistory(locId, floorId, gwId, roomNum, 'lock', 'Sistem (Auto-kunci)');
                        } else {
                            autoLockTimers[timerKey] = setTimeout(() => {
                                db.ref(path).update({ status: 'locked', unlockedAt: null });
                                logHistory(locId, floorId, gwId, roomNum, 'lock', 'Sistem (Auto-kunci)');
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
    const floors = getFloors(locationsData[currentLoc]);
    currentFloor = Object.keys(floors)[0] || null;
    const gateways = currentFloor ? getGateways(floors[currentFloor]) : {};
    currentGw = Object.keys(gateways)[0] || null;
    renderFloorTabs();
    renderGatewayTabs();
    renderAll();
});

/* ===== MODAL: Tambah Lokasi ===== */
addLocationBtn.addEventListener('click', () => {
    locNameInput.value = '';
    locAddressInput.value = '';
    locModalError.textContent = '';
    locModalOverlay.classList.add('open');
});
document.getElementById('locModalCancel').addEventListener('click', () => locModalOverlay.classList.remove('open'));
locModalOverlay.addEventListener('click', (e) => { if (e.target === locModalOverlay) locModalOverlay.classList.remove('open'); });

/* Bikin key Firebase yang enak dibaca dari Nama + Alamat, mis. "ISK House - Kemayoran" */
function generateLocationKey(name, address) {
    const raw = address ? `${name} - ${address}` : name;
    return nextAvailableKey(locationsData, raw, [], 'Kos');
}

document.getElementById('locModalSave').addEventListener('click', () => {
    locModalError.textContent = '';
    const name = locNameInput.value.trim();
    const address = locAddressInput.value.trim();
    if (!name) { locModalError.textContent = 'Nama kos wajib diisi.'; return; }

    const key = generateLocationKey(name, address);
    db.ref(`locations/${key}`).set({ name, address }).then(() => {
        currentLoc = key;
        currentFloor = null;
        currentGw = null;
        locModalOverlay.classList.remove('open');
    }).catch(err => {
        console.error('Gagal menyimpan kos baru. Cek Realtime Database Rules.', err);
        locModalError.textContent = err.code === 'PERMISSION_DENIED'
            ? 'Gagal menyimpan: akun Anda tidak punya izin menulis data (bukan admin/belum disetujui).'
            : 'Gagal menyimpan, coba lagi.';
    });
});

deleteLocationBtn.addEventListener('click', () => {
    if (!currentLoc) return;
    const name = locationsData[currentLoc]?.name || '';
    if (!confirm(`Hapus kos "${name}" beserta semua lantai & kamarnya? Tindakan ini tidak bisa dibatalkan.`)) return;
    db.ref(`locations/${currentLoc}`).remove();
    currentLoc = null;
    currentFloor = null;
    currentGw = null;
});

/* ===== RENDER: Tab Lantai ===== */
function renderFloorTabs() {
    if (!currentLoc) { floorTabs.innerHTML = ''; return; }
    const floors = getFloors(locationsData[currentLoc]);
    floorTabs.innerHTML = Object.keys(floors).map(id => `
        <button class="gateway-tab ${id === currentFloor ? 'active' : ''}" data-floor="${id}">${id}</button>
    `).join('');

    floorTabs.querySelectorAll('.gateway-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            currentFloor = btn.dataset.floor;
            const gateways = getGateways(locationsData[currentLoc][currentFloor]);
            currentGw = Object.keys(gateways)[0] || null;
            renderFloorTabs();
            renderGatewayTabs();
            renderAll();
        });
    });
}

/* ===== MODAL: Tambah Lantai ===== */
/* Nama lantai dipilih dari dropdown custom "Lantai 1".."Lantai N" (bukan diketik bebas, dan bukan <select>
   native supaya menunya selalu terbuka ke bawah - lihat .custom-select di style.css) supaya penulisannya
   seragam - ini juga menjaga format yang dibutuhkan getRoomNumberRange() (mengambil angka dari nama lantai). */
function setFloorDropdownValue(label) {
    floorNameInput.textContent = label;
    floorNameInput.dataset.value = label;
    floorNameMenu.querySelectorAll('.custom-select-option').forEach(opt => {
        opt.classList.toggle('active', opt.dataset.value === label);
    });
}

addFloorBtn.addEventListener('click', () => {
    if (!currentLoc) { alert('Tambahkan lokasi kos dulu.'); return; }
    floorModalError.textContent = '';

    const floors = getFloors(locationsData[currentLoc]);
    const options = [];
    for (let i = 1; i <= MAX_FLOORS; i++) {
        const label = `Lantai ${i}`;
        if (!floors[label]) options.push(label);
    }

    if (options.length === 0) {
        alert(`Maksimal ${MAX_FLOORS} lantai per kos sudah tercapai.`);
        return;
    }

    floorNameMenu.innerHTML = options.map(label => `<div class="custom-select-option" data-value="${label}">${label}</div>`).join('');
    floorNameMenu.querySelectorAll('.custom-select-option').forEach(opt => {
        opt.addEventListener('click', () => {
            setFloorDropdownValue(opt.dataset.value);
            floorNameMenu.classList.remove('open');
        });
    });
    setFloorDropdownValue(options[0]);
    floorNameMenu.classList.remove('open');
    floorModalOverlay.classList.add('open');
});

floorNameInput.addEventListener('click', () => floorNameMenu.classList.toggle('open'));
document.addEventListener('click', (e) => {
    if (!document.getElementById('floorSelectWrap').contains(e.target)) floorNameMenu.classList.remove('open');
});

document.getElementById('floorModalCancel').addEventListener('click', () => floorModalOverlay.classList.remove('open'));
floorModalOverlay.addEventListener('click', (e) => { if (e.target === floorModalOverlay) floorModalOverlay.classList.remove('open'); });

/* Key lantai = nama yang diketik admin langsung (disanitasi + di-dedup), bukan id auto seperti "Lantai 1" yang terpisah dari field name.
   Dipakai juga oleh modal Klasifikasikan Gateway/Doorlock (lantai baru lewat input teks bebas di sana). */
function generateFloorKey(locId, name) {
    return nextAvailableKey(locationsData[locId] || {}, name, LOCATION_META_FIELDS, 'Lantai');
}

document.getElementById('floorModalSave').addEventListener('click', () => {
    floorModalError.textContent = '';
    const key = floorNameInput.dataset.value;
    if (!key || !currentLoc) { floorModalError.textContent = 'Pilih lantai terlebih dahulu.'; return; }

    // createdAt = placeholder supaya node lantai yang masih kosong (belum ada gateway) tidak dipangkas
    // Firebase (RTDB tidak bisa menyimpan node tanpa child) - dibersihkan otomatis lewat stripLegacyCreatedAt
    // begitu lantai ini sudah punya gateway sungguhan.
    db.ref(`locations/${currentLoc}/${key}`).set({ createdAt: Date.now() }).then(() => {
        currentFloor = key;
        currentGw = null;
        floorModalOverlay.classList.remove('open');
    }).catch(err => {
        console.error('Gagal menyimpan lantai baru. Cek Realtime Database Rules.', err);
        floorModalError.textContent = err.code === 'PERMISSION_DENIED'
            ? 'Gagal menyimpan: akun Anda tidak punya izin menulis data (bukan admin/belum disetujui).'
            : 'Gagal menyimpan, coba lagi.';
    });
});

deleteFloorBtn.addEventListener('click', () => {
    if (!currentLoc || !currentFloor) return;
    if (!confirm(`Hapus ${currentFloor} beserta semua gateway & kamarnya? Tindakan ini tidak bisa dibatalkan.`)) return;
    db.ref(`locations/${currentLoc}/${currentFloor}`).remove();
    currentFloor = null;
    currentGw = null;
});

/* ===== RENDER: Tab Gateway ===== */
/* Satu lantai bisa punya > 1 gateway karena jangkauan ESP-NOW gateway terbatas (~5 meter) */
function renderGatewayTabs() {
    if (!currentLoc || !currentFloor) { gatewayTabs.innerHTML = ''; return; }
    const gateways = getGateways(locationsData[currentLoc][currentFloor]);
    gatewayTabs.innerHTML = Object.keys(gateways).map(id => `
        <button class="gateway-tab ${id === currentGw ? 'active' : ''}" data-gw="${id}">${id}</button>
    `).join('');

    gatewayTabs.querySelectorAll('.gateway-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            currentGw = btn.dataset.gw;
            renderGatewayTabs();
            renderAll();
        });
    });
}

/* ===== MODAL: Tambah Gateway ===== */
addGatewayBtn.addEventListener('click', () => {
    if (!currentFloor) { alert('Tambahkan lantai dulu.'); return; }
    gwNameInput.value = '';
    gwModalError.textContent = '';
    gwModalOverlay.classList.add('open');
});
document.getElementById('gwModalCancel').addEventListener('click', () => gwModalOverlay.classList.remove('open'));
gwModalOverlay.addEventListener('click', (e) => { if (e.target === gwModalOverlay) gwModalOverlay.classList.remove('open'); });

/* Key gateway = nama yang diketik admin langsung (disanitasi + di-dedup), bukan id auto seperti "Gateway 1" yang terpisah dari field name */
function generateGatewayKey(locId, floorId, name) {
    return nextAvailableKey(locationsData[locId]?.[floorId] || {}, name, [], 'Gateway');
}

document.getElementById('gwModalSave').addEventListener('click', () => {
    gwModalError.textContent = '';
    const name = gwNameInput.value.trim();
    if (!name || !currentLoc || !currentFloor) { gwModalError.textContent = 'Nama gateway wajib diisi.'; return; }

    const key = generateGatewayKey(currentLoc, currentFloor, name);
    // createdAt = placeholder yang sama seperti di lantai, supaya gateway kosong (belum ada kamar) tidak
    // dipangkas Firebase - dibersihkan otomatis lewat stripLegacyCreatedAt begitu sudah ada kamar sungguhan.
    db.ref(`locations/${currentLoc}/${currentFloor}/${key}`).set({ createdAt: Date.now() }).then(() => {
        currentGw = key;
        gwModalOverlay.classList.remove('open');
    }).catch(err => {
        console.error('Gagal menyimpan gateway baru. Cek Realtime Database Rules.', err);
        gwModalError.textContent = err.code === 'PERMISSION_DENIED'
            ? 'Gagal menyimpan: akun Anda tidak punya izin menulis data (bukan admin/belum disetujui).'
            : 'Gagal menyimpan, coba lagi.';
    });
});

deleteGatewayBtn.addEventListener('click', () => {
    if (!currentLoc || !currentFloor || !currentGw) return;
    if (!confirm(`Hapus ${currentGw} beserta semua kamarnya? Tindakan ini tidak bisa dibatalkan.`)) return;
    db.ref(`locations/${currentLoc}/${currentFloor}/${currentGw}`).remove();
    currentGw = null;
});

/* ===== Helper: ambil array kamar ===== */
function getRoomsArray() {
    if (!currentLoc || !currentFloor || !currentGw) return [];
    const rooms = getRooms(locationsData[currentLoc]?.[currentFloor]?.[currentGw]);
    return Object.entries(rooms)
        .map(([key, data]) => ({ number: roomNumberFromKey(key), ...data }))
        .sort((a, b) => a.number - b.number);
}

/* ===== RENDER: Ringkasan Gateway ===== */
function renderSummary() {
    if (!currentLoc || !currentFloor || !currentGw) { gatewaySummary.innerHTML = ''; return; }
    const rooms = getRoomsArray();
    const lockedCount = rooms.filter(r => r.status === 'locked').length;
    const unlockedCount = rooms.filter(r => r.status === 'unlocked').length;
    const rfidBlockedCount = rooms.filter(r => !r.rfidAccess).length;

    gatewaySummary.innerHTML = `
        <div>
            <div class="gs-title">${currentGw}</div>
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

    if (!currentFloor) {
        roomList.innerHTML = `<p style="color:var(--text-muted); font-size:13px;">Pilih atau tambahkan lantai dulu.</p>`;
        addRoomBtn.style.display = 'none';
        return;
    }
    if (!currentGw) {
        roomList.innerHTML = `<p style="color:var(--text-muted); font-size:13px;">Pilih atau tambahkan gateway dulu.</p>`;
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

    if (!currentFloor || !currentGw || allEntries.length === 0) {
        historyTableBody.innerHTML = `<tr><td colspan="4" style="text-align:center; color:var(--text-muted);">Belum ada aktivitas</td></tr>`;
        return;
    }

    const tagMap = {
        unlock: ['tag--unlock', 'Unlock'],
        lock: ['tag--lock', 'Lock'],
        rfid_block: ['tag--rfid', 'RFID Diblokir'],
        rfid_unblock: ['tag--rfid', 'RFID Diizinkan'],
        classified: ['tag--classify', 'Doorlock Diklasifikasikan']
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
function logHistory(loc, floor, gw, roomNumber, action, by) {
    const histRef = db.ref(`locations/${loc}/${floor}/${gw}/${roomKey(roomNumber)}/history`);
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
    const loc = currentLoc, floor = currentFloor, gw = currentGw;
    const path = `locations/${loc}/${floor}/${gw}/${roomKey(number)}`;
    const room = getRoomsArray().find(r => r.number === number);
    const newStatus = room.status === 'locked' ? 'unlocked' : 'locked';
    const timerKey = `${loc}_${floor}_${gw}_${number}`;

    if (autoLockTimers[timerKey]) {
        clearTimeout(autoLockTimers[timerKey]);
        delete autoLockTimers[timerKey];
    }

    if (newStatus === 'unlocked') {
        db.ref(path).update({ status: 'unlocked', unlockedAt: Date.now() });
        logHistory(loc, floor, gw, number, 'unlock', currentUserLabel || 'Admin');

        autoLockTimers[timerKey] = setTimeout(() => {
            db.ref(path).update({ status: 'locked', unlockedAt: null });
            logHistory(loc, floor, gw, number, 'lock', 'Sistem (Auto-kunci)');
            delete autoLockTimers[timerKey];
        }, AUTO_LOCK_SECONDS * 1000);
    } else {
        db.ref(path).update({ status: 'locked', unlockedAt: null });
        logHistory(loc, floor, gw, number, 'lock', currentUserLabel || 'Admin');
    }

    // TODO: ESP32 Gateway membaca perubahan status di path ini via HTTP polling / listener
}

/* ===== AKSI: Blokir/Izinkan RFID ===== */
function toggleRfid(number) {
    const loc = currentLoc, floor = currentFloor, gw = currentGw;
    const roomRef = db.ref(`locations/${loc}/${floor}/${gw}/${roomKey(number)}`);
    const room = getRoomsArray().find(r => r.number === number);
    const newAccess = !room.rfidAccess;

    roomRef.update({ rfidAccess: newAccess });
    logHistory(loc, floor, gw, number, newAccess ? 'rfid_unblock' : 'rfid_block', currentUserLabel || 'Admin');
    // TODO: ESP32-C3 mengecek field rfidAccess ini sebelum mengizinkan kartu membuka pintu
}

/* ===== AKSI: Hapus Kamar ===== */
function deleteRoom(number) {
    const room = getRoomsArray().find(r => r.number === number);
    if (!confirm(`Hapus Kamar ${number} (${room.tenant || 'kosong'})?`)) return;
    db.ref(`locations/${currentLoc}/${currentFloor}/${currentGw}/${roomKey(number)}`).remove();
}

/* ===== MODAL: Tambah/Edit Kamar ===== */
function openModal(number = null) {
    editingRoomNumber = number;
    const rooms = getRoomsArray();
    const usedNumbers = rooms.map(r => r.number);

    const { start, end } = getRoomNumberRange(currentFloor);
    const availableNumbers = [];
    for (let i = start; i <= end; i++) {
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

    roomModalError.textContent = '';
    modalOverlay.classList.add('open');
}

function closeModal() { modalOverlay.classList.remove('open'); editingRoomNumber = null; }

addRoomBtn.addEventListener('click', () => openModal());
document.getElementById('modalCancel').addEventListener('click', closeModal);
modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });

document.getElementById('modalSave').addEventListener('click', () => {
    roomModalError.textContent = '';
    const newNumber = parseInt(roomNumberInput.value);
    const newTenant = tenantNameInput.value.trim();
    const newRfid = rfidInput.checked;
    const basePath = `locations/${currentLoc}/${currentFloor}/${currentGw}`;

    let writePromise;
    if (editingRoomNumber) {
        const existing = getRoomsArray().find(r => r.number === editingRoomNumber);
        const updated = { tenant: newTenant, rfidAccess: newRfid, status: existing?.status || 'locked' };
        if (existing?.doorlockMac) updated.doorlockMac = existing.doorlockMac;
        writePromise = editingRoomNumber !== newNumber
            ? db.ref(`${basePath}/${roomKey(editingRoomNumber)}`).remove().then(() => db.ref(`${basePath}/${roomKey(newNumber)}`).set(updated))
            : db.ref(`${basePath}/${roomKey(newNumber)}`).set(updated);
    } else {
        writePromise = db.ref(`${basePath}/${roomKey(newNumber)}`).set({ tenant: newTenant, rfidAccess: newRfid, status: 'locked' });
    }

    writePromise.then(() => {
        closeModal();
    }).catch(err => {
        console.error('Gagal menyimpan kamar. Cek Realtime Database Rules.', err);
        roomModalError.textContent = err.code === 'PERMISSION_DENIED'
            ? 'Gagal menyimpan: akun Anda tidak punya izin menulis data (bukan admin/belum disetujui).'
            : 'Gagal menyimpan, coba lagi.';
    });
});

/* ===== MODAL: Klasifikasikan Gateway (cabang + lantai + nama gateway) ===== */
const NEW_OPTION_VALUE = '__new__';

const classifyGwModalOverlay = document.getElementById('classifyGwModalOverlay');
const classifyGwMacLabel = document.getElementById('classifyGwMacLabel');
const classifyGwLocSelect = document.getElementById('classifyGwLocSelect');
const classifyGwNewLocFields = document.getElementById('classifyGwNewLocFields');
const classifyGwLocNameInput = document.getElementById('classifyGwLocNameInput');
const classifyGwLocAddressInput = document.getElementById('classifyGwLocAddressInput');
const classifyGwFloorSelect = document.getElementById('classifyGwFloorSelect');
const classifyGwNewFloorFields = document.getElementById('classifyGwNewFloorFields');
const classifyGwFloorNameInput = document.getElementById('classifyGwFloorNameInput');
const classifyGwGatewayNameInput = document.getElementById('classifyGwGatewayNameInput');
const classifyGwError = document.getElementById('classifyGwError');

let classifyingGatewayMac = null;

function openClassifyGatewayModal(mac) {
    classifyingGatewayMac = mac;
    classifyGwMacLabel.textContent = mac;
    classifyGwError.textContent = '';
    classifyGwGatewayNameInput.value = '';

    classifyGwLocSelect.innerHTML = Object.entries(locationsData)
        .map(([id, loc]) => `<option value="${id}">${loc.name}</option>`).join('')
        + `<option value="${NEW_OPTION_VALUE}">+ Cabang Baru</option>`;
    classifyGwLocSelect.value = (currentLoc && locationsData[currentLoc]) ? currentLoc : NEW_OPTION_VALUE;

    updateClassifyGwLocFields();
    classifyGwModalOverlay.classList.add('open');
}

function updateClassifyGwLocFields() {
    const isNewLoc = classifyGwLocSelect.value === NEW_OPTION_VALUE;
    classifyGwNewLocFields.style.display = isNewLoc ? 'block' : 'none';
    classifyGwLocNameInput.value = '';
    classifyGwLocAddressInput.value = '';
    updateClassifyGwFloorOptions();
}

function updateClassifyGwFloorOptions() {
    const locId = classifyGwLocSelect.value;
    const isNewLoc = locId === NEW_OPTION_VALUE;
    const floors = isNewLoc ? {} : getFloors(locationsData[locId]);
    const floorIds = Object.keys(floors);

    classifyGwFloorSelect.innerHTML = floorIds.map(id => `<option value="${id}">${id}</option>`).join('')
        + `<option value="${NEW_OPTION_VALUE}">+ Lantai Baru</option>`;
    classifyGwFloorSelect.value = (!isNewLoc && currentFloor && floors[currentFloor]) ? currentFloor : (floorIds[0] || NEW_OPTION_VALUE);

    updateClassifyGwFloorFields();
}

function updateClassifyGwFloorFields() {
    const isNewFloor = classifyGwFloorSelect.value === NEW_OPTION_VALUE;
    classifyGwNewFloorFields.style.display = isNewFloor ? 'block' : 'none';
    classifyGwFloorNameInput.value = '';
}

classifyGwLocSelect.addEventListener('change', updateClassifyGwLocFields);
classifyGwFloorSelect.addEventListener('change', updateClassifyGwFloorFields);

function closeClassifyGatewayModal() {
    classifyGwModalOverlay.classList.remove('open');
    classifyingGatewayMac = null;
}

document.getElementById('classifyGwModalCancel').addEventListener('click', closeClassifyGatewayModal);
classifyGwModalOverlay.addEventListener('click', (e) => { if (e.target === classifyGwModalOverlay) closeClassifyGatewayModal(); });

document.getElementById('classifyGwModalSave').addEventListener('click', () => {
    classifyGwError.textContent = '';

    const isNewLoc = classifyGwLocSelect.value === NEW_OPTION_VALUE;
    const isNewFloor = classifyGwFloorSelect.value === NEW_OPTION_VALUE;
    const name = classifyGwGatewayNameInput.value.trim();
    const mac = classifyingGatewayMac;

    if (!name) { classifyGwError.textContent = 'Nama gateway wajib diisi.'; return; }
    if (isNewLoc && !classifyGwLocNameInput.value.trim()) { classifyGwError.textContent = 'Nama kos baru wajib diisi.'; return; }
    if (isNewFloor && !classifyGwFloorNameInput.value.trim()) { classifyGwError.textContent = 'Nama lantai baru wajib diisi.'; return; }

    let locWrite;
    if (isNewLoc) {
        const locName = classifyGwLocNameInput.value.trim();
        const address = classifyGwLocAddressInput.value.trim();
        const locId = generateLocationKey(locName, address);
        locWrite = db.ref(`locations/${locId}`).set({ name: locName, address }).then(() => locId);
    } else {
        locWrite = Promise.resolve(classifyGwLocSelect.value);
    }

    locWrite.then(locId => {
        // Lantai baru tidak ditulis terpisah - node-nya otomatis terbentuk lewat deep-set gateway di bawah,
        // supaya tidak sempat tersimpan sebagai node kosong (lihat getGateways/stripLegacyCreatedAt).
        const floorId = isNewFloor ? generateFloorKey(locId, classifyGwFloorNameInput.value.trim()) : classifyGwFloorSelect.value;
        const gwId = generateGatewayKey(locId, floorId, name);

        return db.ref(`locations/${locId}/${floorId}/${gwId}`).set({ gatewayMac: mac }).then(() => {
            currentLoc = locId;
            currentFloor = floorId;
            currentGw = gwId;
            return db.ref(`pendingGateways/${mac}`).remove();
        });
    }).then(() => {
        closeClassifyGatewayModal();
    }).catch(err => {
        console.error('Gagal menyimpan klasifikasi gateway.', err);
        classifyGwError.textContent = 'Gagal menyimpan, coba lagi.';
    });
});

/* ===== MODAL: Klasifikasikan Doorlock (cabang + lantai + gateway + nomor kamar) ===== */

const classifyModalOverlay = document.getElementById('classifyModalOverlay');
const classifyMacLabel = document.getElementById('classifyMacLabel');
const classifyLocSelect = document.getElementById('classifyLocSelect');
const classifyNewLocFields = document.getElementById('classifyNewLocFields');
const classifyLocNameInput = document.getElementById('classifyLocNameInput');
const classifyLocAddressInput = document.getElementById('classifyLocAddressInput');
const classifyFloorSelect = document.getElementById('classifyFloorSelect');
const classifyNewFloorFields = document.getElementById('classifyNewFloorFields');
const classifyFloorNameInput = document.getElementById('classifyFloorNameInput');
const classifyGwSelect = document.getElementById('classifyGwSelect');
const classifyNewGwFields = document.getElementById('classifyNewGwFields');
const classifyGwNameInput = document.getElementById('classifyGwNameInput');
const classifyRoomNumberInput = document.getElementById('classifyRoomNumberInput');
const classifyError = document.getElementById('classifyError');

let classifyingMac = null;

function openClassifyModal(mac) {
    classifyingMac = mac;
    classifyMacLabel.textContent = mac;
    classifyError.textContent = '';

    classifyLocSelect.innerHTML = Object.entries(locationsData)
        .map(([id, loc]) => `<option value="${id}">${loc.name}</option>`).join('')
        + `<option value="${NEW_OPTION_VALUE}">+ Cabang Baru</option>`;
    classifyLocSelect.value = (currentLoc && locationsData[currentLoc]) ? currentLoc : NEW_OPTION_VALUE;

    updateClassifyLocFields();
    classifyModalOverlay.classList.add('open');
}

function updateClassifyLocFields() {
    const isNewLoc = classifyLocSelect.value === NEW_OPTION_VALUE;
    classifyNewLocFields.style.display = isNewLoc ? 'block' : 'none';
    classifyLocNameInput.value = '';
    classifyLocAddressInput.value = '';
    updateClassifyFloorOptions();
}

function updateClassifyFloorOptions() {
    const locId = classifyLocSelect.value;
    const isNewLoc = locId === NEW_OPTION_VALUE;
    const floors = isNewLoc ? {} : getFloors(locationsData[locId]);
    const floorIds = Object.keys(floors);

    classifyFloorSelect.innerHTML = floorIds.map(id => `<option value="${id}">${id}</option>`).join('')
        + `<option value="${NEW_OPTION_VALUE}">+ Lantai Baru</option>`;
    classifyFloorSelect.value = (!isNewLoc && currentFloor && floors[currentFloor]) ? currentFloor : (floorIds[0] || NEW_OPTION_VALUE);

    updateClassifyFloorFields();
}

function updateClassifyFloorFields() {
    const isNewFloor = classifyFloorSelect.value === NEW_OPTION_VALUE;
    classifyNewFloorFields.style.display = isNewFloor ? 'block' : 'none';
    classifyFloorNameInput.value = '';
    updateClassifyGwOptions();
}

function updateClassifyGwOptions() {
    const locId = classifyLocSelect.value;
    const floorId = classifyFloorSelect.value;
    const isNewLoc = locId === NEW_OPTION_VALUE;
    const isNewFloor = floorId === NEW_OPTION_VALUE;
    const gateways = (isNewLoc || isNewFloor) ? {} : getGateways(locationsData[locId]?.[floorId]);
    const gwIds = Object.keys(gateways);

    classifyGwSelect.innerHTML = gwIds.map(id => `<option value="${id}">${id}</option>`).join('')
        + `<option value="${NEW_OPTION_VALUE}">+ Gateway Baru</option>`;
    classifyGwSelect.value = (!isNewLoc && !isNewFloor && currentGw && gateways[currentGw]) ? currentGw : (gwIds[0] || NEW_OPTION_VALUE);

    updateClassifyGwFields();
}

function updateClassifyGwFields() {
    const isNewGw = classifyGwSelect.value === NEW_OPTION_VALUE;
    classifyNewGwFields.style.display = isNewGw ? 'block' : 'none';
    classifyGwNameInput.value = '';
    updateClassifyRoomOptions();
}

function updateClassifyRoomOptions() {
    const locId = classifyLocSelect.value;
    const floorId = classifyFloorSelect.value;
    const gwId = classifyGwSelect.value;
    const isNewLoc = locId === NEW_OPTION_VALUE;
    const isNewFloor = floorId === NEW_OPTION_VALUE;
    const isNewGw = gwId === NEW_OPTION_VALUE;

    let usedNumbers = [];
    if (!isNewLoc && !isNewFloor && !isNewGw) {
        const rooms = getRooms(locationsData[locId]?.[floorId]?.[gwId]);
        usedNumbers = Object.keys(rooms).map(roomNumberFromKey);
    }

    // Penomoran ikut angka lantai (mis. Lantai 2 -> 201-220) - kalau lantai baru, pakai nama yang sedang diketik
    const floorForNumbering = isNewFloor ? classifyFloorNameInput.value.trim() : floorId;
    const { start, end } = getRoomNumberRange(floorForNumbering);

    const available = [];
    for (let i = start; i <= end; i++) {
        if (!usedNumbers.includes(i)) available.push(i);
    }
    classifyRoomNumberInput.innerHTML = available.map(n => `<option value="${n}">Kamar ${n}</option>`).join('');
}

classifyLocSelect.addEventListener('change', updateClassifyLocFields);
classifyFloorSelect.addEventListener('change', updateClassifyFloorFields);
classifyFloorNameInput.addEventListener('input', updateClassifyRoomOptions);
classifyGwSelect.addEventListener('change', updateClassifyGwFields);

function closeClassifyModal() {
    classifyModalOverlay.classList.remove('open');
    classifyingMac = null;
}

document.getElementById('classifyModalCancel').addEventListener('click', closeClassifyModal);
classifyModalOverlay.addEventListener('click', (e) => { if (e.target === classifyModalOverlay) closeClassifyModal(); });

document.getElementById('classifyModalSave').addEventListener('click', () => {
    classifyError.textContent = '';

    const isNewLoc = classifyLocSelect.value === NEW_OPTION_VALUE;
    const isNewFloor = classifyFloorSelect.value === NEW_OPTION_VALUE;
    const isNewGw = classifyGwSelect.value === NEW_OPTION_VALUE;
    const roomNumber = parseInt(classifyRoomNumberInput.value);
    const mac = classifyingMac;

    if (!roomNumber) { classifyError.textContent = 'Pilih nomor kamar.'; return; }
    if (isNewLoc && !classifyLocNameInput.value.trim()) { classifyError.textContent = 'Nama kos baru wajib diisi.'; return; }
    if (isNewFloor && !classifyFloorNameInput.value.trim()) { classifyError.textContent = 'Nama lantai baru wajib diisi.'; return; }
    if (isNewGw && !classifyGwNameInput.value.trim()) { classifyError.textContent = 'Nama gateway baru wajib diisi.'; return; }

    let locWrite;
    if (isNewLoc) {
        const name = classifyLocNameInput.value.trim();
        const address = classifyLocAddressInput.value.trim();
        const locId = generateLocationKey(name, address);
        locWrite = db.ref(`locations/${locId}`).set({ name, address }).then(() => locId);
    } else {
        locWrite = Promise.resolve(classifyLocSelect.value);
    }

    locWrite.then(locId => {
        let floorWrite;
        if (isNewFloor) {
            const name = classifyFloorNameInput.value.trim();
            const floorId = generateFloorKey(locId, name);
            floorWrite = db.ref(`locations/${locId}/${floorId}`).set({}).then(() => floorId);
        } else {
            floorWrite = Promise.resolve(classifyFloorSelect.value);
        }
        return floorWrite.then(floorId => ({ locId, floorId }));
    }).then(({ locId, floorId }) => {
        let gwWrite;
        if (isNewGw) {
            const name = classifyGwNameInput.value.trim();
            const gwId = generateGatewayKey(locId, floorId, name);
            gwWrite = db.ref(`locations/${locId}/${floorId}/${gwId}`).set({}).then(() => gwId);
        } else {
            gwWrite = Promise.resolve(classifyGwSelect.value);
        }
        return gwWrite.then(gwId => ({ locId, floorId, gwId }));
    }).then(({ locId, floorId, gwId }) => {
        const roomPath = `locations/${locId}/${floorId}/${gwId}/${roomKey(roomNumber)}`;
        return db.ref(roomPath).set({ tenant: '', rfidAccess: true, status: 'locked', doorlockMac: mac }).then(() => {
            logHistory(locId, floorId, gwId, roomNumber, 'classified', currentUserLabel || 'Admin');
            currentLoc = locId;
            currentFloor = floorId;
            currentGw = gwId;
            return db.ref(`pendingDevices/${mac}`).remove();
        });
    }).then(() => {
        closeClassifyModal();
    }).catch(err => {
        console.error('Gagal menyimpan klasifikasi doorlock.', err);
        classifyError.textContent = 'Gagal menyimpan, coba lagi.';
    });
});