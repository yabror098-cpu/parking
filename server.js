const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const DEVICE_KEY = process.env.DEVICE_KEY || "smartparking-kalit-123";
const OFFLINE_AFTER = 15000; // 15 soniya xabar kelmasa -> offline

// ===== Parking tuzilmasi: 3 qavat, 16 joy =====
const FLOOR_SLOTS = { 1: 5, 2: 5, 3: 6 };
const floors = {};
for (const [floor, count] of Object.entries(FLOOR_SLOTS)) {
  floors[floor] = {
    lastSeen: 0,
    online: false,
    rssi: null,
    slots: Array.from({ length: count }, (_, i) => ({
      slot: i + 1,
      value: null,
      occupied: false,
      reserved: false,
    })),
  };
}

// ===== Hodisalar tarixi (oxirgi 100 ta) =====
const events = [];
function addEvent(text) {
  events.unshift({ time: new Date().toISOString(), text });
  if (events.length > 100) events.pop();
  console.log(text);
}

function slotStatus(s) {
  if (s.reserved) return "RESERVED";
  if (s.value === null) return "NO_DATA";
  return s.occupied ? "OCCUPIED" : "FREE";
}

// ===== ESP32 lar ma'lumot yuboradi =====
app.post("/api/update", (req, res) => {
  if (req.get("x-device-key") !== DEVICE_KEY) {
    return res.status(401).json({ error: "Qurilma kaliti noto'g'ri" });
  }

  const { floor, slots, rssi } = req.body || {};
  const f = floors[floor];
  if (!f || !Array.isArray(slots)) {
    return res.status(400).json({ error: "Ma'lumot formati noto'g'ri" });
  }

  f.lastSeen = Date.now();
  f.rssi = rssi ?? null;
  if (!f.online) {
    f.online = true;
    addEvent(`${floor}-qavat ESP32 ulandi`);
  }

  for (const item of slots) {
    const s = f.slots[item.slot - 1];
    if (!s) continue;
    const occupied = !!item.occupied;
    if (s.value !== null && occupied !== s.occupied) {
      addEvent(`${floor}-qavat, ${item.slot}-joy: ${occupied ? "BAND" : "BO'SH"}`);
    }
    s.occupied = occupied;
    s.value = Number.isFinite(item.value) ? item.value : null;
  }

  // Javob: qaysi to'siqlar ko'tarilishi kerak (1 = tepada, 0 = pastda)
  res.json({ barriers: f.slots.map((s) => (s.reserved ? 1 : 0)) });
});

// ===== Dashboard va TFT ekran uchun umumiy holat =====
app.get("/api/status", (req, res) => {
  const result = { total: 0, free: 0, occupied: 0, reserved: 0, floors: {} };

  for (const [floor, f] of Object.entries(floors)) {
    const slots = f.slots.map((s) => ({
      slot: s.slot,
      value: s.value,
      status: slotStatus(s),
    }));
    for (const s of slots) {
      result.total++;
      if (s.status === "FREE") result.free++;
      if (s.status === "OCCUPIED") result.occupied++;
      if (s.status === "RESERVED") result.reserved++;
    }
    result.floors[floor] = { online: f.online, rssi: f.rssi, slots };
  }

  res.json(result);
});

// ===== Hodisalar tarixi =====
app.get("/api/events", (req, res) => {
  res.json(events.slice(0, 30));
});

// ===== Joyni band qilish / bekor qilish =====
app.post("/api/reserve", (req, res) => {
  const { floor, slot, reserve } = req.body || {};
  const f = floors[floor];
  const s = f && f.slots[slot - 1];
  if (!s) return res.status(400).json({ error: "Joy topilmadi" });

  if (reserve) {
    if (s.occupied) {
      return res.status(409).json({ error: "Bu joyda mashina turibdi, band qilib bo'lmaydi" });
    }
    s.reserved = true;
    addEvent(`${floor}-qavat, ${slot}-joy band qilindi (to'siq ko'tariladi)`);
  } else {
    s.reserved = false;
    addEvent(`${floor}-qavat, ${slot}-joy bandi bekor qilindi (to'siq tushadi)`);
  }

  res.json({ ok: true });
});

// ===== Offline qurilmalarni aniqlash =====
setInterval(() => {
  for (const [floor, f] of Object.entries(floors)) {
    if (f.online && Date.now() - f.lastSeen > OFFLINE_AFTER) {
      f.online = false;
      addEvent(`${floor}-qavat ESP32 aloqasi uzildi`);
    }
  }
}, 5000);

app.listen(PORT, () => console.log(`Smart Parking server ishga tushdi: ${PORT}`));
