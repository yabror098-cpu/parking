const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const DEVICE_KEY = process.env.DEVICE_KEY || "smartparking-kalit-123";
const OFFLINE_AFTER = 15000;          // 15 soniya xabar kelmasa -> offline
const RESERVE_OPTIONS = [10, 15, 20]; // Band qilish vaqtlari (daqiqa)
const MAX_EXTEND = 5;                 // Eng ko'pi bilan qo'shiladigan vaqt (daqiqa)
const EXTEND_WINDOW = 60;             // Oxirgi necha soniyada vaqt qo'shish mumkin

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
      reservedUntil: 0,
      extended: false,
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

// ===== Yordamchi funksiyalar =====
function getSlot(floor, slot) {
  const f = floors[floor];
  const s = f && f.slots[slot - 1];
  return { f, s };
}

function remainingSec(s) {
  if (!s.reserved) return 0;
  return Math.max(0, Math.ceil((s.reservedUntil - Date.now()) / 1000));
}

function slotStatus(s) {
  if (s.reserved) return "RESERVED";
  if (s.value === null) return "NO_DATA";
  return s.occupied ? "OCCUPIED" : "FREE";
}

function endReservation(floor, s, reason) {
  s.reserved = false;
  s.reservedUntil = 0;
  s.extended = false;
  addEvent(`${floor}-qavat, ${s.slot}-joy: ${reason}`);
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

  // Javob: qaysi to'siqlar tepada bo'lishi kerak (1 = tepada, 0 = pastda)
  res.json({ barriers: f.slots.map((s) => (s.reserved ? 1 : 0)) });
});

// ===== Dashboard va TFT ekran uchun umumiy holat =====
app.get("/api/status", (req, res) => {
  const result = { total: 0, free: 0, occupied: 0, reserved: 0, floors: {} };

  for (const [floor, f] of Object.entries(floors)) {
    const slots = f.slots.map((s) => {
      const remaining = remainingSec(s);
      return {
        slot: s.slot,
        value: s.value,
        status: slotStatus(s),
        remaining,
        extended: s.extended,
        canExtend: s.reserved && !s.extended && remaining <= EXTEND_WINDOW,
      };
    });
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

// ===== 1. Band qilish (10 / 15 / 20 daqiqa) =====
app.post("/api/reserve", (req, res) => {
  const { floor, slot, minutes } = req.body || {};
  const { f, s } = getSlot(floor, slot);
  if (!s) return res.status(400).json({ error: "Joy topilmadi" });
  if (!RESERVE_OPTIONS.includes(minutes)) {
    return res.status(400).json({ error: "Vaqt 10, 15 yoki 20 daqiqa bo'lishi kerak" });
  }
  if (!f.online) {
    return res.status(409).json({ error: "Bu qavat ESP32 si offline, to'siqni ko'tarib bo'lmaydi" });
  }
  if (s.reserved) return res.status(409).json({ error: "Bu joy allaqachon band qilingan" });
  if (s.occupied) return res.status(409).json({ error: "Bu joyda mashina turibdi" });

  s.reserved = true;
  s.reservedUntil = Date.now() + minutes * 60000;
  s.extended = false;
  addEvent(`${floor}-qavat, ${slot}-joy ${minutes} daqiqaga band qilindi (to'siq ko'tarildi)`);
  res.json({ ok: true });
});

// ===== 2. Vaqt qo'shish (oxirgi 1 daqiqada, 1-5 daqiqa, bir marta) =====
app.post("/api/extend", (req, res) => {
  const { floor, slot, minutes } = req.body || {};
  const { s } = getSlot(floor, slot);
  if (!s) return res.status(400).json({ error: "Joy topilmadi" });
  if (!s.reserved) return res.status(409).json({ error: "Bu joy band qilinmagan" });
  if (s.extended) return res.status(409).json({ error: "Vaqt faqat bir marta qo'shiladi" });
  if (remainingSec(s) > EXTEND_WINDOW) {
    return res.status(409).json({ error: "Vaqt qo'shish faqat oxirgi 1 daqiqada mumkin" });
  }
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_EXTEND) {
    return res.status(400).json({ error: `1 dan ${MAX_EXTEND} daqiqagacha qo'shish mumkin` });
  }

  s.reservedUntil += minutes * 60000;
  s.extended = true;
  addEvent(`${floor}-qavat, ${slot}-joy: ${minutes} daqiqa vaqt qo'shildi`);
  res.json({ ok: true });
});

// ===== 3. Keldim (to'siq tushadi) =====
app.post("/api/arrive", (req, res) => {
  const { floor, slot } = req.body || {};
  const { s } = getSlot(floor, slot);
  if (!s) return res.status(400).json({ error: "Joy topilmadi" });
  if (!s.reserved) return res.status(409).json({ error: "Bu joy band qilinmagan" });

  endReservation(floor, s, "haydovchi yetib keldi (to'siq tushirildi)");
  res.json({ ok: true });
});

// ===== Har soniyada: muddati tugagan bandlar va offline qurilmalar =====
setInterval(() => {
  const now = Date.now();
  for (const [floor, f] of Object.entries(floors)) {
    if (f.online && now - f.lastSeen > OFFLINE_AFTER) {
      f.online = false;
      addEvent(`${floor}-qavat ESP32 aloqasi uzildi`);
    }
    for (const s of f.slots) {
      if (s.reserved && now >= s.reservedUntil) {
        endReservation(floor, s, "band qilish muddati tugadi (to'siq tushirildi)");
      }
    }
  }
}, 1000);

app.listen(PORT, () => console.log(`Smart Parking server ishga tushdi: ${PORT}`));
