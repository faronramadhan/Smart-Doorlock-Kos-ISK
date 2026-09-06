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

const MAX_ROOMS = 15;
const MAX_HISTORY_PER_ROOM = 10;   // riwayat disimpan maks 10 terakhir per kamar
const AUTO_LOCK_SECONDS = 5;       // ganti angka ini untuk atur durasi pintu terbuka

let locationsData = {};
let currentLoc = null;
let currentGw = null;
let editingRoomNumber = null;
let currentUserEmail = '';
let autoLockTimers = {}; // menyimpan setTimeout aktif per kamar

/* ===== ELEMEN: AUTH ===== */
const authView = document.getElementById('authView');
const appView = document.getElementById('appView');
const authForm = document.getElementById('authForm');
const authEmail = document.getElementById('authEmail');
const authPassword = document.getElementById('authPassword');
const authError = document.getElementById('authError');
const authSubmit = document.getElementById('authSubmit');
const authTabs = document.querySelectorAll('.auth-tab');
const userEmailEl = document.getElementById('userEmail');
const logoutBtn = document.getElementById('logoutBtn');

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
    const email = authEmail.value.trim();
    const password = authPassword.value;

    const action = authMode === 'login'
        ? auth.signInWithEmailAndPassword(email, password)
        : auth.createUserWithEmailAndPassword(email, password);

    action.catch(err => {
        authError.textContent = terjemahkanErrorFirebase(err.code);
    });
});

logoutBtn.addEventListener('click', () => auth.signOut());

function terjemahkanErrorFirebase(code) {
    const map = {
        'auth/email-already-in-use': 'Email sudah terdaftar, coba masuk.',
        'auth/invalid-email': 'Format email tidak valid.',
        'auth/weak-password': 'Kata sandi minimal 6 karakter.',
        'auth/user-not-found': 'Email belum terdaftar.',
        'auth/wrong-password': 'Kata sandi salah.',
        'auth/invalid-credential': 'Email atau kata sandi salah.'
    };
    return map[code] || 'Terjadi kesalahan, coba lagi.';
}

/* ===== AUTH STATE ===== */
auth.onAuthStateChanged(user => {
    if (user) {
        currentUserEmail = user.email;
        userEmailEl.textContent = user.email;
        authView.style.display = 'none';
        appView.classList.add('visible');
        initAppData();
    } else {
        currentUserEmail = '';
        authView.style.display = 'flex';
        appView.classList.remove('visible');
    }
});

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

document.getElementById('locModalSave').addEventListener('click', () => {
    const name = locNameInput.value.trim();
    const address = locAddressInput.value.trim();
    if (!name) return;

    const newRef = db.ref('locations').push();
    newRef.set({ name, address, gateways: {} }).then(() => {
        currentLoc = newRef.key;
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

document.getElementById('gwModalSave').addEventListener('click', () => {
    const name = gwNameInput.value.trim();
    if (!name || !currentLoc) return;

    const newRef = db.ref(`locations/${currentLoc}/gateways`).push();
    newRef.set({ name, rooms: {} }).then(() => { currentGw = newRef.key; });

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
        logHistory(loc, gw, number, 'unlock', currentUserEmail || 'Admin');

        autoLockTimers[timerKey] = setTimeout(() => {
            db.ref(path).update({ status: 'locked', unlockedAt: null });
            logHistory(loc, gw, number, 'lock', 'Sistem (Auto-kunci)');
            delete autoLockTimers[timerKey];
        }, AUTO_LOCK_SECONDS * 1000);
    } else {
        db.ref(path).update({ status: 'locked', unlockedAt: null });
        logHistory(loc, gw, number, 'lock', currentUserEmail || 'Admin');
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
    logHistory(loc, gw, number, newAccess ? 'rfid_unblock' : 'rfid_block', currentUserEmail || 'Admin');
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