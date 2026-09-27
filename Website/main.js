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
const HISTORY_STORAGE_KEY = 'isk-history'; // riwayat hanya disimpan di localStorage browser, tidak di Firebase
const AUTO_LOCK_SECONDS = 5;       // ganti angka ini untuk atur durasi pintu terbuka
const GATEWAY_OFFLINE_MS = 75000;  // gateway melapor tiap 30 detik; lewat dari ini dianggap offline
const BATTERY_LOW = 20;            // % -> indikator baterai merah (sama dengan BATTERY_LOW di firmware gateway)
// Field status doorlock yang ditulis gateway - dipertahankan saat kamar diedit supaya tidak hilang
const DEVICE_STATUS_FIELDS = ['battery', 'connection', 'connectionReason', 'connectionUpdatedAt'];

// Firebase Auth butuh format email, jadi username tanpa "@" diubah jadi email sintetis dengan domain ini
const AUTH_EMAIL_DOMAIN = 'isk-house.local';

let locationsData = {};
let serverTimeOffset = 0;      // selisih jam browser dengan jam server Firebase (untuk menilai gateway online/offline)
let currentLoc = null;
let currentFloor = null;
let currentGw = null;
let editingRoomNumber = null;
let currentUserEmail = '';
let currentUserRole = '';
let currentUserLabel = '';
let userRecordRef = null;      // listener realtime ke users/{uid} milik user yang sedang login
let pendingUsersRef = null;    // listener realtime ke daftar pendaftar yang menunggu persetujuan (khusus admin)
let registeredUsersRef = null; // listener realtime ke semua user untuk panel Pengguna Terdaftar (khusus admin)
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
        // Tanpa verifikasi email: begitu akun dibuat, onAuthStateChanged -> handleUserRecord() membuat
        // data users/{uid} berstatus "pending" dan menampilkan halaman menunggu persetujuan admin.
        auth.createUserWithEmailAndPassword(email, password)
            .catch(err => { authError.textContent = terjemahkanErrorFirebase(err.code); });
    }
});

logoutBtn.addEventListener('click', () => auth.signOut());
pendingLogoutBtn.addEventListener('click', () => auth.signOut());

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
    pendingView.style.display = 'none';
    appView.classList.add('visible');
    initAppData();
    renderApprovalPanel();
    renderUsersPanel();
    renderPairingPanel();
    renderGatewayPairingPanel();
}

/* state: 'pending' (menunggu persetujuan), 'rejected' (ditolak admin), atau 'removed' (dikeluarkan admin) */
function showPendingView(state) {
    currentUserEmail = '';
    currentUserRole = '';
    authView.style.display = 'none';
    appView.classList.remove('visible');
    detachApprovalPanel();
    detachUsersPanel();
    detachPairingPanel();
    detachGatewayPairingPanel();

    if (state === 'removed') {
        pendingTitle.textContent = 'Akun Dikeluarkan';
        pendingMessage.textContent = 'Akun Anda telah dikeluarkan dari ISK House oleh admin, sehingga tidak bisa lagi mengakses dashboard. Hubungi admin ISK House jika ini keliru.';
    } else if (state === 'rejected') {
        pendingTitle.textContent = 'Pendaftaran Ditolak';
        pendingMessage.textContent = 'Maaf, pendaftaran akun Anda ditolak oleh admin. Hubungi admin ISK House jika ini keliru.';
    } else {
        pendingTitle.textContent = 'Menunggu Persetujuan Admin';
        pendingMessage.textContent = 'Pendaftaran berhasil. Akun Anda sedang menunggu persetujuan admin ISK House sebelum bisa mengakses dashboard. Halaman ini akan otomatis terbuka begitu disetujui.';
    }
    pendingView.style.display = 'flex';
}

/* Dipanggil tiap kali data users/{uid} berubah (baik saat login maupun saat admin menyetujui/menolak) */
function handleUserRecord(user, record) {
    if (record && record.role === 'admin') {
        showAppView(user, record);
        return;
    }
    if (record && record.status === 'approved') {
        showAppView(user, record);
        return;
    }
    if (record && (record.status === 'rejected' || record.status === 'removed')) {
        showPendingView(record.status);
        return;
    }
    if (!record) {
        // Akun baru daftar (atau akun lama yang belum punya data): buat data berstatus "pending" di sini saja,
        // supaya label dari meta/userCounter tidak terambil dua kali
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
        detachUsersPanel();
        detachPairingPanel();
        detachGatewayPairingPanel();
        currentUserEmail = '';
        currentUserRole = '';
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

/* ===== PANEL PENGGUNA TERDAFTAR (khusus admin) ===== */
/* Semua user selain yang masih "pending" (itu ada di panel Persetujuan Pendaftar). "Keluarkan" tidak menghapus
   akun Firebase Auth (butuh Admin SDK di server), tapi mengubah status jadi "removed" sehingga Rules menolak
   semua akses data & user langsung terlempar ke halaman "Akun Dikeluarkan". */
const usersBlock = document.getElementById('usersBlock');
const usersList = document.getElementById('usersList');
const usersCountEl = document.getElementById('usersCount');

const USER_STATUS_LABEL = {
    approved: ['user-active', 'Aktif'],
    removed: ['user-out', 'Dikeluarkan'],
    rejected: ['user-out', 'Ditolak']
};

function formatDate(ms) {
    return ms ? new Date(ms).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) : '-';
}

function renderUsersPanel() {
    if (currentUserRole !== 'admin') {
        detachUsersPanel();
        return;
    }
    usersBlock.style.display = 'block';
    if (registeredUsersRef) return; // listener sudah aktif

    registeredUsersRef = db.ref('users');
    registeredUsersRef.on('value', (snapshot) => {
        const entries = [];
        snapshot.forEach(child => { entries.push({ uid: child.key, ...child.val() }); return false; });

        // Admin dulu, lalu user aktif, lalu yang dikeluarkan/ditolak; masing-masing urut tanggal daftar
        const rank = u => u.role === 'admin' ? 0 : u.status === 'approved' ? 1 : 2;
        const users = entries
            .filter(u => u.role === 'admin' || u.status !== 'pending')
            .sort((a, b) => rank(a) - rank(b) || (a.createdAt || 0) - (b.createdAt || 0));

        usersCountEl.textContent = users.filter(u => u.role === 'admin' || u.status === 'approved').length + ' aktif';

        if (users.length === 0) {
            usersList.innerHTML = `<p class="pending-empty">Belum ada pengguna terdaftar.</p>`;
            return;
        }

        usersList.innerHTML = users.map(u => {
            const isAdmin = u.role === 'admin';
            const [badgeClass, badgeText] = isAdmin ? ['user-admin', 'Admin'] : (USER_STATUS_LABEL[u.status] || ['user-out', u.status || '-']);
            const removedInfo = u.status === 'removed' && u.removedAt ? ` · Dikeluarkan ${formatDate(u.removedAt)}${u.removedBy ? ` oleh ${u.removedBy}` : ''}` : '';

            let action = '';
            if (!isAdmin && u.status === 'approved') {
                action = `<button class="icon-btn danger" data-action="remove-user" data-uid="${u.uid}">Keluarkan</button>`;
            } else if (!isAdmin) {
                action = `<button class="icon-btn" data-action="restore-user" data-uid="${u.uid}">Izinkan Lagi</button>`;
            }

            return `
                <div class="pending-user-item">
                    <div class="pu-info">
                        <div class="pu-email">${u.label ? `${u.label} — ${u.email}` : u.email} <span class="badge ${badgeClass}">${badgeText}</span></div>
                        <div class="pu-date">Daftar ${formatDate(u.createdAt)}${removedInfo}</div>
                    </div>
                    <div class="pu-actions">${action}</div>
                </div>
            `;
        }).join('');

        usersList.querySelectorAll('[data-action]').forEach(btn => {
            const user = users.find(u => u.uid === btn.dataset.uid);
            btn.addEventListener('click', () => {
                const name = user.label ? `${user.label} (${user.email})` : user.email;
                if (btn.dataset.action === 'remove-user') {
                    if (!confirm(`Keluarkan ${name}? User ini langsung kehilangan akses ke dashboard.`)) return;
                    db.ref(`users/${user.uid}`).update({ status: 'removed', removedAt: Date.now(), removedBy: currentUserLabel || 'Admin' });
                } else {
                    db.ref(`users/${user.uid}`).update({ status: 'approved', removedAt: null, removedBy: null });
                }
            });
        });
    }, (err) => {
        console.error('Gagal membaca daftar pengguna (users). Cek Realtime Database Rules.', err);
        usersList.innerHTML = `<p class="pending-empty">Gagal memuat daftar pengguna (izin database ditolak). Cek Rules di Firebase Console.</p>`;
    });
}

function detachUsersPanel() {
    if (registeredUsersRef) { registeredUsersRef.off(); registeredUsersRef = null; }
    if (usersBlock) usersBlock.style.display = 'none';
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
                        <button class="icon-btn" data-mac="${d.mac}" data-gwmac="${d.gatewayMac || ''}">Klasifikasikan</button>
                    </div>
                </div>
            `;
        }).join('');

        pairingDevicesList.querySelectorAll('[data-mac]').forEach(btn => {
            btn.addEventListener('click', () => openClassifyModal(btn.dataset.mac, btn.dataset.gwmac));
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
const renameGatewayBtn = document.getElementById('renameGatewayBtn');
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
const gwMacLabel = document.getElementById('gwMacLabel');
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
   seperti di lantai, dipakai supaya gateway yang masih kosong (belum ada kamar) tidak dipangkas Firebase,
   gatewayStatus = laporan berkala dari firmware gateway (lastSeen, alasan restart/putus WiFi) */
const GATEWAY_META_FIELDS = ['gatewayMac', 'createdAt', 'gatewayStatus'];

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

    db.ref('.info/serverTimeOffset').on('value', (snap) => { serverTimeOffset = snap.val() || 0; });

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

        const historyCleanup = moveFirebaseHistoryToLocal(data);
        if (historyCleanup) {
            historyCleanup.catch(err => console.error('Hapus node history di Firebase gagal.', err));
            return; // listener ini akan terpanggil lagi otomatis setelah node history terhapus
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

    // Status gateway (online/offline) dinilai dari umur lastSeen, jadi perlu dicek ulang walau data tidak berubah
    setInterval(() => {
        renderSummary();
        renderRooms();
    }, 10000);
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

/* ===== PEMBERSIHAN: pindahkan node history lama dari Firebase ke localStorage, lalu hapus dari Firebase ===== */
function moveFirebaseHistoryToLocal(data) {
    const updates = {};
    const imported = [];
    let needsCleanup = false;

    Object.entries(data).forEach(([locId, loc]) => {
        Object.entries(getFloors(loc)).forEach(([floorId, floor]) => {
            Object.entries(getGateways(floor)).forEach(([gwId, gw]) => {
                Object.entries(getRooms(gw)).forEach(([roomKeyStr, room]) => {
                    if (!room || typeof room !== 'object' || !room.history) return;
                    needsCleanup = true;
                    Object.values(room.history).forEach(h => {
                        if (h) imported.push({ loc: locId, floor: floorId, gw: gwId, roomNumber: roomNumberFromKey(roomKeyStr), ...h });
                    });
                    updates[`locations/${locId}/${floorId}/${gwId}/${roomKeyStr}/history`] = null;
                });
            });
        });
    });

    if (!needsCleanup) return null;
    saveLocalHistory(loadLocalHistory().concat(imported));
    return db.ref().update(updates);
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
    const hasGateway = !!(currentLoc && currentFloor && currentGw);
    renameGatewayBtn.style.display = hasGateway ? '' : 'none';
    deleteGatewayBtn.style.display = hasGateway ? '' : 'none';
    if (!currentLoc || !currentFloor) { gatewayTabs.innerHTML = ''; return; }
    const gateways = getGateways(locationsData[currentLoc][currentFloor]);
    const ids = Object.keys(gateways);
    gatewayTabs.innerHTML = ids.length === 0
        ? `<span class="gateway-empty">Belum ada gateway di lantai ini. Nyalakan gateway, lalu klasifikasikan dari panel "Gateway Menunggu Klasifikasi".</span>`
        : ids.map(id => `
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

/* ===== MODAL: Ubah Nama Gateway ===== */
/* Gateway baru tidak bisa dibuat manual - hanya lewat "Klasifikasikan Gateway" (panel Gateway Menunggu Klasifikasi),
   supaya setiap node gateway pasti punya gatewayMac dan tersambung ke perangkat sungguhan. */
renameGatewayBtn.addEventListener('click', () => {
    if (!currentLoc || !currentFloor || !currentGw) return;
    gwNameInput.value = currentGw;
    gwMacLabel.textContent = locationsData[currentLoc][currentFloor][currentGw]?.gatewayMac || '-';
    gwModalError.textContent = '';
    gwModalOverlay.classList.add('open');
    gwNameInput.select();
});
document.getElementById('gwModalCancel').addEventListener('click', () => gwModalOverlay.classList.remove('open'));
gwModalOverlay.addEventListener('click', (e) => { if (e.target === gwModalOverlay) gwModalOverlay.classList.remove('open'); });

/* Key gateway = nama yang diketik admin langsung (disanitasi + di-dedup), bukan id auto seperti "Gateway 1" yang terpisah dari field name */
function generateGatewayKey(locId, floorId, name) {
    return nextAvailableKey(locationsData[locId]?.[floorId] || {}, name, [], 'Gateway');
}

/* Key gateway = nama gateway, jadi ganti nama = pindahkan seluruh isi node ke key baru lalu hapus key lama dalam
   satu update atomik. Perangkat gateway ikut pindah sendiri karena mencari node-nya lewat gatewayMac, bukan nama. */
document.getElementById('gwModalSave').addEventListener('click', () => {
    gwModalError.textContent = '';
    const name = sanitizeKeyPart(gwNameInput.value);
    const oldKey = currentGw;
    if (!name || !currentLoc || !currentFloor || !oldKey) { gwModalError.textContent = 'Nama gateway wajib diisi.'; return; }
    if (name === oldKey) { gwModalOverlay.classList.remove('open'); return; }

    const floor = locationsData[currentLoc][currentFloor];
    if (floor[name] !== undefined || FLOOR_META_FIELDS.includes(name)) { gwModalError.textContent = `Nama "${name}" sudah dipakai di lantai ini.`; return; }

    // Timer auto-kunci menyimpan path lama; dihentikan dulu supaya tidak menulis ulang node lama setelah dipindah
    const timerPrefix = `${currentLoc}_${currentFloor}_${oldKey}_`;
    Object.keys(autoLockTimers).forEach(k => {
        if (k.startsWith(timerPrefix)) { clearTimeout(autoLockTimers[k]); delete autoLockTimers[k]; }
    });

    const floorPath = `locations/${currentLoc}/${currentFloor}`;
    db.ref().update({ [`${floorPath}/${name}`]: floor[oldKey], [`${floorPath}/${oldKey}`]: null }).then(() => {
        renameHistoryGateway(currentLoc, currentFloor, oldKey, name);
        currentGw = name;
        gwModalOverlay.classList.remove('open');
    }).catch(err => {
        console.error('Gagal mengubah nama gateway. Cek Realtime Database Rules.', err);
        gwModalError.textContent = err.code === 'PERMISSION_DENIED'
            ? 'Gagal menyimpan: akun Anda tidak punya izin menulis data (bukan admin/belum disetujui).'
            : 'Gagal menyimpan, coba lagi.';
    });
});

deleteGatewayBtn.addEventListener('click', () => {
    if (!currentLoc || !currentFloor || !currentGw) return;
    if (!confirm(`Hapus ${currentGw} beserta semua kamarnya? Tindakan ini tidak bisa dibatalkan.\n\nSelama perangkat gateway masih menyala, gateway ini akan muncul lagi di "Gateway Menunggu Klasifikasi".`)) return;
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

/* ===== STATUS GATEWAY & DOORLOCK (dilaporkan firmware gateway) ===== */
function formatTime(ms) {
    return new Date(ms).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
}

function formatAgo(ms) {
    const sec = Math.max(0, Math.round(ms / 1000));
    if (sec < 60) return `${sec} detik lalu`;
    if (sec < 3600) return `${Math.round(sec / 60)} menit lalu`;
    return `${Math.round(sec / 3600)} jam lalu`;
}

/* state: 'unknown' (firmware belum pernah melapor), 'online', atau 'offline' */
function getGatewayStatus() {
    const st = locationsData[currentLoc]?.[currentFloor]?.[currentGw]?.gatewayStatus;
    if (!st || !st.lastSeen) return { state: 'unknown' };
    const age = Date.now() + serverTimeOffset - st.lastSeen;
    return { ...st, age, state: age < GATEWAY_OFFLINE_MS ? 'online' : 'offline' };
}

function renderGatewayStatusLine() {
    const gs = getGatewayStatus();
    if (gs.state === 'unknown') {
        return `<div class="gs-status unknown"><span class="dot"></span>Gateway belum pernah mengirim status (firmware belum terpasang atau belum tersambung)</div>`;
    }
    if (gs.state === 'offline') {
        return `<div class="gs-status offline"><span class="dot"></span><div><b>Gateway terputus</b> sejak ${formatTime(gs.lastSeen)} (${formatAgo(gs.age)}).
            <div class="gs-status-detail">Kemungkinan jaringan WiFi/internet gateway terputus atau listrik gateway mati. Status doorlock di bawah tidak diperbarui.</div></div></div>`;
    }
    const details = [];
    const dayMs = 24 * 3600 * 1000;
    const now = Date.now() + serverTimeOffset;
    if (gs.lastDisconnectReason && gs.lastReconnectAt && now - gs.lastReconnectAt < dayMs) {
        details.push(`Terakhir terputus ${formatTime(gs.lastReconnectAt - (gs.lastDisconnectSeconds || 0) * 1000)} selama ${gs.lastDisconnectSeconds || 0} detik: ${gs.lastDisconnectReason}`);
    }
    if (gs.lastRestartReason && gs.lastRestartAt && now - gs.lastRestartAt < dayMs) {
        details.push(`Menyala sejak ${formatTime(gs.lastRestartAt)}: ${gs.lastRestartReason}`);
    }
    return `<div class="gs-status online"><span class="dot"></span><div><b>Gateway tersambung</b> · data terakhir ${formatAgo(gs.age)}
        ${details.map(d => `<div class="gs-status-detail">${d}</div>`).join('')}</div></div>`;
}

/* Indikator baterai + koneksi doorlock di kartu kamar */
function renderDeviceStatus(r, gatewayState) {
    const hasData = r.battery !== undefined || r.connection !== undefined;
    if (!hasData) return `<div class="room-device muted">Belum ada data dari doorlock</div>`;

    let battery = '';
    if (typeof r.battery === 'number') {
        const level = r.battery <= BATTERY_LOW ? 'low' : r.battery <= 50 ? 'mid' : 'high';
        battery = `
            <span class="battery ${level}" title="Baterai doorlock ${r.battery}%">
                <span class="battery-body"><span class="battery-fill" style="width:${Math.max(0, Math.min(100, r.battery))}%"></span></span>
                <span class="battery-text">${r.battery === 0 ? 'Habis' : r.battery + '%'}</span>
            </span>`;
    }

    let connection;
    let reason = '';
    if (gatewayState !== 'online') {
        connection = `<span class="badge conn-unknown">Status tidak diketahui</span>`;
        reason = gatewayState === 'offline' ? 'Gateway terputus, status doorlock tidak diperbarui' : '';
    } else if (r.connection === 'connected') {
        connection = `<span class="badge conn-on">Tersambung</span>`;
    } else {
        connection = `<span class="badge conn-off">Terputus</span>`;
        reason = r.connectionReason || 'Penyebab tidak diketahui';
    }

    return `
        <div class="room-device">
            <div class="room-device-row">${battery}${connection}</div>
            ${reason ? `<div class="room-device-reason">${reason}</div>` : ''}
        </div>`;
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
        ${renderGatewayStatusLine()}
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
        const gatewayState = getGatewayStatus().state;
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
                ${renderDeviceStatus(r, gatewayState)}
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
    let allEntries = loadLocalHistory()
        .filter(h => h.loc === currentLoc && h.floor === currentFloor && h.gw === currentGw);

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

/* ===== Riwayat: hanya disimpan di localStorage browser (tidak di Firebase), dibatasi jumlahnya per kamar ===== */
/* Konsekuensinya riwayat hanya terlihat di browser/perangkat yang mencatatnya, dan hilang kalau data situs dihapus. */
function loadLocalHistory() {
    try {
        const parsed = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        return [];
    }
}

function saveLocalHistory(entries) {
    // Trim: simpan maks MAX_HISTORY_PER_ROOM entri terbaru per kamar
    const perRoom = {};
    const trimmed = entries
        .sort((a, b) => b.timestamp - a.timestamp)
        .filter(h => {
            const key = `${h.loc}_${h.floor}_${h.gw}_${h.roomNumber}`;
            perRoom[key] = (perRoom[key] || 0) + 1;
            return perRoom[key] <= MAX_HISTORY_PER_ROOM;
        });
    try {
        localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(trimmed));
    } catch (err) {
        console.error('Gagal menyimpan riwayat ke localStorage.', err);
    }
}

/* Riwayat menyimpan nama gateway, jadi ikut diganti saat gateway diubah namanya (hanya di browser ini) */
function renameHistoryGateway(loc, floor, oldGw, newGw) {
    const entries = loadLocalHistory();
    entries.forEach(h => { if (h.loc === loc && h.floor === floor && h.gw === oldGw) h.gw = newGw; });
    saveLocalHistory(entries);
}

function logHistory(loc, floor, gw, roomNumber, action, by) {
    const entries = loadLocalHistory();
    entries.push({ loc, floor, gw, roomNumber, action, by, timestamp: Date.now() });
    saveLocalHistory(entries);
    renderHistory();
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
        DEVICE_STATUS_FIELDS.forEach(f => { if (existing?.[f] !== undefined) updated[f] = existing[f]; });
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
const classifyFloorSelect = document.getElementById('classifyFloorSelect');
const classifyGwSelect = document.getElementById('classifyGwSelect');
const classifyGwHint = document.getElementById('classifyGwHint');
const classifyRoomNumberInput = document.getElementById('classifyRoomNumberInput');
const classifyError = document.getElementById('classifyError');

let classifyingMac = null;

/* Doorlock hanya bisa dipasang di gateway yang sudah diklasifikasikan (tidak bisa bikin cabang/lantai/gateway baru
   dari sini). Pilihan cabang & lantai hanya yang punya gateway. */
function floorsWithGateways(locId) {
    return Object.keys(getFloors(locationsData[locId])).filter(f => Object.keys(getGateways(locationsData[locId][f])).length > 0);
}

function findGatewayByMac(mac) {
    if (!mac) return null;
    for (const [locId, loc] of Object.entries(locationsData)) {
        for (const [floorId, floor] of Object.entries(getFloors(loc))) {
            for (const [gwId, gw] of Object.entries(getGateways(floor))) {
                if ((gw?.gatewayMac || '').toUpperCase() === mac.toUpperCase()) return { locId, floorId, gwId };
            }
        }
    }
    return null;
}

function openClassifyModal(mac, pairedGatewayMac) {
    classifyingMac = mac;
    classifyMacLabel.textContent = mac;
    classifyError.textContent = '';

    const locIds = Object.keys(locationsData).filter(id => floorsWithGateways(id).length > 0);
    if (locIds.length === 0) {
        alert('Belum ada gateway yang diklasifikasikan. Klasifikasikan gateway dulu dari panel "Gateway Menunggu Klasifikasi".');
        classifyingMac = null;
        return;
    }

    // Default: gateway yang mem-pairing doorlock ini (dari pendingDevices/{mac}/gatewayMac)
    const paired = findGatewayByMac(pairedGatewayMac);
    classifyGwHint.textContent = paired
        ? `Dipairing lewat gateway ${paired.gwId} (${pairedGatewayMac}).`
        : (pairedGatewayMac ? `Dipairing lewat gateway ${pairedGatewayMac} yang belum diklasifikasikan.` : '');

    classifyLocSelect.innerHTML = locIds.map(id => `<option value="${id}">${locationsData[id].name}</option>`).join('');
    classifyLocSelect.value = paired ? paired.locId : (locIds.includes(currentLoc) ? currentLoc : locIds[0]);
    updateClassifyFloorOptions(paired);
    classifyModalOverlay.classList.add('open');
}

function updateClassifyFloorOptions(preselect) {
    const locId = classifyLocSelect.value;
    const floorIds = floorsWithGateways(locId);
    classifyFloorSelect.innerHTML = floorIds.map(id => `<option value="${id}">${id}</option>`).join('');
    classifyFloorSelect.value = preselect?.floorId && floorIds.includes(preselect.floorId) ? preselect.floorId
        : (floorIds.includes(currentFloor) ? currentFloor : floorIds[0]);
    updateClassifyGwOptions(preselect);
}

function updateClassifyGwOptions(preselect) {
    const gwIds = Object.keys(getGateways(locationsData[classifyLocSelect.value]?.[classifyFloorSelect.value]));
    classifyGwSelect.innerHTML = gwIds.map(id => `<option value="${id}">${id}</option>`).join('');
    classifyGwSelect.value = preselect?.gwId && gwIds.includes(preselect.gwId) ? preselect.gwId
        : (gwIds.includes(currentGw) ? currentGw : gwIds[0]);
    updateClassifyRoomOptions();
}

function updateClassifyRoomOptions() {
    const locId = classifyLocSelect.value;
    const floorId = classifyFloorSelect.value;
    const gwId = classifyGwSelect.value;
    const usedNumbers = Object.keys(getRooms(locationsData[locId]?.[floorId]?.[gwId])).map(roomNumberFromKey);

    // Penomoran ikut angka lantai (mis. Lantai 2 -> 201-220)
    const { start, end } = getRoomNumberRange(floorId);
    const available = [];
    for (let i = start; i <= end; i++) {
        if (!usedNumbers.includes(i)) available.push(i);
    }
    classifyRoomNumberInput.innerHTML = available.map(n => `<option value="${n}">Kamar ${n}</option>`).join('');
}

classifyLocSelect.addEventListener('change', () => updateClassifyFloorOptions());
classifyFloorSelect.addEventListener('change', () => updateClassifyGwOptions());
classifyGwSelect.addEventListener('change', updateClassifyRoomOptions);

function closeClassifyModal() {
    classifyModalOverlay.classList.remove('open');
    classifyingMac = null;
}

document.getElementById('classifyModalCancel').addEventListener('click', closeClassifyModal);
classifyModalOverlay.addEventListener('click', (e) => { if (e.target === classifyModalOverlay) closeClassifyModal(); });

document.getElementById('classifyModalSave').addEventListener('click', () => {
    classifyError.textContent = '';

    const locId = classifyLocSelect.value;
    const floorId = classifyFloorSelect.value;
    const gwId = classifyGwSelect.value;
    const roomNumber = parseInt(classifyRoomNumberInput.value);
    const mac = classifyingMac;

    if (!locId || !floorId || !gwId) { classifyError.textContent = 'Pilih gateway.'; return; }
    if (!roomNumber) { classifyError.textContent = 'Pilih nomor kamar.'; return; }

    const roomPath = `locations/${locId}/${floorId}/${gwId}/${roomKey(roomNumber)}`;
    db.ref(roomPath).set({ tenant: '', rfidAccess: true, status: 'locked', doorlockMac: mac }).then(() => {
        logHistory(locId, floorId, gwId, roomNumber, 'classified', currentUserLabel || 'Admin');
        currentLoc = locId;
        currentFloor = floorId;
        currentGw = gwId;
        return db.ref(`pendingDevices/${mac}`).remove();
    }).then(() => {
        closeClassifyModal();
    }).catch(err => {
        console.error('Gagal menyimpan klasifikasi doorlock.', err);
        classifyError.textContent = 'Gagal menyimpan, coba lagi.';
    });
});