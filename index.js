const express = require("express");
const admin = require("firebase-admin");
const path = "/etc/secrets/smartcollar-c69c1-firebase-adminsdk-fbsvc-9a523750d8.json";
const serviceAccount = require(path);

const app = express();
app.use(express.json());

const NOTIFICATION_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://smartcollar-c69c1-default-rtdb.asia-southeast1.firebasedatabase.app"
});

/**
 * Helper functions
 */
async function shouldSendNotification(uid, petId, alertType) {
  try {
    const lastAlertRef = admin
      .database()
      .ref(`/users/${uid}/pets/${petId}/last_alerts/${alertType}`);
    const lastAlertSnap = await lastAlertRef.once("value");
    const lastAlertTime = lastAlertSnap.val();
    const now = Date.now();

    if (!lastAlertTime || now - lastAlertTime >= NOTIFICATION_COOLDOWN_MS) {
      await lastAlertRef.set(now);
      return true;
    }

    console.log(`Notification for ${alertType} skipped (cooldown)`);
    return false;
  } catch (error) {
    console.error("Error checking notification cooldown:", error);
    return true;
  }
}

async function resetAlertCooldown(uid, petId, alertType) {
  try {
    const lastAlertRef = admin
      .database()
      .ref(`/users/${uid}/pets/${petId}/last_alerts/${alertType}`);
    await lastAlertRef.remove();
    console.log(`Alert cooldown reset for ${alertType}`);
  } catch (error) {
    console.error("Error resetting alert cooldown:", error);
  }
}

async function sendPushNotification(uid, title, body, type = null, petId = null) {
  try {
    const timestamp = Date.now();
    const notifData = { title, message: body, timestamp, type: type || "alert", petId, source: "server" };

    await admin.database().ref(`/users/${uid}/notifications`).push().set(notifData);

    const tokenSnap = await admin.database().ref(`/users/${uid}/deviceToken`).once("value");
    const token = tokenSnap.val();
    if (!token) return;

    const payload = { notification: { title, body } };
    await admin.messaging().sendToDevice(token, payload);

    console.log(`Push notification sent to ${uid}: ${title} - ${body}`);
  } catch (error) {
    console.error("Error sending push notification:", error);
  }
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Threshold & Geofence Checks
 */
async function checkThreshold(uid, petId, type, value) {
  const settingsSnap = await admin.database().ref(`/users/${uid}/pets/${petId}/notification_settings`).once("value");
  const settings = settingsSnap.val();
  if (!settings) return;

  let alert = false;
  let message = "";
  let notifType = null;

  if (type === "bpm" && settings.heartRateAlert) {
    if (value > settings.maxHeartRate) { alert = true; notifType = "hr_high"; message = `Heart rate too high: ${value} bpm (max ${settings.maxHeartRate})`; }
    else if (value < settings.minHeartRate) { alert = true; notifType = "hr_low"; message = `Heart rate too low: ${value} bpm (min ${settings.minHeartRate})`; }
    else { await resetAlertCooldown(uid, petId, "hr_high"); await resetAlertCooldown(uid, petId, "hr_low"); }
  }

  if (type === "temperature" && settings.tempAlert) {
    if (value > settings.maxTemp) { alert = true; notifType = "temp_high"; message = `Temperature too high: ${value}°C (max ${settings.maxTemp}°C)`; }
    else if (value < settings.minTemp) { alert = true; notifType = "temp_low"; message = `Temperature too low: ${value}°C (min ${settings.minTemp}°C)`; }
    else { await resetAlertCooldown(uid, petId, "temp_high"); await resetAlertCooldown(uid, petId, "temp_low"); }
  }

  if (alert) {
    const shouldSend = await shouldSendNotification(uid, petId, notifType);
    if (shouldSend) await sendPushNotification(uid, `SmartCollar Alert: ${type}`, message, notifType, petId);
  }
}

async function checkGeofence(uid, petId, latitude, longitude) {
  const geoSnap = await admin.database().ref(`/users/${uid}/pets/${petId}/geofence`).once("value");
  const geofence = geoSnap.val();
  if (!geofence) return;

  const distance = haversineDistance(latitude, longitude, geofence.latitude, geofence.longitude);
  if (distance > geofence.radius) {
    const shouldSend = await shouldSendNotification(uid, petId, "geofence");
    if (shouldSend) await sendPushNotification(uid, "SmartCollar Alert: Geofence", `Your pet has left the safe zone! Distance: ${Math.round(distance)}m`, "geofence", petId);
  } else {
    await resetAlertCooldown(uid, petId, "geofence");
  }
}

/**
 * Express endpoints
 */
app.get('/', (req, res) => res.send('SmartCollar API is running ✅'));

app.get('/testDB', async (req, res) => {
  try {
    const testRef = admin.database().ref('/users');
    const snapshot = await testRef.once('value');
    if (!snapshot.exists()) return res.status(404).json({ message: 'No data found at /users' });
    res.status(200).json(snapshot.val());
  } catch (error) {
    console.error('Error fetching data:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/testNotif', async (req, res) => {
  try {
    const { uid, petId } = req.query;
    if (!uid || !petId) return res.status(400).json({ error: 'Missing uid or petId' });

    const notifSettingRef = admin.database().ref(`users/${uid}/pets/${petId}/notification_settings`);
    const snapshot = await notifSettingRef.once('value');
    if (!snapshot.exists()) return res.status(404).json({ error: 'No notification settings found' });

    res.status(200).json(snapshot.val());
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.post("/bpm", async (req, res) => {
  const { uid, petId, value } = req.body;
  await checkThreshold(uid, petId, "bpm", value);
  res.json({ status: "ok" });
});

app.post("/temperature", async (req, res) => {
  const { uid, petId, value } = req.body;
  await checkThreshold(uid, petId, "temperature", value);
  res.json({ status: "ok" });
});

app.post("/location", async (req, res) => {
  const { uid, petId, latitude, longitude } = req.body;
  await checkGeofence(uid, petId, latitude, longitude);
  res.json({ status: "ok" });
});

/**
 * Automatic Firebase listeners
 */
const db = admin.database();
const collarDataRef = db.ref("/users");

collarDataRef.on("child_added", (userSnap) => {
  const uid = userSnap.key;

  userSnap.child("pets").forEach((petSnap) => {
    const petId = petSnap.key;
    const collarRef = db.ref(`/users/${uid}/pets/${petId}/collar_data`);

    // BPM listener
    collarRef.child("bpm").on("value", (snapshot) => {
      const value = snapshot.val();
      if (value) {
        console.log(`📡 BPM update detected for ${uid}/${petId}: ${value}`);
        checkThreshold(uid, petId, "bpm", value);
      }
    });

    // Temperature listener
    collarRef.child("temperature").on("value", (snapshot) => {
      const value = snapshot.val();
      if (value) {
        console.log(`🌡️ Temp update detected for ${uid}/${petId}: ${value}`);
        checkThreshold(uid, petId, "temperature", value);
      }
    });

    // Location listener
    collarRef.child("location").on("value", (snapshot) => {
      const loc = snapshot.val();
      if (loc && loc.latitude && loc.longitude) {
        console.log(`📍 Location update for ${uid}/${petId}:`, loc);
        checkGeofence(uid, petId, loc.latitude, loc.longitude);
      }
    });
  });
});

/**
 * Start server
 */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
